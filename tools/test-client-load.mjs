/**
 * Load the generated browser bundle the way DSH's shell does, in plain Node,
 * with a stubbed `window`/`document`/`react`.
 *
 * This catches the failures that only appear at load time — a factory that
 * throws, a component that resolves to `undefined` because the concatenation
 * order broke, a slot registration shaped wrongly — without having to install
 * the plugin and restart DSH to find them.
 *
 * Usage: node tools/test-client-load.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-client-load
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUNDLE = join(ROOT, 'lib', 'client.bundle.js');

// ------------------------------------------------------------ fake browser ==

/** Minimal React stand-in: builds inspectable element trees, no rendering. */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
  useMemo(fn) {
    return fn();
  },
  useRef(value) {
    return { current: value };
  },
};

/** Every string in a rendered tree. */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) textOf(child, out);
  }
  return out;
}

/** Every HTML tag used in a rendered tree. */
function tagsOf(node, out = new Set()) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) tagsOf(child, out);
    return out;
  }
  if (typeof node.type === 'string') out.add(node.type);
  if (Array.isArray(node.children)) for (const child of node.children) tagsOf(child, out);
  return out;
}

const styleNodes = [];
const fakeDocument = {
  head: {
    append(node) {
      styleNodes.push(node);
    },
  },
  getElementById(id) {
    return styleNodes.find((node) => node.id === id) ?? null;
  },
  createElement() {
    return { id: '', textContent: '' };
  },
};

let loaded = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(spec) {
      loaded = spec;
    },
  },
  addEventListener() {},
  removeEventListener() {},
};

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;
globalThis.fetch = () =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ notes: [], settings: {} }) });

// ------------------------------------------------------------------ load ==

const source = readFileSync(BUNDLE, 'utf8');
// Run the bundle as a classic script, exactly as the shell does.
new Function('window', 'document', 'fetch', 'console', source)(fakeWindow, fakeDocument, globalThis.fetch, console);

assert.ok(loaded !== null, 'bundle 没有调用 window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-sticky-notes-desktop', 'bundle id 必须等于包名');

const module = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`意外的 require: ${name}`);
});

assert.equal(typeof module.apply, 'function', 'factory 必须返回带 apply 的模块');
assert.ok(Array.isArray(module.inject), 'inject 必须是数组');

// `NS.React` is stamped by the factory, so this also proves the factory ran
// before `apply` — the ordering DSH's shell guarantees.
const NS = globalThis.__dshSticky;
assert.ok(NS !== undefined, 'bundle 必须建立 globalThis.__dshSticky 命名空间');
assert.ok(NS.React !== undefined, 'bundle factory 必须先于 apply 运行并写入 NS.React');
for (const key of ['NotesPanel', 'PanelIcon', 'StickySettingsSection', 'panelStyles', 'settingsStyles', 'acceleratorFromEvent']) {
  assert.ok(NS[key] !== undefined, `命名空间必须导出 ${key}（说明 bundle 拼接顺序正确）`);
}

// ------------------------------------------------------- fake cordis context ==

const registrations = [];
const effects = [];
const dictionaryCalls = [];

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  get(name) {
    if (name === 'locale') {
      return { getSnapshot: () => ({ active: 'zh' }), bind: () => (key) => key };
    }
    return undefined;
  },
  effect(callback, label) {
    effects.push(label);
    const disposer = callback();
    assert.equal(typeof disposer, 'function', `effect「${label}」必须返回 disposer`);
    return disposer;
  },
  locale: {
    register(ns, dicts) {
      dictionaryCalls.push({ ns, dicts });
      assert.ok(dicts.zh && dicts.en, '必须同时提供 zh 与 en 字典');
      assert.deepEqual(
        Object.keys(dicts.en).sort(),
        Object.keys(dicts.zh).sort(),
        'zh 与 en 字典的键必须完全一致',
      );
      return () => {};
    },
  },
  slots: {
    inject(slotName, callback) {
      // Route `ctx.slots` to a proxy for the slot being injected, mirroring how
      // the real registry is bound to one slot key.
      const saved = ctx.slots;
      ctx.slots = {
        inject(name, inner) {
          assert.equal(name, slotName, 'slots.inject 的名字必须与 register 的名字一致');
          return inner();
        },
        register(descriptor, component) {
          registrations.push({ slot: descriptor.name, descriptor, component });
          return () => {};
        },
      };
      try {
        return callback();
      } finally {
        ctx.slots = saved;
      }
    },
    register() {
      throw new Error('slots.register 只应在 inject 回调内被调用');
    },
  },
};

module.apply(ctx);

// ------------------------------------------------------------------ assert ==

const bySlot = new Map();
for (const entry of registrations) {
  if (!bySlot.has(entry.slot)) bySlot.set(entry.slot, []);
  bySlot.get(entry.slot).push(entry);
}

for (const slot of ['main', 'sidebar.panellist', 'settings.section']) {
  assert.ok(bySlot.has(slot), `必须注册到槽位 ${slot}`);
}
assert.equal(registrations.length, 3, `应当只注册 3 个槽位，实际 ${registrations.length} 个`);

const props = { t: (key) => key, locale: 'zh', state: {}, ctx };

for (const entry of registrations) {
  assert.equal(typeof entry.component, 'function', `${entry.slot} 的组件必须是函数`);
  const tree = entry.component(props);
  assert.ok(tree !== undefined && tree !== null, `${entry.slot} 的组件返回了空值`);
}

/**
 * A registration's component may be either a plain component or a thin wrapper
 * that renders one (that is how `client.js` binds the namespace components).
 * Render until we reach a host element, which is what the owner will mount.
 */
function renderToHost(component, limit = 6) {
  let node = component(props);
  for (let depth = 0; depth < limit; depth += 1) {
    if (node === null || node === undefined) return null;
    if (typeof node.type === 'string') return node;
    if (typeof node.type === 'function') {
      node = node.type(node.props);
      continue;
    }
    return null;
  }
  return null;
}

// The settings page mounts against a pending request, so its first render is
// legitimately the loading state; what matters is that it reaches a real host
// element carrying our settings class.
const settingsHost = renderToHost(bySlot.get('settings.section')[0].component);
assert.ok(settingsHost !== null, '设置页必须渲染到宿主元素');
assert.equal(settingsHost.type, 'div', `设置页根节点必须是 div，实际 ${String(settingsHost.type)}`);
assert.equal(
  settingsHost.props.className,
  'dsn-set',
  `设置页根节点 class 应为 dsn-set，实际 ${String(settingsHost.props.className)}`,
);

// The panel's own chrome renders regardless of the fetch, so its header
// controls must already be present on the first frame.
const panelHost = renderToHost(bySlot.get('main')[0].component);
assert.ok(panelHost !== null, '便签面板必须渲染到宿主元素');
assert.equal(panelHost.type, 'div', '便签面板根节点必须是 div');
assert.equal(panelHost.props.className, 'dsn-panel', '便签面板根节点 class 应为 dsn-panel');
const panelText = textOf(panelHost).join('|');
// `panel.title` is no longer a heading: the panel opens with two tabs (便签 / 便签闹钟), so the
// notes-side controls must still be on the first frame, now alongside the tab strip.
for (const key of ['panel.tabNotes', 'panel.tabAlarms', 'panel.newNote', 'panel.screenshot']) {
  assert.ok(panelText.includes(key), `便签面板首帧应当包含 ${key}`);
}
assert.ok(tagsOf(panelHost).has('button'), '便签面板应当渲染按钮');

// The rail entry's label must be a function so the owner re-reads the locale on
// every projection, and it must resolve to a non-empty string right now.
const rail = bySlot.get('sidebar.panellist')[0];
assert.equal(typeof rail.descriptor.label, 'function', '侧栏入口的 label 必须是函数');
assert.ok(typeof rail.descriptor.label() === 'string' && rail.descriptor.label().length > 0, 'label 必须非空');
assert.equal(rail.descriptor.id, NS.PANEL_ID, '侧栏入口 id 必须与 main 面板的 key 一致');

// The sidebar and settings labels must be the SHORT names, with no package name in them.
//
// This is inverted from what it once asserted, and the inversion is the point: the bracketed
// package name belongs only to the plugin-list card, where several plugins sit side by side and
// the user has to tell them apart. Inside this plugin it is noise. A regex rather than an equality
// check so the assertion states the *rule* — no brackets — instead of a spelling that a future
// rename would have to be chased through.
const railLabel = rail.descriptor.label();
assert.ok(typeof railLabel === 'string' && railLabel.length > 0, '侧栏名称必须非空');
assert.ok(
  !railLabel.includes('（') && !railLabel.includes('('),
  `侧栏名称不带括号，实际「${railLabel}」`,
);
assert.ok(
  !railLabel.includes(NS.PACKAGE),
  `侧栏名称不该带包名，实际「${railLabel}」`,
);
assert.equal(railLabel, '便签', `侧栏名称应当是「便签」，实际「${railLabel}」`);

const settingsLabel = bySlot.get('settings.section')[0].descriptor.label();
assert.ok(typeof settingsLabel === 'string' && settingsLabel.length > 0, '设置页名称必须非空');
assert.ok(
  !settingsLabel.includes('（') && !settingsLabel.includes('('),
  `设置页名称不带括号，实际「${settingsLabel}」`,
);
assert.equal(settingsLabel, '便签设置', `设置页名称应当是「便签设置」，实际「${settingsLabel}」`);

// The plugin-list card is the ONE place the package name appears — and it has to be a literal,
// because DSH reads this JSON to render the card before any plugin code runs.
const localeZh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'));
assert.equal(
  localeZh.meta.title,
  `便签（${NS.PACKAGE}）`,
  `插件列表卡片必须带上包名，实际「${localeZh.meta.title}」`,
);
const localeEn = JSON.parse(readFileSync(join(ROOT, 'locale', 'en.json'), 'utf8'));
assert.ok(
  localeEn.meta.title.includes(NS.PACKAGE),
  `locale/en.json 的标题必须带上包名，实际「${localeEn.meta.title}」`,
);

const main = bySlot.get('main')[0];
assert.equal(main.descriptor.key, rail.descriptor.id, 'main 的 key 必须等于侧栏入口的 id');
assert.equal(bySlot.get('settings.section')[0].descriptor.id, NS.SETTINGS_ID);

assert.equal(dictionaryCalls.length, 1, '应当注册一次语言包');
assert.equal(dictionaryCalls[0].ns, 'sticky-notes');
assert.ok(styleNodes.length > 0, '必须注入样式');
assert.ok(styleNodes[0].textContent.length > 500, '样式内容看起来过短');

// ------------------------------------------------ pure helper behaviour ==

const key = (over) => Object.assign({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false }, over);
assert.equal(NS.acceleratorFromEvent(key({ key: 'n', ctrlKey: true, shiftKey: true })), 'CommandOrControl+Shift+N');
assert.equal(NS.acceleratorFromEvent(key({ key: 'F5', ctrlKey: true })), 'CommandOrControl+F5');
assert.equal(NS.acceleratorFromEvent(key({ key: 'ArrowUp', altKey: true })), 'Alt+Up');
assert.equal(NS.acceleratorFromEvent(key({ key: ' ', ctrlKey: true })), 'CommandOrControl+Space');
assert.equal(NS.acceleratorFromEvent(key({ key: 'n' })), null, '裸键必须被拒绝（会吞掉整个键盘）');
assert.equal(NS.acceleratorFromEvent(key({ key: 'Control', ctrlKey: true })), null, '单独的修饰键必须被拒绝');

assert.equal(NS.withAlpha('#fff3b0', 1), 'rgba(255,243,176,1)');
assert.equal(NS.withAlpha('#abc', 0.5), 'rgba(170,187,204,0.5)');
assert.ok(NS.withAlpha('garbage', 0.5).startsWith('rgba(255, 243, 176'), '非法颜色必须回落到默认色');

assert.equal(NS.previewOf({ title: '', text: '' }), '');
assert.equal(NS.previewOf({ title: '', text: '\n\n  real line  \n' }), 'real line');
assert.equal(NS.previewOf(null), '');

// Regression: the footer rendered `快捷键: [object Object]` in a real browser
// because the host reports the hotkey registration *outcome* on one path and the
// accelerator string on another. Both must print a real accelerator.
assert.equal(NS.hotkeyText('CommandOrControl+Shift+N'), 'CommandOrControl+Shift+N');
assert.equal(NS.hotkeyText({ ok: true, hotkey: 'CommandOrControl+Shift+N' }), 'CommandOrControl+Shift+N');
assert.equal(NS.hotkeyText({ ok: false, error: 'taken' }), '', '注册失败时不应编造快捷键');
assert.equal(NS.hotkeyText(null), '');
assert.equal(NS.hotkeyText(undefined), '');
assert.ok(!NS.hotkeyText({ ok: true, hotkey: 'X' }).includes('object'), '绝不能渲染 [object Object]');

// One prettifier for both surfaces, so the panel footer and the settings page can
// never show the same accelerator two different ways.
assert.equal(NS.prettyHotkey('CommandOrControl+Alt+S'), 'Ctrl + Alt + S');
assert.equal(NS.prettyHotkey({ ok: true, hotkey: 'CommandOrControl+Alt+S' }), 'Ctrl + Alt + S');
assert.equal(NS.prettyHotkey('Command+Shift+N'), 'Cmd + Shift + N');
assert.equal(NS.prettyHotkey(''), '');
assert.equal(NS.prettyHotkey(null), '');

console.log('client bundle 加载测试通过');
console.log(`  注册槽位：${[...bySlot.keys()].join(', ')}`);
console.log(`  effect 标签：${effects.join(' | ')}`);
console.log(`  注入样式节点：${styleNodes.length}`);
console.log('  快捷键捕获 / 颜色 / 预览辅助函数断言全部通过');

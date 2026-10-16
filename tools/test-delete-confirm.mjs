/**
 * Verify that deleting a note from the sidebar takes two clicks, not one.
 *
 * ## Why this needs its own harness
 *
 * `test-client-load.mjs` stubs React with hooks that ignore state, which is all a load-time check
 * needs. Deleting a note is different: the behaviour *is* a state transition — the first click arms
 * the row, the second deletes, and the arming lapses on a timer. A stub that discards state would
 * report success no matter what the component did.
 *
 * So this harness implements `useState`/`useRef`/`useEffect`/`useCallback` for real and re-renders on
 * demand. Two design points that are easy to get wrong, and were:
 *
 *  - **A render must not recurse into itself.** Hooks address their state by call order within a
 *    render, so the hook table has to survive across renders while the cursor resets per render. An
 *    earlier version called `render()` from inside `setState`, which re-entered the component
 *    mid-render and looped forever.
 *  - **Nothing re-renders implicitly.** A real React schedules a render; here the test asks for one
 *    with `flush()`, so the sequence of clicks and renders is explicit and a missing render shows up
 *    as a failed assertion rather than a hang.
 *
 * Only `fetch` is stubbed, so the assertions are about what the UI actually *sent* — the thing that
 * really deletes a note.
 *
 * Usage: node tools/test-delete-confirm.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-delete-confirm
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ---------------------------------------------------------------------------------------------
// React with working state.
// ---------------------------------------------------------------------------------------------

/** Hook storage, surviving across renders; `cursor` walks it within one render. */
let hookTable = [];
let cursor = 0;
let needsRender = false;
const timers = [];

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== false && c !== undefined),
    };
  },
  Fragment: 'Fragment',
  useState(initial) {
    const index = cursor;
    cursor += 1;
    if (hookTable[index] === undefined) hookTable[index] = { value: typeof initial === 'function' ? initial() : initial };
    const cell = hookTable[index];
    const set = (next) => {
      cell.value = typeof next === 'function' ? next(cell.value) : next;
      needsRender = true;
    };
    return [cell.value, set];
  },
  useRef(initial) {
    const index = cursor;
    cursor += 1;
    if (hookTable[index] === undefined) hookTable[index] = { value: { current: initial } };
    return hookTable[index].value;
  },
  useCallback(fn) {
    const index = cursor;
    cursor += 1;
    if (hookTable[index] === undefined) hookTable[index] = { value: fn };
    return hookTable[index].value;
  },
  useEffect(fn) {
    const index = cursor;
    cursor += 1;
    // Effects run after the render, as in React; the teardown is kept for the unmount check.
    const first = hookTable[index] === undefined;
    hookTable[index] = { value: true };
    if (first) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  },
  useMemo(fn) {
    cursor += 1;
    return fn();
  },
};
const cleanups = [];

// ---------------------------------------------------------------------------------------------
// A DOM just real enough for the bundle to load.
// ---------------------------------------------------------------------------------------------

const makeElement = (tag) => ({
  tagName: String(tag).toUpperCase(),
  style: { setProperty() {}, removeProperty() {} },
  dataset: {},
  children: [],
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {},
  removeAttribute() {},
  appendChild(child) {
    this.children.push(child);
    return child;
  },
  insertBefore(child) {
    this.children.push(child);
    return child;
  },
  removeChild() {},
  addEventListener() {},
  removeEventListener() {},
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  focus() {},
  blur() {},
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
});

const documentStub = {
  head: makeElement('head'),
  body: makeElement('body'),
  documentElement: makeElement('html'),
  createElement: makeElement,
  createTextNode: (text) => ({ textContent: String(text), nodeType: 3 }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

// ---------------------------------------------------------------------------------------------
// Record every request the component makes.
// ---------------------------------------------------------------------------------------------

const requests = [];
let noteList = [{ id: 'n1', text: '第一条便签', kind: 'text', pinned: false }];
let alarmList = [
  { id: 'a1', label: '喝水', kind: 'text', text: '该喝水了', enabled: true, schedule: { kind: 'daily', time: '09:30' }, scheduleText: '每天 09:30', nextAt: null, ringing: false },
];

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

globalThis.fetch = async (url, options = {}) => {
  const method = (options.method ?? 'GET').toUpperCase();
  requests.push({ method, url: String(url) });
  if (method === 'DELETE') {
    const id = new URL(String(url), 'http://x').searchParams.get('id');
    if (String(url).includes('/alarms')) alarmList = alarmList.filter((a) => a.id !== id);
    else noteList = noteList.filter((n) => n.id !== id);
    return jsonResponse({ ok: true });
  }
  return jsonResponse({
    notes: noteList,
    alarms: alarmList,
    settings: {
      hotkey: 'CommandOrControl+Alt+S',
      backgroundColor: '#111111',
      opacity: 0.8,
      textColor: '#ffffff',
      fontSize: 14,
    },
    helper: { running: true, responsive: true, state: 'running' },
  });
};

// ---------------------------------------------------------------------------------------------
// Load the real bundle.
// ---------------------------------------------------------------------------------------------

const sandbox = {
  document: documentStub,
  React,
  console,
  // Timers are recorded, never fired on their own: the test decides when time passes.
  setTimeout: (fn, ms) => {
    const handle = { fn, ms, cancelled: false };
    timers.push(handle);
    return handle;
  },
  clearTimeout: (handle) => {
    if (handle && typeof handle === 'object') handle.cancelled = true;
  },
  setInterval: () => 0,
  clearInterval: () => {},
  fetch: globalThis.fetch,
  URL,
  URLSearchParams,
  encodeURIComponent,
  JSON,
  Math,
  Date,
  Promise,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  Set,
  Map,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.__ModuleLoader__ = {
  load({ factory }) {
    factory((name) => {
      if (name === 'react') return React;
      throw new Error(`unexpected require(${name})`);
    });
  },
};

const bundle = readFileSync(join(ROOT, 'lib', 'client.bundle.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(bundle, sandbox, { filename: 'client.bundle.js' });

const NS = sandbox.__dshSticky;
assert.ok(NS !== undefined, 'bundle 必须建立 __dshSticky 命名空间');

const component = NS.NotesPanel;
assert.ok(typeof component === 'function', '面板组件 NS.NotesPanel 必须存在');

// ---------------------------------------------------------------------------------------------
// Render on demand.
// ---------------------------------------------------------------------------------------------

let tree = null;

/** Render the component once, resetting the per-render hook cursor. */
function renderOnce() {
  cursor = 0;
  cleanups.length = 0;
  needsRender = false;
  tree = component({ t: (key) => key });
  return tree;
}

/** Render, then keep rendering while state changed — the way React settles. */
async function flush(rounds = 4) {
  renderOnce();
  for (let i = 0; i < rounds; i += 1) {
    // Let any in-flight `/state` fetch resolve before deciding whether another render is needed.
    await new Promise((resolve) => setImmediate(resolve));
    if (!needsRender) break;
    renderOnce();
  }
  return tree;
}

/** Depth-first search for elements whose className contains `needle`. */
function findAll(node, needle, out = []) {
  if (node === null || typeof node !== 'object') return out;
  const className = node.props?.className;
  if (typeof className === 'string' && className.includes(needle)) out.push(node);
  for (const child of node.children ?? []) findAll(child, needle, out);
  return out;
}

/** The delete button as it currently renders, plus what it would report to the user. */
function readDeleteButton() {
  const buttons = findAll(tree, 'dsn-btn danger');
  assert.equal(buttons.length, 1, `应当只有 1 个删除按钮，实际 ${buttons.length}`);
  const button = buttons[0];
  const label = button.children.map((c) => (typeof c === 'string' ? c : (c?.children?.join('') ?? ''))).join('');
  return { button, label, armed: String(button.props.className).includes('confirming'), title: button.props.title };
}

/** Click the delete button and settle the resulting render. */
async function clickDelete() {
  const { button } = readDeleteButton();
  button.props.onClick();
  await flush();
}

const deleteCalls = () => requests.filter((r) => r.method === 'DELETE');
const reset = () => {
  requests.length = 0;
  timers.length = 0;
};

const failures = [];
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error.message}`);
    failures.push(label);
  }
};

// ---------------------------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------------------------

console.log('=== 初始状态 ===');
await flush();
await check('删除按钮显示「删除」，未进入确认态', () => {
  const { label, armed } = readDeleteButton();
  assert.equal(label, 'panel.delete', `应显示 panel.delete，实际 ${label}`);
  assert.equal(armed, false, '初始不应是 confirming 状态');
});

console.log('\n=== 第一次点击：只进入确认态 ===');
reset();
await clickDelete();
await check('第一次点击没有发出任何 DELETE 请求', () => {
  assert.equal(deleteCalls().length, 0, `不应删除，实际发了 ${deleteCalls().length} 次`);
});
await check('按钮改为「确认删除」并进入 confirming 态', () => {
  const { label, armed } = readDeleteButton();
  assert.equal(label, 'panel.deleteConfirm', `应显示 panel.deleteConfirm，实际 ${label}`);
  assert.equal(armed, true, '第一次点击后应进入 confirming 状态');
});
await check('按钮提示文案换成警告，说明不可撤销', () => {
  const { title } = readDeleteButton();
  assert.equal(title, 'panel.deleteConfirmHint', `提示应为 panel.deleteConfirmHint，实际 ${title}`);
});

console.log('\n=== 第二次点击：真正删除 ===');
reset();
await clickDelete();
await check('第二次点击发出了 DELETE 请求', () => {
  assert.equal(deleteCalls().length, 1, `应恰好删除一次，实际 ${deleteCalls().length} 次`);
});
await check('DELETE 请求带上正确的便签 id', () => {
  const call = deleteCalls()[0];
  assert.ok(call.url.includes('id=n1'), `URL 应包含 id=n1，实际 ${call.url}`);
});

console.log('\n=== 超时自动解除确认态 ===');
{
  // Fresh note, fresh hook table: the previous note is gone.
  hookTable = [];
  noteList = [{ id: 'n2', text: '第二条', kind: 'text', pinned: false }];
  reset();
  await flush();
  await clickDelete();
}
await check('已进入确认态', () => {
  assert.equal(readDeleteButton().armed, true, '第一次点击后应进入确认态');
});
await check('设置了一个 3000ms 的解除定时器', () => {
  const armed = timers.filter((x) => !x.cancelled && x.ms === 3000);
  assert.ok(armed.length > 0, `应有一个 3000ms 定时器，实际定时器：${timers.map((t) => t.ms).join(',')}`);
});
{
  // Let the arming lapse, as the real clock would.
  const armTimer = timers.filter((x) => !x.cancelled && x.ms === 3000).pop();
  armTimer.fn();
  await flush();
}
await check('超时后回到「删除」，不再是确认态', () => {
  const { label, armed } = readDeleteButton();
  assert.equal(armed, false, '超时后不应仍是 confirming 状态');
  assert.equal(label, 'panel.delete', `超时后应显示 panel.delete，实际 ${label}`);
});
await check('仅超时不会删除任何东西', () => {
  assert.equal(deleteCalls().length, 0, '超时不应触发删除');
});

console.log('\n=== 先点 A 再点 B：不应误删 B ===');
{
  hookTable = [];
  noteList = [
    { id: 'a', text: 'A', kind: 'text', pinned: false },
    { id: 'b', text: 'B', kind: 'text', pinned: false },
  ];
  reset();
  await flush();
}
{
  const buttons = findAll(tree, 'dsn-btn danger');
  assert.equal(buttons.length, 2, `应有 2 个删除按钮，实际 ${buttons.length}`);
  buttons[0].props.onClick(); // arm A
  await flush();
}
{
  const buttons = findAll(tree, 'dsn-btn danger');
  const armedCount = buttons.filter((b) => String(b.props.className).includes('confirming')).length;
  assert.equal(armedCount, 1, `应恰好 1 行处于确认态，实际 ${armedCount}`);
}
await check('点击另一行的删除只发出一次请求（点到已确认的那行才删）', () => {
  // Clicking B while A is armed: B is not armed, so this must only arm B.
  const buttons = findAll(tree, 'dsn-btn danger');
  buttons[1].props.onClick();
  assert.equal(deleteCalls().length, 0, '在 B 上点第一次不应删除任何东西');
});

// ---------------------------------------------------------------------------------------------
// 便签闹钟列表：同一套二次确认。
//
// 闹钟里有用户输入的内容（名称、要显示的文字/图片、排期），误点同样找不回来。这里断言的是
// **同样的两段式**，而不是"有确认" —— 因为两套状态是分开的，共用一套会互相干扰。
// ---------------------------------------------------------------------------------------------
console.log('\n=== 便签闹钟列表：同样两次点击 ===');

/** 切到「便签闹钟」标签页。 */
async function switchToAlarms() {
  // Filter to buttons: `dsn-tab` is a substring of the container's `dsn-tabs`, so a loose match also
  // returns the container div — which has no onClick and silently did nothing. Exactly two tabs are
  // expected, so assert that rather than trusting index 1.
  const tabs = findAll(tree, 'dsn-tab').filter((el) => el.type === 'button' && typeof el.props.onClick === 'function');
  assert.equal(tabs.length, 2, `应有 2 个标签按钮，实际 ${tabs.length}`);
  tabs[1].props.onClick();
  await flush();
}

const alarmDeleteCalls = () => requests.filter((r) => r.method === 'DELETE' && r.url.includes('/alarms'));

/** The alarm list's delete button, matched by its translation key so it cannot be the notes one. */
const alarmDeleteButton = () => {
  const button = findAll(tree, 'dsn-btn danger').find((b) =>
    String(b.props.title).startsWith('alarm.delete'),
  );
  assert.ok(button !== undefined, '找不到闹钟的删除按钮');
  return button;
};

const alarmLabel = (button) =>
  button.children.map((c) => (typeof c === 'string' ? c : (c?.children?.join('') ?? ''))).join('');

await switchToAlarms();
await check('闹钟列表渲染出删除按钮（且是闹钟那一个，不是便签的）', () => {
  const button = alarmDeleteButton();
  assert.equal(String(button.props.className).includes('confirming'), false, '初始不应是确认态');
  assert.equal(alarmLabel(button), 'alarm.delete', `初始应显示 alarm.delete，实际 ${alarmLabel(button)}`);
});

reset();
{
  alarmDeleteButton().props.onClick();
  await flush();
}
await check('第一次点击闹钟的删除：不发任何 DELETE 请求', () => {
  assert.equal(alarmDeleteCalls().length, 0, `不应删除，实际发了 ${alarmDeleteCalls().length} 次`);
});
await check('第一次点击后进入确认态并改文案', () => {
  const button = alarmDeleteButton();
  assert.equal(String(button.props.className).includes('confirming'), true, '应进入 confirming 状态');
  assert.equal(alarmLabel(button), 'alarm.deleteConfirm', `按钮应显示 alarm.deleteConfirm，实际 ${alarmLabel(button)}`);
  assert.equal(button.props.title, 'alarm.deleteConfirmHint', `提示应为 alarm.deleteConfirmHint，实际 ${button.props.title}`);
});

reset();
{
  alarmDeleteButton().props.onClick();
  await flush();
}
await check('第二次点击闹钟的删除：发出 DELETE /alarms 且 id 正确', () => {
  assert.equal(alarmDeleteCalls().length, 1, `应恰好删除一次，实际 ${alarmDeleteCalls().length} 次`);
  assert.ok(alarmDeleteCalls()[0].url.includes('id=a1'), `URL 应含 id=a1，实际 ${alarmDeleteCalls()[0].url}`);
});

await check('删闹钟不会误删便签（两套状态互不干扰）', () => {
  const noteDeletes = requests.filter((r) => r.method === 'DELETE' && r.url.includes('/notes'));
  assert.equal(noteDeletes.length, 0, `不应产生任何 /notes 的 DELETE，实际 ${noteDeletes.length} 次`);
});

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log('删除二次确认测试：全部通过 ✅');
  console.log('  第一次点击只进入确认态（按钮变「确认删除」+ 填充红色），');
  console.log('  第二次点击才真正删除，3 秒未确认则自动解除。');
  process.exit(0);
}
console.error(`删除二次确认测试：${failures.length} 项失败 ❌`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);

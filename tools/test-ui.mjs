/**
 * Verify the browser half inside a real Chromium, against a real DSH instance.
 *
 * Everything else about the client half is checked by stubbing DSH's shell. This
 * is the only test that runs the bundle in an actual browser against an actual
 * DSH page, so it catches what stubs cannot: a stylesheet that fails to apply, a
 * panel that throws during React's real render, a locale lookup that returns the
 * raw key, and — most importantly — whether the sidebar entry and the settings
 * page are genuinely reachable by clicking.
 *
 * Usage: node tools/test-ui.mjs <dshPort> <token> <cdpPort>
 *
 * @module dsh-sticky-notes-desktop/tools/test-ui
 */
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/admin/.dsh/profiles/desktop/node_modules/puppeteer-core');

const [dshPort, token, cdpPort] = process.argv.slice(2);
if (!dshPort || !token || !cdpPort) {
  console.error('用法: node tools/test-ui.mjs <dshPort> <token> <cdpPort>');
  process.exit(2);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(HERE, '.ui-shots');
mkdirSync(SHOT_DIR, { recursive: true });

const failures = [];
async function step(label, fn) {
  try {
    await fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
}

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();

/** Everything the page logged, so a console error is visible as a failure. */
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await page.goto(`http://127.0.0.1:${dshPort}/?token=${encodeURIComponent(token)}`, {
  waitUntil: 'networkidle2',
  timeout: 60000,
});
await sleep(3000);

console.log(`已在真实浏览器中打开 DSH（${page.url().replace(/token=[^&]+/, 'token=…')}）\n`);

// ---------------------------------------------------------------- settings ==
console.log('[功能四] 设置界面里的「便签设置」页');

await step('bundle 已被加载（globalThis.__dshSticky 存在）', async () => {
  const present = await page.evaluate(() => typeof globalThis.__dshSticky === 'object' && globalThis.__dshSticky !== null);
  assert.equal(present, true, 'bundle 应当已执行并建立命名空间');
});

await step('样式已注入（面板与设置页的 CSS 都在 <head> 里）', async () => {
  const info = await page.evaluate(() => {
    const node = document.getElementById('dsh-sticky-notes-desktop-style');
    return node === null ? null : { length: node.textContent.length, hasPanel: node.textContent.includes('.dsn-panel'), hasSettings: node.textContent.includes('.dsn-set') };
  });
  assert.ok(info !== null, '必须存在 id=dsh-sticky-notes-desktop-style 的 style 节点');
  assert.ok(info.length > 500, `样式内容过短：${info.length}`);
  assert.equal(info.hasPanel, true, '样式里必须有面板规则');
  assert.equal(info.hasSettings, true, '样式里必须有设置页规则');
});

await step('设置页可被点击打开，并渲染出便签设置项', async () => {
  // The settings trigger sits at the sidebar foot; click it.
  const clicked = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"], a')];
    const trigger = buttons.find((el) => /设置|Settings/i.test(el.textContent ?? '') || /settings/i.test(el.getAttribute('aria-label') ?? ''));
    if (trigger === undefined) return 'no-trigger';
    trigger.click();
    return 'clicked';
  });
  assert.equal(clicked, 'clicked', '应当能在页面里找到“设置”入口');
  await sleep(1500);

  // The settings nav entry is what proves `settings.section` registered.
  const navLabel = await page.evaluate(() => {
    const items = [...document.querySelectorAll('button, [role="tab"], [role="button"], li, a')];
    const target = items.find((el) => /便签设置|Sticky notes/.test(el.textContent ?? ''));
    if (target === undefined) return null;
    target.click();
    return (target.textContent ?? '').trim();
  });
  assert.ok(navLabel !== null, '设置导航里应当出现「便签设置」，说明 settings.section 注册成功');

  // Wait for React to mount our page *and* finish its first data-driven render.
  // Polling on the container alone is not enough: the settings component renders a
  // loading shell until its fetch resolves, so the cards appear a tick later.
  let rendered = null;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    rendered = await page.evaluate(() => {
      const root = document.querySelector('.dsn-set');
      if (root === null) return null;
      return {
        text: root.innerText.slice(0, 800),
        cards: root.querySelectorAll('.dsn-set-card').length,
        inputs: root.querySelectorAll('input').length,
        buttons: root.querySelectorAll('button').length,
        hasObjectObject: /\[object Object\]/.test(root.innerText),
      };
    });
    if (rendered !== null && rendered.cards >= 2 && rendered.inputs >= 5) break;
    await sleep(400);
  }

  assert.ok(rendered !== null, `设置页必须真的渲染出 .dsn-set 容器（导航项为「${navLabel}」）`);
  assert.ok(
    rendered.cards >= 2,
    `至少应有快捷键/外观/行为几张卡片，实际 ${rendered.cards}（输入控件 ${rendered.inputs}，按钮 ${rendered.buttons}）`,
  );
  assert.ok(rendered.inputs >= 5, `设置项应当有多个输入控件，实际 ${rendered.inputs}`);
  assert.ok(/快捷键/.test(rendered.text), `设置页应显示快捷键设置，实际文本：${rendered.text.slice(0, 200)}`);
  // Regression: the footer/ banner used to print the raw outcome object.
  assert.equal(rendered.hasObjectObject, false, `设置页不应出现 [object Object]，实际文本：${rendered.text.slice(0, 300)}`);
  await page.screenshot({ path: join(SHOT_DIR, 'settings.png') });
});

// ------------------------------------------------------------ notes panel ==
console.log('\n[功能二] 左侧栏便签入口与便签面板');

await step('侧边栏出现「便签」入口并可点击', async () => {
  const clicked = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    // The rail entry's accessible name comes from its label.
    const entry = nodes.find((el) => {
      const name = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`;
      return /便签|Notes/.test(name) && !/便签设置/.test(name);
    });
    if (entry === undefined) return 'not-found';
    entry.click();
    return 'clicked';
  });
  assert.equal(clicked, 'clicked', '侧边栏应当有「便签」入口（sidebar.panellist 注册成功）');
  await sleep(2500);

  const panel = await page.evaluate(() => {
    const root = document.querySelector('.dsn-panel');
    if (root === null) return null;
    return { text: root.innerText.slice(0, 400), buttons: [...root.querySelectorAll('button')].map((b) => b.textContent?.trim()) };
  });
  assert.ok(panel !== null, '便签面板必须真的渲染出 .dsn-panel');
  assert.ok(panel.buttons.some((b) => /新建便签/.test(b ?? '')), `面板应有「新建便签」按钮，实际：${panel.buttons.join(' / ')}`);
  assert.ok(panel.buttons.some((b) => /截图/.test(b ?? '')), '面板应有「截图」按钮');
  // Regression: the status footer printed the raw hotkey outcome object.
  assert.equal(
    /\[object Object\]/.test(panel.text),
    false,
    `面板脚注不应出现 [object Object]，实际：${panel.text.slice(-160)}`,
  );
  await page.screenshot({ path: join(SHOT_DIR, 'panel.png') });
});

// Kept as its own step *after* a note exists: an empty list has no row to measure, which
// is how an earlier version of this check failed for the wrong reason.
await step('便签行布局：标签与按钮同处一行，且不横向溢出', async () => {
  // The row is title/preview above one bottom line holding tags + buttons, so the row
  // cannot be taller than its text. Asserted structurally because "the row looks cramped"
  // is exactly what a text-only assertion cannot notice.
  const layout = await page.evaluate(() => {
    const row = document.querySelector('.dsn-row');
    if (row === null) return null;
    const acts = row.querySelector('.dsn-acts');
    const foot = row.querySelector('.dsn-foot-row');
    const buttons = acts === null ? [] : [...acts.querySelectorAll('button')];
    const tops = buttons.map((b) => Math.round(b.getBoundingClientRect().top));
    return {
      rowHeight: Math.round(row.getBoundingClientRect().height),
      rowWidth: Math.round(row.getBoundingClientRect().width),
      actsRight: acts === null ? null : Math.round(acts.getBoundingClientRect().right),
      footTop: foot === null ? null : Math.round(foot.getBoundingClientRect().top),
      buttonCount: buttons.length,
      // One distinct top means one visual row of buttons.
      distinctButtonTops: [...new Set(tops)].length,
      overflows: row.scrollWidth - row.clientWidth,
    };
  });
  assert.ok(layout !== null, '应当能取到一条便签行用于布局检查');
  assert.equal(layout.buttonCount, 4, `每行应有 4 个操作按钮，实际 ${layout.buttonCount}`);
  assert.equal(
    layout.distinctButtonTops,
    1,
    `按钮必须排成一行（旧版是竖排四行，正是行高过大的原因），实际有 ${layout.distinctButtonTops} 行`,
  );
  assert.ok(layout.overflows <= 1, `行内不得横向溢出（侧边栏很窄），实际溢出 ${layout.overflows}px`);
  assert.ok(layout.rowHeight <= 92, `行高应当被压到文字高度量级，实际 ${layout.rowHeight}px`);
  console.log(
    `  [布局] 行 ${layout.rowWidth}x${layout.rowHeight}，按钮 ${layout.buttonCount} 个排成 ${layout.distinctButtonTops} 行，横向溢出 ${layout.overflows}px`,
  );

  // The measurement above is at full viewport width, which is NOT the width the user sees —
  // the sidebar is far narrower. Re-measure in a ~300px box: that is the case that decides
  // whether four buttons still fit on one line.
  const narrow = await page.evaluate(() => {
    const row = document.querySelector('.dsn-row');
    if (row === null) return null;
    const host = document.createElement('div');
    host.id = 'dsn-narrow-probe';
    host.style.cssText =
      'width:320px;position:fixed;left:0;top:0;z-index:2147483647;background:#1b1b1f;padding:10px;box-sizing:border-box';
    const clone = row.cloneNode(true);
    host.appendChild(clone);
    document.body.appendChild(host);
    const acts = clone.querySelector('.dsn-acts');
    const buttons = acts === null ? [] : [...acts.querySelectorAll('button')];
    const tops = buttons.map((b) => Math.round(b.getBoundingClientRect().top));
    const result = {
      height: Math.round(clone.getBoundingClientRect().height),
      distinctButtonTops: [...new Set(tops)].length,
      overflows: clone.scrollWidth - clone.clientWidth,
      actionsOverflow: acts === null ? null : acts.scrollWidth - acts.clientWidth,
    };
    return result;
  });
  assert.ok(narrow !== null, '应当能测量窄宽度下的行布局');
  assert.equal(
    narrow.distinctButtonTops,
    1,
    `侧边栏窄宽度下按钮仍须排成一行，实际 ${narrow.distinctButtonTops} 行：${JSON.stringify(narrow)}`,
  );
  assert.ok(narrow.overflows <= 1, `窄宽度下不得横向溢出，实际 ${narrow.overflows}px`);
  console.log(
    `  [布局] 320px 窄宽度下：行高 ${narrow.height}，按钮仍 ${narrow.distinctButtonTops} 行，溢出 ${narrow.overflows}px`,
  );

  // The clone is left in place for one screenshot so the narrow layout can be judged by
  // eye as well; "the row looks cramped" is not something assertions can settle.
  const probe = await page.$('#dsn-narrow-probe');
  if (probe !== null) {
    await probe.screenshot({ path: join(SHOT_DIR, 'panel-narrow.png') });
    console.log(`  [布局] 窄宽度截图：${join(SHOT_DIR, 'panel-narrow.png')}`);
    await page.evaluate(() => document.getElementById('dsn-narrow-probe')?.remove());
  }
});

await step('通过面板「新建便签」按钮真的建出便签并出现在列表里', async () => {
  const before = await page.evaluate(async () => {
    const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
    return (await response.json()).notes.length;
  });

  await page.evaluate(() => {
    const root = document.querySelector('.dsn-panel');
    const button = [...root.querySelectorAll('button')].find((b) => /新建便签/.test(b.textContent ?? ''));
    button.click();
  });
  await sleep(3500);

  const after = await page.evaluate(async () => {
    const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
    const payload = await response.json();
    return { count: payload.notes.length, helper: payload.helper.running };
  });
  assert.equal(after.count, before + 1, `列表应当多出一条便签：${before} → ${after.count}`);
  assert.equal(after.helper, true, '助手应当在运行（说明真的弹出了置顶窗口）');

  // And the row must be visible in the DOM, not only in the API.
  const rows = await page.evaluate(() => document.querySelectorAll('.dsn-row').length);
  assert.ok(rows >= 1, `面板里应当出现至少一行便签，实际 ${rows}`);
  await page.screenshot({ path: join(SHOT_DIR, 'panel-with-note.png') });
});

await step('面板「编辑」可展开编辑器并保存', async () => {
  const opened = await page.evaluate(() => {
    const row = document.querySelector('.dsn-row');
    if (row === null) return 'no-row';
    const button = [...row.querySelectorAll('button')].find((b) => /编辑/.test(b.textContent ?? ''));
    if (button === undefined) return 'no-edit-button';
    button.click();
    return 'clicked';
  });
  assert.equal(opened, 'clicked', '每行应当有「编辑」按钮');
  await sleep(800);

  const editor = await page.evaluate(() => {
    const node = document.querySelector('.dsn-edit');
    return node === null ? null : { textareas: node.querySelectorAll('textarea').length, inputs: node.querySelectorAll('input').length };
  });
  assert.ok(editor !== null, '点击编辑后必须出现 .dsn-edit 编辑器');
  assert.ok(editor.textareas >= 1, '编辑器应当有正文输入区');
  await page.screenshot({ path: join(SHOT_DIR, 'editor.png') });
});

await step('页面运行期间没有 console 错误', async () => {
  const relevant = consoleErrors.filter(
    (line) => !/favicon|DevTools|Autofill|Failed to load resource: the server responded with a status of 40/i.test(line),
  );
  assert.deepEqual(relevant, [], `出现 console 错误：\n${relevant.join('\n')}`);
});

console.log(`\n截图已保存到 ${SHOT_DIR}`);
await page.close();
browser.disconnect();

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('真实浏览器 UI 验证：全部通过 ✅');
  process.exit(0);
}
console.error(`真实浏览器 UI 验证：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

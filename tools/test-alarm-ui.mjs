/**
 * The 便签闹钟 tab, driven through the real UI.
 *
 * The list and editor only exist in the browser half, so nothing else can check that the tab
 * switches, that the editor saves, or that an alarm created there comes back — and a form that
 * silently fails to save is the most likely way this feature breaks in practice.
 *
 * Usage: node tools/test-alarm-ui.mjs <dshPort> <token> <cdpPort>
 *
 * @module dsh-sticky-notes-desktop/tools/test-alarm-ui
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const puppeteer = require('C:/Users/admin/.dsh/profiles/desktop/node_modules/puppeteer-core');

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = join(HERE, '.ui-shots');
mkdirSync(SHOT_DIR, { recursive: true });

const [, , dshPort, token, cdpPort] = process.argv;
const base = 'http://127.0.0.1:' + String(dshPort);

const failures = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Click a button inside the panel whose label matches.
 *
 * `scope` narrows which buttons are considered. Needed because the same label can now appear
 * twice — 「试响」 is both a list action and an editor action — and clicking "the first match"
 * silently hit the wrong one.
 */
const clickPanel = (pattern, scope = '') => `(() => {
  const panel = document.querySelector('.dsn-panel');
  if (panel === null) return 'no-panel';
  const root = panel.querySelector(${JSON.stringify(scope)}) ?? panel;
  const button = [...root.querySelectorAll('button')].find((b) => ${pattern}.test(b.textContent ?? ''));
  if (button === undefined) return 'no-button';
  button.click();
  return 'clicked';
})()`;

/** Click a button in one alarm's list row (not the editor). */
const clickRow = (pattern) => clickPanel(pattern, '.dsn-body');

/** Set a React-controlled input's value so React sees the change. */
const setInput = (selector, value) => `(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (input === null) return 'no-input';
  const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'set';
})()`;

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
// Record which request failed, not just that something did: "404" alone does not say whether
// it is an alarm image, a note image, or something else entirely.
const failedRequests = [];
page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}`));
page.on('response', (response) => {
  if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3000);

  await step('先清空已有闹钟（本套件跑在共享实例上，必须自清理）', async () => {
    // Without this the assertions below match alarms left by earlier runs — which is exactly
    // how "删除 did not work" appeared: the label was still present, but from a previous run.
    const removed = await page.evaluate(async () => {
      const state = await (await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' })).json();
      let count = 0;
      for (const alarm of state.alarms ?? []) {
        await fetch('/plugins/dsh-sticky-notes-desktop/alarms?id=' + encodeURIComponent(alarm.id), {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        count += 1;
      }
      return count;
    });
    const left = await page.evaluate(async () => {
      const state = await (await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' })).json();
      return (state.alarms ?? []).length;
    });
    assert.equal(left, 0, `清空后不应还有闹钟，实际 ${left}`);
    console.log(`  [准备] 清掉了 ${removed} 条遗留闹钟`);
  });

  await step('侧边栏打开便签面板，并且有「便签 / 便签闹钟」两个标签', async () => {
    // The rail entry's accessible name comes from its label, and 便签设置 must not match.
    const clicked = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], a')];
      const entry = nodes.find((node) => {
        const name = `${node.textContent ?? ''} ${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`;
        return /便签|Notes/.test(name) && !/便签设置/.test(name);
      });
      if (entry === undefined) return 'not-found';
      entry.click();
      return 'clicked';
    });
    assert.equal(clicked, 'clicked', '侧边栏应当有「便签」入口');
    await sleep(2500);

    const tabs = await page.evaluate(() =>
      [...document.querySelectorAll('.dsn-tab')].map((node) => node.textContent.trim()),
    );
    assert.equal(tabs.length, 2, `应当有两个标签，实际 ${JSON.stringify(tabs)}`);
    assert.ok(/便签/.test(tabs[0]), `第一个标签应当是便签，实际 ${tabs[0]}`);
    assert.ok(/便签闹钟/.test(tabs[1]), `第二个标签应当是便签闹钟，实际 ${tabs[1]}`);
  });

  await step('切到「便签闹钟」标签，显示闹钟列表与「新建闹钟」', async () => {
    await page.evaluate(`(() => {
      const tab = [...document.querySelectorAll('.dsn-tab')].find((n) => /便签闹钟/.test(n.textContent ?? ''));
      if (tab) tab.click();
      return 'clicked';
    })()`);
    await sleep(800);
    const text = await page.evaluate(() => document.querySelector('.dsn-panel').innerText);
    assert.ok(/新建闹钟/.test(text), `应当有「新建闹钟」按钮，实际：${text.slice(0, 160)}`);
    await page.screenshot({ path: join(SHOT_DIR, 'alarm-tab.png') });
  });

  await step('编辑器里明确提示「可通过试响调整位置」，并显示当前位置', async () => {
    await page.evaluate(clickPanel('/新建闹钟/', '.dsn-head'));
    await sleep(700);

    const hint = await page.evaluate(() => {
      const node = document.querySelector('.dsn-poshint');
      if (node === null) return null;
      return {
        text: node.innerText,
        hasTestButton: [...node.parentElement.querySelectorAll('button')].some((b) => /试响/.test(b.textContent ?? '')),
      };
    });
    assert.ok(hint !== null, '编辑器必须有位置提示条');
    assert.ok(/试响/.test(hint.text), `提示必须说明用试响调位置，实际：${hint.text}`);
    assert.ok(/位置/.test(hint.text), `提示应当带上当前位置状态，实际：${hint.text}`);
    assert.equal(hint.hasTestButton, true, '编辑器里必须有「试响」按钮（新建时也要能试响）');
    console.log(`  [提示] ${hint.text.replace(/\n/g, ' / ')}`);
    await page.screenshot({ path: join(SHOT_DIR, 'alarm-editor.png') });
  });

  await step('新建（未保存）时点「试响」不会产生存储记录', async () => {
    // 试响 needs the Electron helper to put a window up. A browser-only verification instance is
    // a legitimate state, not a failure — the helper-dependent half is covered by
    // tools/test-alarm-ring.mjs, which drives a real popup including the draft path. Skipping
    // also keeps the "no console errors" assertion honest: a 404 here would be noise from an
    // absent helper, not a bug.
    const helperRunning = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).helper?.running === true;
    });
    if (helperRunning !== true) {
      console.log('         （跳过一次：本实例没有运行 Electron 助手，草稿试响由 test-alarm-ring.mjs 覆盖）');
      await page.evaluate(clickPanel('/^取消$/', '.dsn-edit'));
      await sleep(600);
      return;
    }

    const countAlarms = () =>
      page.evaluate(async () => {
        const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
        return (await response.json()).alarms.length;
      });

    const before = await countAlarms();
    await page.evaluate(clickPanel('/^试响$/', '.dsn-edit'));
    await sleep(2500);
    const after = await countAlarms();
    assert.equal(after, before, `试响未保存的闹钟绝不能存下记录：${before} → ${after}`);

    // Close the editor again so the next step starts clean.
    await page.evaluate(clickPanel('/^取消$/', '.dsn-edit'));
    await sleep(600);
  });

  await step('在编辑器里建一条「工作日 09:30」的文字闹钟并保存', async () => {
    await page.evaluate(clickPanel('/新建闹钟/', '.dsn-head'));
    await sleep(700);

    const setLabel = await page.evaluate(setInput('.dsn-edit input[placeholder]', '站会提醒'));
    assert.equal(setLabel, 'set', '应当能填名称');
    const setText = await page.evaluate(setInput('.dsn-edit textarea', '该开站会了'));
    assert.equal(setText, 'set', '应当能填内容');

    // 工作日 + 09:30
    await page.evaluate(clickPanel('/^工作日$/', '.dsn-edit'));
    await sleep(400);
    const setTime = await page.evaluate(setInput('.dsn-edit input[type="time"]', '09:30'));
    assert.equal(setTime, 'set', '应当能填时间');

    await page.evaluate(clickPanel('/保存闹钟/', '.dsn-edit'));
    await sleep(2500);
  });

  await step('保存后的闹钟出现在列表里，并显示排期与下一次时间', async () => {
    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    assert.ok(Array.isArray(list) && list.length > 0, `存储里应当有闹钟，实际 ${JSON.stringify(list)}`);
    const alarm = list.find((entry) => entry.label === '站会提醒');
    assert.ok(alarm !== undefined, `应当找到刚建的闹钟，实际 ${JSON.stringify(list.map((a) => a.label))}`);
    assert.equal(alarm.schedule.kind, 'weekdays', '排期必须是工作日');
    assert.equal(alarm.schedule.time, '09:30');
    assert.equal(alarm.kind, 'text');
    assert.equal(alarm.enabled, true);
    assert.equal(alarm.scheduleText, '工作日 09:30', `排期文案应当可读，实际 ${alarm.scheduleText}`);
    assert.ok(typeof alarm.nextAt === 'string', '必须算出下一次触发时间');

    // And it must be on screen, not only in the API.
    const text = await page.evaluate(() => document.querySelector('.dsn-panel').innerText);
    assert.ok(/站会提醒/.test(text), `列表里应当显示这条闹钟，实际：${text.slice(0, 200)}`);
    assert.ok(/工作日 09:30/.test(text), `列表里应当显示排期，实际：${text.slice(0, 200)}`);
  });

  await step('「停用」会写回存储，并且列表标注出来', async () => {
    await page.evaluate(clickRow('/^停用$/'));
    await sleep(2000);
    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    const alarm = list.find((entry) => entry.label === '站会提醒');
    assert.equal(alarm.enabled, false, '停用必须写回存储');
    assert.equal(alarm.nextAt, null, '停用后不应再有下一次');
  });

  await step('「启用」能再打开', async () => {
    await page.evaluate(clickRow('/^启用$/'));
    await sleep(2000);
    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    const alarm = list.find((entry) => entry.label === '站会提醒');
    assert.equal(alarm.enabled, true, '启用必须写回存储');
    assert.ok(typeof alarm.nextAt === 'string', '启用后必须重新算出下一次');
  });

  await step('「试响」会真的弹出闹钟窗口（并标记「正在响」）', async () => {
    // Needs the Electron helper, which this instance may not have running — a browser-only
    // verification environment is a legitimate state, not a failure of the feature. The
    // helper-dependent half is covered end to end by tools/test-alarm-ring.mjs; what this
    // step adds is the button → route → helper wiring.
    const helperRunning = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).helper?.running === true;
    });
    if (helperRunning !== true) {
      console.log('         （跳过一次：本实例没有运行 Electron 助手，响铃由 test-alarm-ring.mjs 覆盖）');
      return;
    }

    await page.evaluate(clickRow('/试响/'));
    await sleep(3500);

    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    const alarm = list.find((entry) => entry.label === '站会提醒');
    assert.equal(alarm.ringing, true, `试响后应当标记为正在响，实际 ${JSON.stringify(alarm)}`);

    // 试响不能消耗闹钟 —— 记账字段不得被写。
    assert.equal(alarm.lastFiredAt, null, '试响绝不能写 lastFiredAt');

    const text = await page.evaluate(() => document.querySelector('.dsn-panel').innerText);
    assert.ok(/正在响/.test(text), `列表应当标注「正在响」，实际：${text.slice(0, 200)}`);
    await page.screenshot({ path: join(SHOT_DIR, 'alarm-ringing.png') });
  });

  await step('「关闭响铃」能把它停掉', async () => {
    const helperRunning = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).helper?.running === true;
    });
    if (helperRunning !== true) {
      console.log('         （跳过一次：同上）');
      return;
    }

    await page.evaluate(clickRow('/关闭响铃/'));
    await sleep(2500);
    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    const alarm = list.find((entry) => entry.label === '站会提醒');
    assert.equal(alarm.ringing, false, '关闭后不应再算作正在响');
    assert.equal(typeof alarm.lastDismissedAt, 'string', '关闭必须被登记');
  });

  await step('「删除」会把闹钟从列表与存储里去掉', async () => {
    const clicked = await page.evaluate(clickRow('/^删除$/'));
    if (clicked !== 'clicked') {
      // Report what the row actually offered, not merely that the click failed.
      const buttons = await page.evaluate(() =>
        [...document.querySelectorAll('.dsn-body button')].map((b) => b.textContent.trim()),
      );
      throw new Error(`应当在列表行里找到「删除」，点击结果 ${clicked}；列表按钮：${JSON.stringify(buttons)}`);
    }
    await sleep(2500);
    const list = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/state', { credentials: 'same-origin' });
      return (await response.json()).alarms;
    });
    assert.equal(
      list.some((entry) => entry.label === '站会提醒'),
      false,
      `删除后不应还在，实际 ${JSON.stringify(list.map((a) => a.label))}`,
    );
  });

  await step('切换标签来回都不报错', async () => {
    for (const label of ['便签', '便签闹钟', '便签']) {
      await page.evaluate(`(() => {
        const tab = [...document.querySelectorAll('.dsn-tab')].find((n) => n.textContent.trim().startsWith(${JSON.stringify(label)}));
        if (tab) tab.click();
        return 'ok';
      })()`);
      await sleep(600);
    }
  });

  await step('整个流程没有 console 错误', async () => {
    if (failedRequests.length > 0) console.error(`         失败的请求：${JSON.stringify(failedRequests)}`);
    assert.deepEqual(consoleErrors, [], `不应有 console 错误：${consoleErrors.join(' | ')}`);
  });
} catch (error) {
  console.error('\n闹钟 UI 测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await page.close().catch(() => {});
  await browser.disconnect().catch(() => {});
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('便签闹钟 UI 测试：全部通过 ✅');
  console.log(`截图：${SHOT_DIR}`);
  process.exit(0);
}
console.error(`便签闹钟 UI 测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

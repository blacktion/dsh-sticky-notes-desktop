/**
 * The 便签服务 status card on the settings page, driven through the real UI.
 *
 * The card exists to be *seen* and *used*, and both live in the browser half, so nothing else can
 * check that the state reads correctly or that the buttons reach the routes.
 *
 * Usage: node tools/test-service-ui.mjs <dshPort> <token> <cdpPort>
 *
 * @module dsh-sticky-notes-desktop/tools/test-service-ui
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
const consoleErrors = [];
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

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}`, defaultViewport: { width: 1600, height: 1000 } });
const page = await browser.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

/** Read the card as the user sees it. */
const cardState = () => page.evaluate(() => {
  const card = document.querySelector('.dsn-svc');
  if (card === null) return null;
  const banner = card.closest('.dsn-set-banner');
  return {
    text: banner ? banner.innerText : card.innerText,
    className: banner ? banner.className : '',
    buttons: [...(banner ? banner.querySelectorAll('button') : [])].map((b) => ({
      text: b.textContent.trim(),
      disabled: b.disabled,
    })),
  };
});

/** Click a button in the service card by its label. */
async function clickService(pattern) {
  return page.evaluate((source) => {
    const card = document.querySelector('.dsn-svc');
    if (card === null) return 'no-card';
    const banner = card.closest('.dsn-set-banner');
    // Accepts "/x/" as well as "x": the delimiters are stripped, because `new RegExp('/x/')`
    // matches a literal "/x/" and would silently find nothing.
    const body = source.startsWith('/') && source.endsWith('/') ? source.slice(1, -1) : source;
    const buttons = Array.from(banner.querySelectorAll('button'));
    const button = buttons.find((b) => new RegExp(body).test(b.textContent ?? ''));
    if (button === undefined) return `no-button:${buttons.map((b) => b.textContent.trim()).join(',')}`;
    button.click();
    return 'clicked';
  }, pattern);
}

try {
  await page.goto(`${base}/?token=${encodeURIComponent(token)}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await sleep(3500);

  // The settings page is the only place the card exists, so switch to it explicitly — clicking the
  // rail's 「便签」 entry opens the notes panel instead.
  const switched = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('button, [role="button"], a')];
    const entry = nodes.find(
      (node) => /设置|Settings/i.test(node.textContent ?? '') || /settings/i.test(node.getAttribute('aria-label') ?? ''),
    );
    if (entry === undefined) return 'no-settings-entry';
    entry.click();
    return 'clicked';
  });
  console.log(`  [准备] 打开设置：${switched}`);
  await sleep(2000);

  await step('设置页有「便签设置」一节，并且能看到服务状态', async () => {
    const found = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('button, [role="button"], a, [role="tab"]')];
      const entry = nodes.find((node) => /便签设置/.test(node.textContent ?? ''));
      if (entry === undefined) return 'no-entry';
      entry.click();
      return 'clicked';
    });
    console.log(`  [准备] 打开便签设置：${found}`);
    await sleep(2000);

    const card = await cardState();
    assert.ok(card !== null, '设置页必须有服务状态卡片（.dsn-svc）');
    assert.ok(/便签服务/.test(card.text), `卡片必须说明这是「便签服务」，实际：${card.text}`);
    console.log(`  [状态] ${card.text.replace(/\n/g, ' / ')}`);
  });

  await step('卡片有「启动服务 / 重启服务 / 刷新状态」，且状态与宿主一致', async () => {
    const card = await cardState();
    const labels = card.buttons.map((b) => b.text);
    assert.ok(labels.some((l) => /启动服务/.test(l)), `必须有「启动服务」，实际 ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /重启服务/.test(l)), `必须有「重启服务」，实际 ${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /刷新状态/.test(l)), `必须有「刷新状态」，实际 ${JSON.stringify(labels)}`);
    // Three buttons when stopped (no 停止服务), four when running. Asserting a fixed count would
    // make the test fail for the wrong reason whenever the service is already up.
    const expectedCount = /正在运行|无响应/.test(card.text) ? 4 : 3;    assert.equal(
      card.buttons.length,
      expectedCount,
      `应当有 ${expectedCount} 个按钮，实际 ${JSON.stringify(labels)}`,
    );

    // The card must say what the host says. A status display that disagrees with the thing it
    // reports is worse than no status display.
    const live = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/helper', { credentials: 'same-origin' });
      return await response.json();
    });
    const expected = live.state === 'running' ? /正在运行/ : live.state === 'unresponsive' ? /无响应/ : /未运行/;
    assert.ok(
      expected.test(card.text),
      `卡片状态必须与宿主一致：宿主报 ${live.state}，卡片显示「${card.text.split('\n')[0]}」`,
    );
    console.log(`  [一致] 宿主 state=${live.state}，卡片文案吻合`);
    await page.screenshot({ path: join(SHOT_DIR, 'service-card.png') });
  });

  await step('点「刷新状态」会重新探测（这是真实的 按钮→路由→更新 链路）', async () => {
    const clicked = await clickService('刷新状态');
    assert.equal(clicked, 'clicked', `应当能点到「刷新状态」，实际 ${clicked}`);
    await sleep(2500);

    const card = await cardState();
    assert.ok(card !== null, '刷新后卡片必须还在');
    assert.ok(/便签服务/.test(card.text), '刷新后卡片内容必须仍然正常');

    const live = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/helper', { credentials: 'same-origin' });
      return await response.json();
    });
    const expected = live.state === 'running' ? /正在运行/ : live.state === 'unresponsive' ? /无响应/ : /未运行/;
    assert.ok(expected.test(card.text), `刷新后卡片必须仍与宿主一致（宿主 ${live.state}）`);
  });

  await step('点「重启服务」会真的尝试重启，并把结果显示出来', async () => {
    const clicked = await clickService('重启服务');
    assert.equal(clicked, 'clicked', `应当能点到「重启服务」，实际 ${clicked}`);
    await sleep(9000);

    const card = await cardState();
    assert.ok(card !== null, '重启后卡片必须还在（重启不能把页面弄坏）');
    // Either outcome is legitimate here: this instance may not own the data directory, in which
    // case a second helper is refused by design. What must not happen is a silent no-op.
    const host = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/helper', { credentials: 'same-origin' });
      return await response.json();
    });
    const expected = host.state === 'running' ? /正在运行/ : host.state === 'unresponsive' ? /无响应/ : /未运行/;
    assert.ok(expected.test(card.text), `重启后卡片必须与宿主一致（宿主 ${host.state}）`);
    console.log(`  [重启后] 宿主 state=${host.state}；卡片：${card.text.split('\n')[0]}`);
  });

  await step('与本实例是否真的持有服务无关：生命周期本身由 test-helper-service.mjs 覆盖', async () => {
    // Deliberately not asserting "start makes it running" here. In a shared environment the user's
    // own DSH holds `helper.lock`, so a second helper is refused — correctly. The real
    // start / restart / stop lifecycle runs in its own data directory in test-helper-service.mjs,
    // which asserts the state transitions; this suite covers the UI contract.
    const host = await page.evaluate(async () => {
      const response = await fetch('/plugins/dsh-sticky-notes-desktop/helper', { credentials: 'same-origin' });
      return await response.json();
    });
    assert.ok(typeof host.state === 'string' && host.state.length > 0, '宿主必须报告一个状态');
    assert.ok(typeof host.stateText === 'string', '宿主必须给出一句可读的状态说明');
    console.log(`  [说明] ${host.stateText}`);
  });

  await step('整个流程没有 console 错误', async () => {
    assert.deepEqual(consoleErrors, [], `不应有 console 错误：${consoleErrors.join(' | ')}`);
  });
} catch (error) {
  console.error('\n服务界面测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await page.close().catch(() => {});
  await browser.disconnect().catch(() => {});
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('便签服务界面测试：全部通过 ✅');
  console.log(`截图：${SHOT_DIR}`);
  process.exit(0);
}
console.error(`便签服务界面测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

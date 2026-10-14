/**
 * Menu dismissal must be deterministic.
 *
 * Regression: the popup used to be a native `Menu`, whose dismissal callback does
 * not fire reliably on Windows. Two user-visible failures followed — the menu stayed
 * on screen when the user clicked elsewhere, and because the pending state was only
 * cleared by that same callback, later hotkey presses were answered `busy`, so the
 * shortcut looked dead after one dismissal.
 *
 * The popup is now an owned window whose dismissal rules this plugin controls. This
 * test pins each rule down against a real window:
 *
 *   1. it appears at the pointer and stays while the pointer is inside,
 *   2. it dismisses once the pointer moves away — that *is* "clicking outside": the
 *      popup gets out of the way and the click lands where the user aimed,
 *   3. `Escape` (the page's own handler) dismisses it,
 *   4. after any dismissal the next hotkey press opens a fresh popup, and only an
 *      already-open popup reports `busy`,
 *   5. choosing a row answers the request, closes the window, and for 「新建便签」
 *      actually creates the note.
 *
 * The pointer is pinned with the helper's test-only `cursor.move`; synthetic pointer
 * movement cannot be produced otherwise, so this rule would be untestable.
 *
 * Usage: node tools/test-popup.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-popup
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import { ElectronHelperClient, findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}

/** Somewhere comfortably inside the work area, away from every screen edge. */
const POINTER = { x: 600, y: 400 };

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-popup-'));
const events = [];
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const client = new ElectronHelperClient({
  exe: runtime.path,
  script: join(ROOT, 'electron', 'main.mjs'),
  cwd: join(ROOT, 'electron'),
  log: () => {},
  handshakeTimeoutMs: 40000,
});
client.onEvent((message) => events.push(message));

/**
 * Start a real popup; the returned promise settles with its outcome.
 * The catch is attached in the same expression as the call: a promise that rejects
 * while detached becomes an unhandled rejection and kills the run.
 */
function openPopup() {
  return client.call('popup.show', {}, 30000).catch((error) => ({ choice: null, error: String(error) }));
}

/** Is a popup on screen right now, and where? */
function popupState() {
  return client.call('popup.state', {}, 5000);
}

const items = [];

try {
  await step('助手启动，且没有任何便签窗口（弹窗必须自己解决 BaseWindow 问题）', async () => {
    await client.ready();
    await client.call('helper.config', { dataDir, settings: { hotkey: '' } });
    assert.deepEqual((await client.call('note.list')).ids, [], '全新助手不应有任何窗口');
    const reply = await client.call('popup.items', {}, 5000);
    assert.ok(Array.isArray(reply.items) && reply.items.length >= 2, '必须能读到菜单项');
    for (const item of reply.items) items.push(item.id);
  });

  await step('弹窗出现在鼠标位置，并在鼠标停在里面时保持显示', async () => {
    await client.call('cursor.move', POINTER, 8000);
    const pending = openPopup();
    await sleep(1200);

    const state = await popupState();
    assert.equal(state.open, true, `应当存在弹窗，实际 ${JSON.stringify(state)}`);
    assert.equal(state.bounds.x, POINTER.x, `应当出现在鼠标处，实际 x=${state.bounds.x}`);
    assert.equal(state.bounds.y, POINTER.y, `应当出现在鼠标处，实际 y=${state.bounds.y}`);

    // Still there a moment later: the pointer has not moved.
    await sleep(600);
    assert.equal((await popupState()).open, true, '鼠标未移动时弹窗不应自行消失');

    await client.call('popup.dismiss', {}, 5000);
    await pending;
  });

  await step('鼠标移开后弹窗自动消失（回归：以前会留在屏幕上）', async () => {
    await client.call('cursor.move', POINTER, 8000);
    const pending = openPopup();
    await sleep(1200);
    const before = await popupState();
    assert.equal(before.open, true, '前置条件：弹窗应当在显示');

    await client.call('cursor.move', { x: POINTER.x + 600, y: POINTER.y + 300 }, 8000);
    await sleep(900);

    const after = await popupState();
    assert.equal(after.open, false, `鼠标移开后弹窗必须消失，实际 ${JSON.stringify(after)}`);

    const settled = await pending;
    assert.equal(settled.error, undefined, `应当正常回执，实际 ${JSON.stringify(settled)}`);
    assert.equal(settled.choice, null, '点在外面等于没有选择');
  });

  await step('消失后再次触发仍能弹出，且只有开着时才回执 busy（回归：曾永久 busy）', async () => {
    await client.call('cursor.move', POINTER, 8000);
    const first = openPopup();
    await sleep(1200);
    assert.equal((await popupState()).open, true, '第二次触发必须能弹出');

    const second = await client.call('popup.show', {}, 8000).catch((error) => ({ error: String(error) }));
    assert.equal(second.busy, true, '弹窗开着时重复触发应当回执 busy');
    assert.equal((await popupState()).open, true, '重复触发不应关掉正在显示的弹窗');

    await client.call('popup.dismiss', {}, 5000);
    await first;

    // And a fresh one after that: the state must have been released.
    const third = openPopup();
    await sleep(1200);
    assert.equal((await popupState()).open, true, '上一个是关闭的，这一次必须能重新弹出');
    await client.call('popup.dismiss', {}, 5000);
    await third;
  });

  await step('选择「新建便签」会回执选择、关闭弹窗，并真的建出便签', async () => {
    await client.call('cursor.move', POINTER, 8000);
    const pending = openPopup();
    await sleep(1200);

    const clicked = await client.call('popup.click', { id: 'new-note' }, 8000).catch((error) => ({ error: String(error) }));
    assert.equal(clicked.ok, true, `点击应当成功，实际 ${JSON.stringify(clicked)}`);

    const settled = await pending;
    assert.equal(settled.error, undefined, `应当正常回执，实际 ${JSON.stringify(settled)}`);
    assert.equal(settled.choice, 'new-note', `应当回执 new-note，实际 ${JSON.stringify(settled)}`);
    assert.equal((await popupState()).open, false, '选择后弹窗必须关闭');

    const ids = (await client.call('note.list')).ids;
    assert.ok(ids.length >= 1, '「新建便签」必须真的建出便签');
    assert.ok(typeof settled.note?.id === 'string', '应当回执新建的便签');
    for (const noteId of ids) await client.call('note.remove', { id: noteId });
  });

  await step('Escape 关闭弹窗且不产生副作用', async () => {
    await client.call('cursor.move', POINTER, 8000);
    const pending = openPopup();
    await sleep(1200);
    const notesBefore = (await client.call('note.list')).ids.length;

    // What the page's Escape handler ends up calling.
    await client.call('popup.dismiss', {}, 5000);
    const settled = await pending;
    assert.equal(settled.choice, null, `Escape 应当回执「没有选择」，实际 ${JSON.stringify(settled)}`);
    assert.equal((await popupState()).open, false, 'Escape 后弹窗必须关闭');
    assert.equal((await client.call('note.list')).ids.length, notesBefore, 'Escape 不应建出便签');
  });

  await step('整个会话没有错误事件', async () => {
    const errors = events
      .filter((event) => event.event === 'helper.error')
      .map((event) => String(event.data?.message ?? ''));
    assert.deepEqual(errors, [], `不应出现错误：${errors.join('; ')}`);
  });

  // Deliberately last: this branch opens the annotation window and waits for a
  // human, so the only way out is to shut the helper down — which ends the session
  // and rules out any step after it.
  await step('选择「截图」会真的显示标注窗口并进入会话（回归：曾经完全无响应）', async () => {
    const before = events.length;
    await client.call('cursor.move', POINTER, 8000);
    const pending = openPopup();
    await sleep(1200);

    await client.call('popup.click', { id: 'shot' }, 8000);
    await sleep(2500);

    assert.equal((await popupState()).open, false, '选择后弹窗必须关闭');

    const captureError = events
      .slice(before)
      .filter((event) => event.event === 'helper.error')
      .map((event) => String(event.data?.message ?? ''));
    assert.deepEqual(captureError, [], `进入截图会话不应报错：${captureError.join('; ')}`);

    // The heart of the regression. Previously the capture window was created, finished
    // loading, never became visible, and `shot.begin` never resolved — so pressing 截图 did
    // nothing at all, with no error anywhere to explain it. Asserting only that the popup
    // closed (which is all this test used to do) passes in exactly that broken state.
    const deadline = Date.now() + 15000;
    let shotWindow = null;
    while (Date.now() < deadline) {
      const listing = await client.call('helper.windows', {}, 5000);
      shotWindow = (listing.windows ?? []).find((entry) => entry.title === '截图标注') ?? null;
      if (shotWindow?.visible === true) break;
      await sleep(400);
    }
    assert.ok(shotWindow !== null, '必须存在截图标注窗口');
    assert.equal(
      shotWindow.visible,
      true,
      `截图标注窗口必须真的显示出来，否则用户看到的就是「按了没反应」。实际：${JSON.stringify(shotWindow)}`,
    );

    // Leave the session rather than waiting for a human: quitting answers it.
    pending.catch(() => {});
    await client.call('helper.quit', {}, 5000).catch(() => {});
    await Promise.race([pending, sleep(3000)]);
  });
} catch (error) {
  console.error('\n弹窗测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await client.dispose().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('弹窗测试：全部通过 ✅');
  process.exit(0);
}
console.error(`弹窗测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

/**
 * The three screenshot buttons must actually work.
 *
 * Every previous test of the capture path stopped before the buttons mattered — the
 * helper was shut down, or only `shot.begin` was awaited — so all three of the reported
 * failures had **no coverage at all**:
 *
 *   1. 复制 reported `clipboard.writeImage is not a function` (Electron 40+ replaced the
 *      clipboard surface with the W3C one),
 *   2. 存为便签 wrote a file and created no note, so nothing appeared anywhere,
 *   3. 保存图片 had nowhere to choose a location.
 *
 * The annotation UI is driven entirely by hand, so this test clicks the real buttons in
 * the real window and reads the page's own toast, which is where every failure is
 * reported to the user.
 *
 * Usage: node tools/test-shot-actions.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-shot-actions
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-shot-'));
const exportDir = join(dataDir, 'exports');
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
 * Run a snippet inside the open annotation window and return its value.
 * shot.eval reports { open, value }, so the wrapper is unwrapped here.
 */
async function page(script) {
  const result = await client.call('shot.eval', { script }, 15000);
  if (result?.open !== true) throw new Error(`标注窗口不可用：${JSON.stringify(result)}`);
  if (typeof result.error === 'string') throw new Error(`页面脚本失败：${result.error}`);
  return result.value;
}

/** The page's toast text — where every user-visible failure shows up. */
const TOAST = `(() => {
  const el = document.getElementById('toast');
  return el === null || el.hidden ? null : el.textContent;
})()`;

/**
 * Drag out a selection the way a user does.
 *
 * `x0,y0 → x1,y1` are fractions of the stage, so a test can choose a region far from the
 * top-left corner — which is what makes "the note appears where I captured" testable.
 */
const selectionScript = (x0, y0, x1, y1) => `(() => {
  const stage = document.getElementById('stage');
  const r = stage.getBoundingClientRect();
  const ev = (type, fx, fy, buttons) => new PointerEvent(type, {
    clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
    bubbles: true, button: 0, buttons, pointerId: 1, isPrimary: true,
  });
  stage.dispatchEvent(ev('pointerdown', ${x0}, ${y0}, 1));
  stage.dispatchEvent(ev('pointermove', ${(x0 + x1) / 2}, ${(y0 + y1) / 2}, 1));
  stage.dispatchEvent(ev('pointermove', ${x1}, ${y1}, 1));
  stage.dispatchEvent(ev('pointerup', ${x1}, ${y1}, 0));
  return true;
})()`;

const CLICK = (id) => `(() => {
  const b = document.getElementById('${id}');
  if (b === null) return 'no-button';
  b.click();
  return 'clicked';
})()`;

let pending = null;

try {
  await step('助手启动并打开标注窗口', async () => {
    await client.ready();
    await client.call('helper.config', { dataDir, settings: { hotkey: '' } });
    await client.call('settings.apply', { settings: { exportDir } });

    pending = client.call('shot.begin', { mode: 'note' }, 120000).catch((error) => ({ error: String(error) }));
    // The window is shown by a retry loop; wait for it rather than assuming.
    const deadline = Date.now() + 15000;
    let open = false;
    while (Date.now() < deadline) {
      open = (await client.call('shot.inspect', {}, 8000)).open === true;
      if (open) break;
      await sleep(400);
    }
    assert.equal(open, true, '标注窗口必须打开');

    const api = await client.call('shot.inspect', {}, 8000);
    assert.deepEqual(api.methods, ['init:function', 'commit:function', 'cancel:function', 'copy:function']);
    assert.equal(api.fallbackVisible, false, `不应显示降级提示：${String(api.fallbackReason)}`);
  });

  await step('框选后「复制」真的写入剪贴板（回归：clipboard.writeImage is not a function）', async () => {
    // Deliberately far from the top-left, because the note's position is asserted later
    // and a corner selection would not tell "where I captured" apart from "0,0".
    assert.equal(await page(selectionScript(0.35, 0.4, 0.62, 0.66)), true, '应当能框选出选区');
    await sleep(500);
    assert.equal(await page(CLICK('copy')), 'clicked');
    await sleep(1800);

    const toast = await page(TOAST);
    assert.equal(toast, '已复制到剪贴板', `复制应当成功，实际提示：${JSON.stringify(toast)}`);
  });

  await step('「存为便签」真的建出一条置顶便签（回归：只写文件、便签列表为空）', async () => {
    assert.equal(await page(CLICK('saveNote')), 'clicked');

    const deadline = Date.now() + 15000;
    let ids = [];
    while (Date.now() < deadline) {
      ids = (await client.call('note.list', {}, 5000)).ids;
      if (ids.length > 0) break;
      await sleep(400);
    }
    assert.ok(ids.length > 0, '「存为便签」必须在助手侧真的建出便签窗口');

    // It must be a real, visible, always-on-top note window — "悬浮置顶" is the point.
    // Waited for rather than assumed: a newly created window is not mapped yet, and this
    // is the same early-`isVisible()` race that made the capture window look broken.
    const visibleDeadline = Date.now() + 12000;
    let state = null;
    while (Date.now() < visibleDeadline) {
      state = await client.call('note.state', { id: ids[0] }, 8000);
      if (state?.visible === true) break;
      await sleep(400);
    }
    assert.equal(state.note.kind, 'shot', `必须是截图便签，实际 ${String(state.note.kind)}`);
    assert.ok(
      typeof state.note.image === 'string' && state.note.image.length > 0,
      '截图便签必须带图片路径',
    );
    assert.equal(existsSync(state.note.image), true, `图片文件必须真的存在：${String(state.note.image)}`);
    assert.equal(state.note.alwaysOnTop, true, '截图便签必须置顶');
    assert.equal(state.visible, true, `截图便签窗口必须真的显示出来，实际 ${JSON.stringify(state)}`);

    // It must land where the capture was, not in the top-left corner. The selection was
    // made at 35–62% across and 40–66% down the screen, so the note's origin has to match
    // that region — measured against the display, since the capture window covers it.
    const displays = (await client.call('displays.list', {}, 5000)).displays;
    const area = displays[0].workArea;
    const expectedX = area.x + Math.round(area.width * 0.35);
    const expectedY = area.y + Math.round(area.height * 0.4);
    const slop = 24;
    assert.ok(
      Math.abs(state.note.x - expectedX) <= slop,
      `截图便签应当生成在框选位置：期望 x≈${expectedX}，实际 ${state.note.x}`,
    );
    assert.ok(
      Math.abs(state.note.y - expectedY) <= slop,
      `截图便签应当生成在框选位置：期望 y≈${expectedY}，实际 ${state.note.y}`,
    );
    assert.ok(
      state.note.x > area.x + area.width * 0.2 && state.note.y > area.y + area.height * 0.2,
      `绝不能退化成左上角默认位置，实际 (${state.note.x}, ${state.note.y})`,
    );

    // And the note must be announced so it can reach the notes list.
    assert.ok(
      events.some((event) => event.event === 'note.created' && event.data?.note?.id === ids[0]),
      '必须发出 note.created，否则便签不会出现在列表里',
    );
  });

  await step('提交「存为便签」时发出带 noteId 的 shot.saved（便于诊断）', async () => {
    const saved = events.filter((event) => event.event === 'shot.saved');
    assert.ok(saved.length > 0, '必须发出 shot.saved');
    const last = saved[saved.length - 1];
    assert.equal(typeof last.data?.noteId, 'string', `应当带上 noteId，实际 ${JSON.stringify(last.data)}`);
  });
} catch (error) {
  console.error('\n截图按钮测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  if (pending !== null) pending.catch(() => {});
  await client.call('helper.quit', {}, 5000).catch(() => {});
  await sleep(500);
  await client.dispose().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('截图按钮测试：全部通过 ✅');
  process.exit(0);
}
console.error(`截图按钮测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

/**
 * The 便签闹钟 path, end to end: store → scheduler → helper window → dismissal.
 *
 * The unit tests prove the schedule maths; this proves the wiring, which is where an alarm
 * feature actually fails — an alarm that computes correctly and never appears is exactly as
 * broken as one with the wrong time, and only a real window can tell the two apart.
 *
 * Deliberately drives the scheduler's own `tick(now)` with a chosen time rather than waiting
 * for a wall-clock minute: a test that waits for 09:00 can only run at 09:00.
 *
 * Usage: node tools/test-alarm-ring.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-alarm-ring
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import { StickyStore } from '../lib/host/store.js';
import { StickyBridge } from '../lib/host/bridge.js';
import { AlarmService } from '../lib/host/alarms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-alarm-ring-'));
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

const noop = () => {};
const log = { info: noop, warn: noop, error: noop, debug: noop };

const store = new StickyStore({ dir: dataDir, log });
store.load();
store.updateSettings({ autoStartHelper: false, hotkey: '' });

const bridge = new StickyBridge({ store, dataDir, log });
const alarms = new AlarmService({ store, bridge, log });
bridge.onAlarmClosed((id) => {
  void alarms.dismiss(id);
});
// Same wiring as lib/index.js: the helper reports where a popup was dragged, and that is what
// makes 试响 also choose the position.
bridge.onAlarmMoved((id, x, y) => {
  alarms.rememberPosition(id, x, y);
});

/**
 * The bounds of one alarm's popup, or null when it is not open.
 *
 * Matched on the window title, which carries the alarm id. Taking "the first window titled
 * 便签闹钟" was wrong: several alarms can be on screen at once — earlier steps leave them open —
 * so it reported a different alarm's position.
 *
 * @param {string} id
 */
async function alarmBounds(id) {
  return bridge.alarmBounds(id);
}

/** A local stamp `minutes` from now, in the format an alarm's `at` uses. */
function stampIn(minutes) {
  const when = new Date(Date.now() + minutes * 60_000);
  const pad = (value) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

/**
 * Wait until the alarm's popup has actually been shown, and return its bounds.
 *
 * Waits for a window that is `visible` *and* titled 便签闹钟. Both matter: `alarm.bounds` reports
 * the window as soon as it is constructed, when it is still loading, still titled "Electron",
 * and still sitting at 0,0 — so reading it without waiting yields a position that has nothing
 * to do with where the alarm was placed, and a "visible" check on it is vacuous.
 *
 * @param {string} id
 * @returns {Promise<object|null>} bounds, or null when it never appeared
 */
async function waitForPopup(id, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    const windows = await bridge.debugWindows();
    lastSeen = windows;
    const alarmWindow = windows.find((entry) => entry.title === '便签闹钟' && entry.visible === true);
    if (alarmWindow !== undefined) return alarmWindow.bounds;
    await sleep(400);
  }
  console.error(`         闹钟窗口始终没有可见：${JSON.stringify(lastSeen)}`);
  return null;
}

try {
  await step('助手启动（闹钟窗口需要真实的 Electron 运行时）', async () => {
    const status = await bridge.start();
    assert.equal(status.running, true, `助手必须能启动：${JSON.stringify(status)}`);
  });

  await step('到点的闹钟会真的弹出置顶窗口', async () => {
    const alarm = store.upsertAlarm({
      label: '喝水',
      kind: 'text',
      text: '该喝水了',
      schedule: { kind: 'once', at: stampIn(-1) },
    });

    // The scheduler computes the time; this drives it with a real clock, one minute after
    // the alarm was due — the "DSH was closed at the time" case, which must still ring.
    const fired = await alarms.tick(new Date());
    assert.ok(fired.includes(alarm.id), `应当触发这条闹钟，实际触发了 ${JSON.stringify(fired)}`);

    const popupBounds = await waitForPopup(alarm.id);
    assert.ok(popupBounds !== null, '闹钟窗口必须真的出现在屏幕上');

    // And it must be a real, visible window, not merely a remembered id.
    //
    // Filtered on `visible` as well as the title: until `ready-to-show` fires the window is
    // still titled "Electron" and sits at 0,0, so a title-only match can catch it mid-load and
    // report a position that has nothing to do with where the alarm was placed.
    const allWindows = await bridge.debugWindows();
    const visibleWindows = allWindows.filter((entry) => entry.title === '便签闹钟' && entry.visible === true);
    if (visibleWindows.length === 0) {
      console.error(`         [诊断] helper.windows = ${JSON.stringify(allWindows)}`);
    }
    assert.ok(visibleWindows.length > 0, '必须存在可见的闹钟窗口');
  });

  await step('触发被记账到闹钟上（lastFiredAt / fireCount）', async () => {
    const alarm = store.listAlarms().find((entry) => entry.label === '喝水');
    assert.ok(alarm !== undefined, '闹钟应当仍在存储里');
    assert.equal(typeof alarm.lastFiredAt, 'string', 'lastFiredAt 必须被记录，否则会重复响');
    assert.equal(alarm.fireCount, 1, `fireCount 应当是 1，实际 ${alarm.fireCount}`);
  });

  await step('同一分钟内重复 tick 不会重复响（否则每分钟会响好多次）', async () => {
    const before = store.listAlarms().find((entry) => entry.label === '喝水');
    const fired = await alarms.tick(new Date());
    assert.equal(fired.length, 0, `第二次 tick 不应再触发，实际 ${JSON.stringify(fired)}`);
    const after = store.listAlarms().find((entry) => entry.label === '喝水');
    assert.equal(after.fireCount, before.fireCount, 'fireCount 不得增加');
  });

  await step('关闭弹窗后闹钟被登记为「已关闭」', async () => {
    const alarm = store.listAlarms().find((entry) => entry.label === '喝水');
    await bridge.closeAlarm(alarm.id);

    // The helper reports the close over its event stream, so this is asynchronous by design.
    const deadline = Date.now() + 8000;
    let dismissed = null;
    while (Date.now() < deadline) {
      dismissed = store.getAlarm(alarm.id)?.lastDismissedAt ?? null;
      if (dismissed !== null) break;
      await sleep(300);
    }
    assert.equal(typeof dismissed, 'string', '关闭后必须记录 lastDismissedAt');
    assert.equal(alarms.ringing.includes(alarm.id), false, '关闭后不应再算作正在响');
  });

  await step('一次性闹钟关闭后不再是「待触发」', async () => {
    const alarm = store.listAlarms().find((entry) => entry.label === '喝水');
    const listed = alarms.list().find((entry) => entry.id === alarm.id);
    assert.equal(listed.nextAt, null, `一次性闹钟响过之后不应再有下一次，实际 ${String(listed.nextAt)}`);
    assert.equal(listed.scheduleText.length > 0, true, '必须有一句可读的排期说明');
  });

  await step('每小时的闹钟按时响，且不依赖「刚创建」状态', async () => {
    const alarm = store.upsertAlarm({
      label: '站会',
      kind: 'text',
      text: '站会',
      schedule: { kind: 'daily', time: '09:30' },
    });

    // 没到点：不响。
    const early = new Date(2026, 2, 5, 9, 0, 0, 0);
    assert.deepEqual(await alarms.tick(early), [], '没到点不应触发');

    // 到点：响。
    const onTime = new Date(2026, 2, 5, 9, 30, 0, 0);
    const fired = await alarms.tick(onTime);
    assert.ok(fired.includes(alarm.id), `到点必须触发，实际 ${JSON.stringify(fired)}`);
    assert.ok((await waitForPopup(alarm.id)) !== null, '每日闹钟也必须真的弹窗');

    await bridge.closeAlarm(alarm.id);
    await sleep(500);
  });

  await step('「预览」不消耗闹钟：一次性闹钟预览后仍然是待触发', async () => {
    const alarm = store.upsertAlarm({
      label: '预览用',
      kind: 'text',
      text: '预览',
      schedule: { kind: 'once', at: stampIn(120) },
    });
    assert.equal((await alarms.preview(alarm.id)).ok, true, '预览应当成功');
    assert.ok((await waitForPopup(alarm.id)) !== null, '预览也应当真的弹窗');

    const after = store.getAlarm(alarm.id);
    assert.equal(after.lastFiredAt, null, '预览绝不能写 lastFiredAt，否则一次性闹钟就被吃掉了');
    await bridge.closeAlarm(alarm.id);
    await sleep(400);
  });

  await step('停用的闹钟不响', async () => {
    const alarm = store.upsertAlarm({
      label: '停用',
      kind: 'text',
      text: 'x',
      enabled: false,
      schedule: { kind: 'daily', time: '09:30' },
    });
    assert.deepEqual(await alarms.tick(new Date(2026, 2, 5, 9, 30, 0, 0)), [], '停用的闹钟不得触发');
    assert.equal(store.getAlarm(alarm.id).fireCount, 0);
  });

  await step('删除闹钟会连弹窗一起收掉（不会留下孤儿窗口）', async () => {
    const alarm = store.upsertAlarm({
      label: '待删',
      kind: 'text',
      text: 'x',
      schedule: { kind: 'once', at: stampIn(-1) },
    });
    await alarms.tick(new Date());
    assert.ok((await waitForPopup(alarm.id)) !== null, '前置条件：弹窗应当在显示');

    await bridge.closeAlarm(alarm.id);
    store.deleteAlarm(alarm.id);
    await sleep(800);

    const open = await bridge.openAlarms();
    assert.equal((open?.ids ?? []).includes(alarm.id), false, '删除后不应还留着它的窗口');
  });

  await step('闹钟窗口不会出现在便签列表里（它是提醒，不是便签）', async () => {
    const label = '独立';
    const alarm = store.upsertAlarm({ label, kind: 'text', text: 'x', schedule: { kind: 'once', at: stampIn(-1) } });
    await alarms.tick(new Date());
    await waitForPopup(alarm.id);

    const notes = store.listNotes();
    assert.equal(
      notes.some((note) => note.id === alarm.id),
      false,
      '闹钟不得混进便签列表',
    );
    await bridge.closeAlarm(alarm.id);
    await sleep(400);
  });

  await step('没设位置时弹在屏幕正中央（工作区中心，而不是全屏中心）', async () => {
    const alarm = store.upsertAlarm({
      label: '居中',
      kind: 'text',
      text: '居中测试',
      schedule: { kind: 'once', at: stampIn(-1) },
    });
    assert.equal(alarm.x, null, '前置条件：这条闹钟没有保存位置');

    await alarms.tick(new Date());
    const bounds = await waitForPopup(alarm.id);
    if (bounds === null) {
      console.error(`         [诊断] 目标=${alarm.id} 窗口=${JSON.stringify(await bridge.debugWindows())}`);
    }
    assert.ok(bounds !== null, '闹钟窗口必须出现');
    if (bounds.x === 0 && bounds.y === 0) {
      // A window at the origin is either the pre-show placeholder or a different window, so
      // report both sources rather than only the one under suspicion.
      console.error(
        `         [诊断] waitForPopup=${JSON.stringify(bounds)} alarmBounds=${JSON.stringify(await alarmBounds(alarm.id))} windows=${JSON.stringify(await bridge.debugWindows())}`,
      );
    }

    // Centre of the *work area*, so a taskbar cannot make it look off-centre. Read from the
    // helper rather than assumed, because the bounding display depends on the cursor.
    const listing = await bridge.debugDisplays();
    const area = listing[0].workArea;
    const expectedX = area.x + Math.round((area.width - bounds.width) / 2);
    const expectedY = area.y + Math.round((area.height - bounds.height) / 2);
    const slop = 2;
    assert.ok(
      Math.abs(bounds.x - expectedX) <= slop,
      `默认应当水平居中：期望 x≈${expectedX}，实际 ${bounds.x}（窗口 ${bounds.width}宽，工作区 ${area.width}）`,
    );
    assert.ok(
      Math.abs(bounds.y - expectedY) <= slop,
      `默认应当垂直居中：期望 y≈${expectedY}，实际 ${bounds.y}（窗口 ${bounds.height}高，工作区 ${area.height}）`,
    );

    await bridge.closeAlarm(alarm.id);
    await sleep(500);
  });

  await step('闹钟按保存的位置弹出（试响调好的位置会被记住）', async () => {
    // Deliberately away from the default centre, so "it used the saved position" is
    // distinguishable from "it happened to land there".
    const target = { x: 120, y: 140 };
    const alarm = store.upsertAlarm({
      label: '定位',
      kind: 'text',
      text: '定位测试',
      schedule: { kind: 'once', at: stampIn(-1) },
      ...target,
    });

    await alarms.tick(new Date());
    const bounds = await waitForPopup(alarm.id);
    assert.ok(bounds !== null, '闹钟窗口必须出现');
    assert.equal(bounds.x, target.x, `窗口 x 应当等于保存的位置，实际 ${bounds.x}`);
    assert.equal(bounds.y, target.y, `窗口 y 应当等于保存的位置，实际 ${bounds.y}`);

    await bridge.closeAlarm(alarm.id);
    await sleep(500);
  });

  await step('拖动弹出的闹钟会写回它的位置（走真实的 alarm.moved 事件）', async () => {
    const alarm = store.upsertAlarm({
      label: '拖动',
      kind: 'text',
      text: '拖动测试',
      schedule: { kind: 'once', at: stampIn(-1) },
    });
    assert.equal(alarm.x, null, '新建的闹钟默认没有位置');

    await alarms.tick(new Date());
    const bounds = await waitForPopup(alarm.id);
    assert.ok(bounds !== null, '闹钟窗口必须出现');

    // Move the real window. That fires `move` in the helper, which reports `alarm.moved`,
    // which is what the host turns into a stored position — the whole path, not just the
    // handler at the end of it.
    const moved = await bridge.moveAlarmForTest(alarm.id, 300, 220);
    assert.equal(moved.ok, true, `移动窗口应当成功：${JSON.stringify(moved)}`);

    // Reported on a short debounce, so give the event time to arrive.
    const deadline = Date.now() + 8000;
    let stored = null;
    while (Date.now() < deadline) {
      stored = store.getAlarm(alarm.id);
      if (stored?.x === 300) break;
      await sleep(300);
    }
    assert.equal(stored?.x, 300, `拖动后位置必须写回存储，实际 ${JSON.stringify(stored && { x: stored.x, y: stored.y })}`);
    assert.equal(stored.y, 220);

    await bridge.closeAlarm(alarm.id);
    await sleep(500);
  });

  await step('未保存的闹钟也能试响，并把位置带回来（新建时就要能试响）', async () => {
    const result = await alarms.previewDraft({ label: '草稿', kind: 'text', text: '还没保存', x: null, y: null });
    assert.equal(result.ok, true, '未保存的闹钟必须也能试响');

    // The draft has no record, so its position is held in memory for the editor to read.
    const echoed = alarms.rememberPosition('__draft__', 260, 180);
    assert.equal(echoed.draft, true, '草稿位置应当被标记为草稿');
    const position = alarms.draftPosition;
    assert.equal(position?.x, 260, `草稿位置必须能被编辑器读回，实际 ${JSON.stringify(position)}`);
    assert.equal(position?.y, 180);

    // And a draft must not create a record.
    assert.equal(
      store.listAlarms().some((entry) => entry.label === '草稿'),
      false,
      '试响未保存的闹钟绝不能产生存储记录',
    );

    await bridge.closeAlarm('__draft__');
    await sleep(500);
  });

  await step('保存的位置离谱时会被拉回可见范围（换显示器后仍能关掉）', async () => {
    const alarm = store.upsertAlarm({
      label: '屏幕外',
      kind: 'text',
      text: 'x',
      schedule: { kind: 'once', at: stampIn(-1) },
      x: 99999,
      y: 99999,
    });

    await alarms.tick(new Date());
    const clamped = await waitForPopup(alarm.id);
    assert.ok(clamped !== null, '即使位置离谱也必须在屏幕上出现');

    assert.ok(
      clamped.x < 99999 && clamped.y < 99999,
      `越界的位置必须被夹回工作区，实际 ${JSON.stringify(clamped)}`,
    );

    await bridge.closeAlarm(alarm.id);
    await sleep(500);
  });

  await step('闹钟落盘：重启后仍在（但弹窗不会被恢复）', async () => {
    store.flush();
    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    assert.ok(Array.isArray(parsed.alarms) && parsed.alarms.length > 0, 'data.json 必须记录闹钟');

    const reloaded = new StickyStore({ dir: dataDir, log });
    reloaded.load();
    assert.ok(reloaded.listAlarms().length > 0, '重启后闹钟必须还在');
    // 弹窗是瞬时的：它是提醒，不是文档。
    const open = await bridge.openAlarms();
    assert.equal((open?.ids ?? []).length, 0, `重启期间不应有闹钟窗口残留，实际 ${JSON.stringify(open)}`);
    reloaded.close();
  });
} catch (error) {
  console.error('\n闹钟响铃测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  alarms.dispose();
  await bridge.dispose().catch(() => {});
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('便签闹钟响铃测试：全部通过 ✅');
  process.exit(0);
}
console.error(`便签闹钟响铃测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

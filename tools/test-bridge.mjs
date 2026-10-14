/**
 * Exercise the production Host path: `StickyBridge` + `StickyStore` end to end.
 *
 * Every other test drives the Electron helper through `ElectronHelperClient`
 * directly, which leaves the layer DSH actually calls untested — the part that
 * decides when to spawn the helper, restores the note set on startup, and mirrors
 * helper events back into the store. Those are exactly the behaviours feature 3
 * ("restart DSH and the notes come back where they were") depends on.
 *
 * Uses a temporary data directory, so it never touches the user's real notes.
 *
 * Usage: node tools/test-bridge.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-bridge
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import { StickyBridge } from '../lib/host/bridge.js';
import { StickyStore } from '../lib/host/store.js';
import { findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-bridge-'));
const failures = [];
const logs = [];

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
const log = {
  info: (m) => logs.push(`info: ${m}`),
  warn: (m) => logs.push(`warn: ${m}`),
  error: (m) => logs.push(`error: ${m}`),
};

const store = new StickyStore({ dir: dataDir, log: () => {} });
store.load();
// A short auto-hide delay so the collapse is observable inside one test run;
// the default 1.2s would also work but makes the wait tighter than necessary.
store.updateSettings({ autoStartHelper: false, autoHideDelayMs: 800, snapDistance: 24 });

const bridge = new StickyBridge({ store, dataDir, log });

console.log(`临时数据目录：${dataDir}\n`);

try {
  console.log('[1] 启动助手（与 host 启动插件后走的同一条路径）');
  await step('bridge.start() 拉起助手并完成 helper.config', async () => {
    const status = await bridge.start();
    assert.equal(status.running, true, `助手应当运行：${JSON.stringify(status)}`);
    assert.equal(bridge.available, true, 'available 必须为 true');
    assert.ok(status.electronPath !== null, '必须记录 Electron 路径');
    assert.equal(status.error, null, `不应有错误：${String(status.error)}`);
  });

  await step('助手持有数据目录锁（helper.lock 记录本进程）', async () => {
    const lockFile = join(dataDir, 'helper.lock');
    assert.ok(existsSync(lockFile), 'helper.lock 必须已建立');
    const pid = Number.parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
    assert.ok(Number.isInteger(pid) && pid > 0, '锁文件必须记录一个 pid');
  });

  await step('displays 探测可用（设置页诊断用）', async () => {
    const result = await bridge.displays();
    assert.ok(Array.isArray(result.displays) && result.displays.length >= 1, '必须能看到显示器');
  });

  console.log('\n[2] 新建便签 → 事件回写存储（功能三的核心链路）');
  let noteId = null;
  /** The hotkey-created draft used by the 「保存才入库」 group below. */
  let draftNoteId = null;
  await step('openNote() 建出真实窗口', async () => {
    const note = store.upsertNote({ kind: 'text', text: '桥接测试', x: 2, y: 260, width: 240, height: 180 });
    noteId = note.id;
    const result = await bridge.openNote(noteId);
    assert.equal(result.ok, true, `应当打开成功：${JSON.stringify(result)}`);
    // 「打开」 focuses the note on purpose — the user asked to see it. Auto-hide is
    // suppressed while a note holds focus, so stand in for a user who has looked away;
    // otherwise the steps below would be asserting against that deliberate behaviour.
    await bridge.blurNote(noteId);
  });

  await step('助手把「吸附到左边缘」回写成存储里的 edge（经事件循环，非直接调用）', async () => {
    const deadline = Date.now() + 20000;
    let stored = null;
    while (Date.now() < deadline) {
      stored = store.getNote(noteId);
      if (stored !== null && typeof stored.edge === 'string' && stored.edge.length > 0) break;
      await sleep(300);
    }
    assert.ok(stored !== null, '便签必须仍在存储里');
    assert.equal(stored.edge, 'left', `存储里的 edge 应当是 left，实际 ${String(stored.edge)}`);
  });

  await step('助手把「自动收起」回写成存储里的 hidden=true', async () => {
    const deadline = Date.now() + 20000;
    let stored = null;
    while (Date.now() < deadline) {
      stored = store.getNote(noteId);
      if (stored?.hidden === true) break;
      await sleep(300);
    }
    if (stored?.hidden !== true) {
      // Auto-hide is suppressed while the note holds focus, so report that state
      // explicitly instead of only "hidden was false".
      const live = await bridge.debugNoteState(noteId).catch((error) => ({ error: String(error) }));
      console.error(`        windowFocused=${live?.focused} webFocused=${live?.webFocused} edge=${live?.note?.edge}`);
      throw new Error(`存储里的 hidden 必须是 true。窗口实况：${JSON.stringify(live)}`);
    }
  });

  await step('存储已落盘且保留真实尺寸（不是小标签的 36px）', async () => {
    // `flushSoon` writes discrete changes within ~20ms; allow a little slack.
    await sleep(400);
    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    const note = parsed.notes.find((entry) => entry.id === noteId);
    assert.ok(note !== undefined, 'data.json 里必须有这条便签');
    assert.equal(note.hidden, true, 'data.json 必须记录 hidden');
    assert.equal(note.edge, 'left', 'data.json 必须记录 edge');
    assert.equal(note.width, 240, `必须保留真实宽度 240，实际 ${note.width}`);
  });

  console.log('\n[2b] 「保存才入库」：快捷键便签是草稿，未保存不进列表');
  await step('快捷键新建的便签是草稿：立刻不在存储里（回归：曾被当场登记）', async () => {
    // The hotkey path, exactly: the helper builds the note itself and returns it.
    const created = await bridge.showPopup({ forcedChoice: 'new-note' });
    assert.equal(created.choice, 'new-note', `应当走新建分支：${JSON.stringify(created)}`);
    const draftId = created.note?.id;
    assert.ok(typeof draftId === 'string' && draftId.length > 0, '应当回执新建的便签');

    // Give the event loop every chance to (wrongly) deliver a `note.created`.
    await sleep(1200);
    assert.equal(
      store.getNote(draftId),
      null,
      `未保存的草稿绝不能出现在存储里（便签列表读的就是存储）；实际：${JSON.stringify(store.getNote(draftId))}`,
    );

    // And it must not be in the persisted file either — that is what a restart reads.
    await sleep(300);
    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    assert.equal(
      parsed.notes.some((entry) => entry.id === draftId),
      false,
      '草稿绝不能写进 data.json',
    );

    draftNoteId = draftId;
  });

  await step('在草稿里输入仍然不入库（自动保存不等于登记）', async () => {
    // The debounced auto-save shares the `note:save` channel with the real 「保存」
    // button, so this is the case that decides whether typing files the note.
    await bridge.pushNote(draftNoteId, { text: '草稿内容', title: '草稿标题' });
    await sleep(900);
    assert.equal(store.getNote(draftNoteId), null, '自动保存过的草稿仍然不能进存储');

    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    assert.equal(
      parsed.notes.some((entry) => entry.id === draftNoteId),
      false,
      '自动保存过的草稿也不能写进 data.json',
    );
  });

  await step('点「保存」后立刻入库，且带回已输入的内容', async () => {
    const committed = await bridge.commitDraft(draftNoteId);
    assert.equal(committed.ok, true, `登记草稿应当成功：${JSON.stringify(committed)}`);

    const stored = store.getNote(draftNoteId);
    assert.ok(stored !== null, '保存后必须进入存储，否则便签列表看不到它');
    assert.equal(stored.text, '草稿内容', '入库时必须带上已输入的内容');
    assert.equal(stored.title, '草稿标题', '入库时必须带上标题');

    // Persisted, not just in memory: a restart must find it.
    await sleep(400);
    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    assert.equal(
      parsed.notes.some((entry) => entry.id === draftNoteId),
      true,
      '保存后必须落盘',
    );

    // Idempotent: a second save must not duplicate or resurrect anything.
    const again = await bridge.commitDraft(draftNoteId);
    assert.equal(again.ok, true, '重复登记应当无害');
    assert.equal(
      store.listNotes().filter((entry) => entry.id === draftNoteId).length,
      1,
      '重复登记不得产生第二条记录',
    );

    await bridge.closeNote(draftNoteId);
  });

  console.log('\n[2c] 拖动过的便签仍会自动隐藏（回归：拖到边缘后长时间不隐藏）');
  await step('像用户那样逐帧拖动到左边缘后，便签必须自己隐藏', async () => {
    // Reproduces the reported bug: a *newly created* note dragged to the edge never
    // hid, while one reopened from the list did. Cause: the renderer reports its
    // position on every animation frame of a drag, and counting those as "the user is
    // working in this note" kept it engaged, so the auto-hide postponed itself for as
    // long as that window lasted.
    const created = await bridge.showPopup({ forcedChoice: 'new-note' });
    const draggedId = created.note?.id;
    assert.ok(typeof draggedId === 'string' && draggedId.length > 0, '应当建出便签');

    // Move it to the left edge the way the renderer does — many small steps, which is
    // what produced the flood of updates.
    for (let x = 400; x >= 0; x -= 20) {
      await bridge.setBoundsForTest(draggedId, { x, y: 300 });
      await sleep(16);
    }
    await bridge.setBoundsForTest(draggedId, { x: 0, y: 300 });

    const deadline = Date.now() + 25000;
    let live = null;
    while (Date.now() < deadline) {
      live = await bridge.debugNoteState(draggedId);
      if (live?.note?.hidden === true) break;
      await sleep(300);
    }
    assert.equal(
      live?.note?.hidden,
      true,
      `拖动到边缘的便签必须自动隐藏。实况：${JSON.stringify(live)}`,
    );
    assert.equal(live.note.edge, 'left', `应当吸附到左边缘，实际 ${String(live.note.edge)}`);

    await bridge.closeNote(draggedId);
  });

  console.log('\n[3] 模拟「重启 DSH」：新 store + 新 bridge 恢复隐藏便签');
  await step('新 bridge 启动后按存储恢复便签（含隐藏态）', async () => {
    const before = store.listNotes();
    assert.equal(before.length, 2, `应当有 2 条便签待恢复（吸附那条 + 保存过的草稿），实际 ${before.length}`);

    // Release the first helper so its lock is free, exactly as a DSH exit would.
    await bridge.dispose();
    assert.equal(bridge.available, false, '释放后 available 必须为 false');

    // A fresh store + bridge is what the next DSH start looks like.
    const store2 = new StickyStore({ dir: dataDir, log: () => {} });
    store2.load();
    const restored = store2.getNote(noteId);
    assert.ok(restored !== null, '重启后存储必须仍能读到这条便签');
    assert.equal(restored.hidden, true, '重启后必须仍是隐藏态（这是功能三的验收点）');
    assert.equal(restored.edge, 'left', '重启后必须仍记得吸附在哪条边');
    assert.equal(restored.width, 240, '重启后必须记得真实尺寸');

    const bridge2 = new StickyBridge({ store: store2, dataDir, log });
    try {
      const status = await bridge2.start();
      assert.equal(status.running, true, `第二个助手应当能启动（锁已释放）：${JSON.stringify(status)}`);
      // `start()` internally calls note.reconcile with the stored set; a note that
      // fails to restore would surface as a helper error rather than a throw.
      const errors = logs.filter((line) => line.startsWith('error:'));
      assert.deepEqual(errors, [], `恢复过程中不应出现错误日志：${errors.join(' | ')}`);
    } finally {
      await bridge2.dispose();
    }
  });

  console.log('\n[4] 干净停止');
  await step('dispose() 后锁被释放，助手不再运行', async () => {
    await bridge.dispose();
    await sleep(800);
    assert.equal(bridge.available, false, '停止后 available 必须为 false');
    const status = await bridge.start().catch(() => null);
    if (status !== null) await bridge.dispose();
  });
} catch (error) {
  console.error('\n桥接测试异常终止：', error);
  failures.push('未捕获异常');
} finally {
  await bridge.dispose().catch(() => {});
  try {
    store.close();
  } catch {
    /* ignore */
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('Host 桥接集成测试：全部通过 ✅');
  process.exit(0);
}
console.error(`Host 桥接集成测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

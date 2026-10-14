/**
 * Does the real hide/reveal cycle work in both hide modes?
 *
 * The geometry tests prove the arithmetic; only a real window proves that Electron
 * accepts the resulting bounds, that a note can genuinely sit outside the display,
 * and that the reveal zone the pointer must reach is actually on screen — which is
 * the difference between "hidden" and "lost".
 *
 * Measured here on Windows: `offscreen` parks a 260px note at `x = -259` with
 * exactly 1px visible, and `tab` leaves a 36x120 handle at `x = 0`. Both slide back
 * to the full 260x200 on demand. This is the evidence behind the default.
 *
 * Usage: node tools/test-hide-modes.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-hide-modes
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { ElectronHelperClient, findElectron } from '../lib/host/runtime.js';
import { revealZone, hiddenBounds, displayFor } from '../lib/host/geometry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时。');
  process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-hidemode-'));
const client = new ElectronHelperClient({
  exe: runtime.path,
  script: join(ROOT, 'electron', 'main.mjs'),
  cwd: join(ROOT, 'electron'),
  log: () => {},
  handshakeTimeoutMs: 40000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;

try {
  await client.ready();
  await client.call('helper.config', { dataDir, settings: { hotkey: '' } });
  const displays = (await client.call('displays.list')).displays;
  const workArea = displays[0].workArea;
  console.log(`工作区：x=${workArea.x} y=${workArea.y} ${workArea.width}x${workArea.height}\n`);

  for (const mode of ['offscreen', 'tab']) {
    console.log(`--- hideMode = ${mode} ---`);
    await client.call('settings.apply', {
      settings: { hideMode: mode, autoHideDelayMs: 500, snapDistance: 24, revealDelayMs: 0 },
    });

    const id = `hidemode-${mode}`;
    const note = { id, kind: 'text', text: mode, x: 2, y: 300, width: 260, height: 200 };
    await client.call('note.create', { note, settings: { hideMode: mode, autoHideDelayMs: 500, snapDistance: 24 } });

    // Wait for the note to snap to the left edge and then hide on its own.
    //
    // Generous on purpose: this is an observed-timeout, not a performance assertion.
    // The auto-hide is a 120ms timer, but this test starts its own Electron helper and
    // runs alongside the rest of the suite, so a starved event loop can stretch the
    // gesture settle (220ms) plus the hide past a tight bound. Measured flaky at 12s
    // under full-suite load.
    let hidden = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const state = await client.call('note.get', { id });
      if (state?.note?.hidden === true && state.bounds !== null) {
        hidden = state;
        break;
      }
      await sleep(300);
    }

    if (hidden === null) {
      // Report why, not just that it failed — a note that refuses to hide has several
      // distinct causes and they are indistinguishable from the outside.
      const live = await client.call('note.state', { id }).catch((error) => ({ error: String(error) }));
      const wins = await client.call('helper.windows', {}, 5000).catch(() => null);
      console.log(`  失败：便签没有自动隐藏`);
      console.log(`    note.state: ${JSON.stringify(live)}`);
      console.log(`    windows: ${JSON.stringify(wins?.windows ?? null)}`);
      failed = true;
      await client.call('note.remove', { id });
      continue;
    }

    const bounds = hidden.bounds;
    const left = Math.max(bounds.x, workArea.x);
    const right = Math.min(bounds.x + bounds.width, workArea.x + workArea.width);
    const top = Math.max(bounds.y, workArea.y);
    const bottom = Math.min(bounds.y + bounds.height, workArea.y + workArea.height);
    const visibleW = Math.max(0, right - left);
    const visibleH = Math.max(0, bottom - top);
    const visibleArea = visibleW * visibleH;
    const pct = ((visibleArea / (bounds.width * bounds.height)) * 100).toFixed(1);

    console.log(`  edge=${hidden.note.edge}  实际窗口 x=${bounds.x} y=${bounds.y} ${bounds.width}x${bounds.height}`);
    console.log(`  留在屏内的部分：${visibleW}x${visibleH}（${pct}% 的窗口面积）`);

    // What the pointer has to reach, computed from the same note state.
    const zone = revealZone(
      { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, edge: hidden.note.edge },
      workArea,
      undefined,
      mode,
    );
    const zoneOnScreen =
      zone !== null &&
      zone.x < workArea.x + workArea.width &&
      zone.x + zone.width > workArea.x &&
      zone.y < workArea.y + workArea.height &&
      zone.y + zone.height > workArea.y;
    console.log(`  感应区 ${JSON.stringify(zone)}  与工作区相交：${zoneOnScreen ? '是' : '否'}`);

    if (mode === 'offscreen') {
      const ok = visibleW === 1 && visibleH >= 100 && bounds.width === 260 && zoneOnScreen;
      console.log(
        `  判定：${ok ? '通过' : '失败'}（期望：宽度 260 不变、留在屏内恰好 1px、感应区在工作区内）`,
      );
      if (!ok) failed = true;
    } else {
      const ok = bounds.width === 36 && visibleW === 36 && zoneOnScreen;
      console.log(`  判定：${ok ? '通过' : '失败'}（期望：收成 36px 宽的小标签、完全在屏内、感应区在工作区内）`);
      if (!ok) failed = true;
    }

    // Reveal again and confirm the note returns to real size and position.
    //
    // Pinned first, on purpose. The pointer is not on this note, so a revealed note is
    // *supposed* to hide itself again shortly — and an earlier version of this test just
    // slept 500ms and then asserted, which raced that (correct) re-hide and failed about
    // one run in seven. Pinning takes the auto-hide out of the picture so the assertion
    // is about the reveal, which is what this test is for.
    await client.call('note.setPinned', { id, pinned: true });
    await sleep(300);
    await client.call('note.setHidden', { id, hidden: false });
    await sleep(500);
    const shown = await client.call('note.get', { id });
    const backOk = shown.note.hidden === false && shown.bounds.width === 260 && shown.bounds.x >= workArea.x;
    if (!backOk) {
      console.log(`    弹回失败诊断：after=${JSON.stringify(shown.note)} bounds=${JSON.stringify(shown.bounds)}`);
      console.log(`    windows=${JSON.stringify((await client.call('helper.windows', {}, 5000))?.windows ?? null)}`);
    }
    // Hand it back to normal edge behaviour before the next mode runs.
    await client.call('note.setPinned', { id, pinned: false });
    console.log(`  弹回：x=${shown.bounds.x} ${shown.bounds.width}x${shown.bounds.height} → ${backOk ? '通过' : '失败'}`);
    if (!backOk) failed = true;

    await client.call('note.remove', { id });
    await sleep(300);
    console.log('');
  }
} catch (error) {
  console.error('探针异常：', error);
  failed = true;
} finally {
  await client.dispose().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed ? '隐藏模式测试：存在问题 ❌' : '隐藏模式测试：两种模式都正常 ✅');
process.exit(failed ? 1 : 0);

/**
 * The popup window must lay out correctly at its fixed size.
 *
 * Every other popup test checks behaviour; none of them would notice a clipped row
 * or a missing background, because the popup is a transparent frameless window sized
 * to `POPUP_WIDTH x POPUP_HEIGHT` — content that overflows is silently cut off.
 *
 * Runs `tools/render-popup.mjs` in its own Electron process.
 *
 * Usage: node tools/test-popup-appearance.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-popup-appearance
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}

const outDir = mkdtempSync(join(tmpdir(), 'sticky-popup-render-'));

const result = await new Promise((resolve) => {
  const child = spawn(runtime.path, [join(HERE, 'render-popup.mjs'), outDir], {
    // Electron refuses to start as Node's child while this is inherited.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    out += chunk;
  });
  let err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    err += chunk;
  });
  child.on('exit', (code) => resolve({ code, out, err }));
});

const lines = result.out.split('\n').filter((line) => line.trim().length > 0);
for (const line of lines) console.log(`  ${line}`);

console.log(`\n${'─'.repeat(62)}`);
if (result.code === 0) {
  console.log('弹窗外观检查：通过 ✅');
  console.log(`（截图：${join(outDir, 'popup.png')}）`);
  process.exit(0);
}

console.error('弹窗外观检查：失败 ❌');
const noise = result.err
  .split('\n')
  .filter((line) => line.trim().length > 0 && !/cache_util_win|disk_cache|gpu_disk_cache|Unable to (move|create)/.test(line));
for (const line of noise.slice(0, 6)) console.error(`  ${line}`);
process.exit(1);

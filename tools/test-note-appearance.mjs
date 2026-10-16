/**
 * Appearance check for the note window, across every palette case.
 *
 * Runs `tools/render-note.mjs` once per case in its own Electron process and
 * fails if any case renders text that does not match its configured colour, or
 * falls below the WCAG contrast floor.
 *
 * This exists because the two defects that actually reached the user were both
 * *visual*: a hidden tab that was 36px instead of 10, and a black note whose
 * title-bar buttons were drawn in the hard-coded dark fallback. Neither is
 * visible to a logic test — only to a rendered window.
 *
 * Usage: node tools/test-note-appearance.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-note-appearance
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const runtime = findElectron();
if (runtime === null) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}

/** Must match the case table in `tools/render-note.mjs`. */
const CASES = ['default-black', 'classic-yellow', 'blue', 'dark-ink-on-black'];

const outDir = mkdtempSync(join(tmpdir(), 'sticky-appearance-'));
const failures = [];

/** Run one case and capture its verdict. */
function runCase(name) {
  return new Promise((resolve) => {
    const child = spawn(runtime.path, [join(HERE, 'render-note.mjs'), name, outDir], {
      // Electron refuses to start as Node's child when this is inherited.
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
    child.on('exit', (code) => {
      const lines = out.split('\n').filter((line) => line.trim().length > 0);
      resolve({ name, code, lines, err });
    });
  });
}

console.log(`Electron 运行时：${runtime.path}\n`);

for (const name of CASES) {
  const result = await runCase(name);
  const verdict = result.lines.find((line) => line.includes('外观检查')) ?? '(无结论)';
  if (result.code === 0) {
    console.log(`  [通过] ${name} — ${verdict.trim()}`);
  } else {
    console.error(`  [失败] ${name}`);
    for (const line of result.lines) console.error(`         ${line}`);
    const noise = result.err
      .split('\n')
      .filter((line) => line.trim().length > 0 && !/cache_util_win|disk_cache|gpu_disk_cache|Unable to (move|create)/.test(line));
    for (const line of noise.slice(0, 5)) console.error(`         ${line}`);
    failures.push(name);
  }
  const shot = join(outDir, `${name}.png`);
  if (existsSync(shot)) console.log(`         截图：${shot}`);
}

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log('便签外观检查：全部通过 ✅');
  console.log(`（截图保留在 ${outDir}，可自行查看；如需清理请删除该目录）`);
  process.exit(0);
}
console.error(`便签外观检查：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

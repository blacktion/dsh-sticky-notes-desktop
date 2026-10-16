/**
 * Verify that the first drag after typing actually moves the note.
 *
 * See `tools/note-drag-runner.mjs` for what was wrong and how it is checked. This file only hosts the
 * run: the Electron side writes its verdict to a temporary file, and this reads it back.
 *
 * ## Why the runner does not simply print
 *
 * It did, and it broke. `stdio: 'inherit'` hands Electron's stdout straight to the parent's pipe, and
 * when that pipe closes early the write raises `EPIPE` **inside the Electron main process** — which
 * responds with a modal crash dialog and waits there forever. A harness that can hang the machine when
 * a pipe closes is worse than no harness, so the runner accumulates its output and writes it to a file
 * that this wrapper reads after the child has exited.
 *
 * Usage: node tools/test-note-drag-focus.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-note-drag-focus
 */
import { spawn } from 'node:child_process';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findElectron } from '../lib/host/runtime.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_FILE = join(HERE, '.note-drag-result.json');

const runtime = findElectron();
if (runtime === null || runtime.path === undefined) {
  console.log('跳过：未找到 Electron 运行时（可用 DSH_STICKY_NOTES_ELECTRON 指定）。');
  process.exit(0);
}

console.log(`Electron 运行时：${runtime.path}\n`);

// Stale results from an interrupted run must not be mistaken for this run's verdict.
if (existsSync(RESULT_FILE)) rmSync(RESULT_FILE, { force: true });

const child = spawn(runtime.path, [join(HERE, 'note-drag-runner.mjs'), RESULT_FILE], {
  // Electron refuses to start as Node's child when this is inherited.
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  // The child must not be able to write to us: see the note above about EPIPE.
  stdio: ['ignore', 'ignore', 'ignore'],
});

/** Print the runner's verdict and exit with its code. */
const report = () => {
  if (!existsSync(RESULT_FILE)) {
    console.error('运行未产生结果文件 —— Electron 进程可能没有正常启动。');
    process.exit(1);
  }
  let result;
  try {
    result = JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
  } catch (error) {
    console.error(`结果文件无法解析：${error.message}`);
    process.exit(1);
  }
  rmSync(RESULT_FILE, { force: true });
  for (const line of result.lines ?? []) console.log(line);
  process.exit(result.code ?? 1);
};

child.on('error', (error) => {
  console.error(`无法启动 Electron：${error.message}`);
  process.exit(1);
});

child.on('exit', () => {
  // Electron can report a non-zero code while unwinding its own teardown after `app.exit(0)`, so the
  // runner's own verdict decides — which is exactly why it is written to a file.
  report();
});

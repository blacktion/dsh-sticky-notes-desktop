/**
 * Resolve `electron` to a stub module, so module-scope code can be imported and executed in plain Node.
 *
 * `electron/notes.mjs` imports Electron at module scope, so a fake cannot be injected afterwards —
 * importing it in Node throws `Cannot find module 'electron'` before any of its code runs. A resolve
 * hook is the one place to intervene.
 *
 * The stub source is written to `<this file>.electron-stub-source.mjs` by `tools/test-notes-runtime.mjs`
 * just before it registers this hook, and removed once the import finishes. Keeping the source next to
 * its assertions means the stub and the test that depends on it cannot drift apart.
 *
 * @module dsh-sticky-notes-desktop/tools/electron-stub-loader
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUB_FILE = fileURLToPath(new URL('.electron-stub-source.mjs', import.meta.url));

/** A data: URL keeps the stub out of the filesystem's module graph. */
const stubUrl = `data:text/javascript;base64,${Buffer.from(readFileSync(STUB_FILE, 'utf8'), 'utf8').toString('base64')}`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: stubUrl, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}

/**
 * Read the names an *installed* browser bundle will actually show.
 *
 * `test-client-load.mjs` proves the repo's bundle says the right thing, but after an install the
 * bytes that matter are the ones in `node_modules`. A `link:` install makes those the same file,
 * a tarball install does not — so this reads the resolved path and reports what the sidebar and
 * the settings page will be labelled.
 *
 *   node tools/read-installed-name.mjs <profileDir> <packageName>
 *
 * @module dsh-sticky-notes-desktop/tools/read-installed-name
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const [, , profileDirArg, packageNameArg] = process.argv;
const profileDir = profileDirArg ?? '.';
const packageName = packageNameArg ?? 'dsh-sticky-notes-desktop';

const require = createRequire(join(profileDir, 'package.json'));
const packageDir = dirname(require.resolve(`${packageName}/package.json`));
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const clientRel = manifest.exports['./client'].default ?? manifest.exports['./client'];
const clientPath = join(packageDir, clientRel);
const source = readFileSync(clientPath, 'utf8');

// A minimal stand-in for the browser, just enough for the bundle to register its slots.
const registered = [];
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__definition = definition;
    },
  },
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
  head: { appendChild() {}, append() {} },
  addEventListener() {},
};

// eslint-disable-next-line no-eval -- the bundle is a classic script; this is how DSH runs it.
eval(source);

const React = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: () => ({}),
  useMemo: (fn) => fn(),
};
const ctx = {
  get: (name) =>
    name === 'locale' ? { register() {}, bind: () => (key) => key, getSnapshot: () => ({ active: 'zh' }) } : undefined,
  effect: (fn) => {
    if (typeof fn === 'function') fn();
  },
  inject: () => {},
  slots: {
    inject: (_slot, fn) => fn(),
    register: (descriptor) => {
      registered.push({
        slot: descriptor.name,
        label: typeof descriptor.label === 'function' ? descriptor.label() : descriptor.label,
      });
      return () => {};
    },
  },
  logger: { info() {}, warn() {}, error() {} },
};

globalThis.__definition
  .factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected module request: ${name}`);
  })
  .apply(ctx);

console.log(`包目录      ${packageDir}`);
console.log(`浏览器半    ${clientRel}`);
console.log(`包名        ${manifest.name}`);
for (const entry of registered) {
  if (entry.label !== undefined) console.log(`  ${entry.slot.padEnd(20)} 「${entry.label}」`);
}

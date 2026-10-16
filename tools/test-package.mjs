/**
 * Verify the package contract the way DSH's loader resolves it.
 *
 * A plugin bundle is discovered through `package.json`: `main` for the Host half,
 * `exports["./client"]` for the browser half, and `dsh.bundle.patch` for the patch
 * that mounts it. Getting any of these wrong fails at load time in a way that is
 * painful to debug from the DSH log, so it is checked here first.
 *
 * Usage: node tools/test-package.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-package
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ------------------------------------------------------- default note size ==
//
// `electron/note.js` runs as a plain classic script in a sandboxed renderer, so it cannot import the
// shared constants — it has to spell the default size out. That is a real duplication, and a duplication
// with no test is a duplication that drifts. This is the test.
{
  const geometry = await import(pathToFileURL(resolve(ROOT, 'lib/host/geometry.js')).href);
  const noteSource = readFileSync(resolve(ROOT, 'electron/note.js'), 'utf8');
  const match = noteSource.match(/const DEFAULT_NOTE = \{[\s\S]*?width:\s*(\d+),\s*\n\s*height:\s*(\d+),/);
  assert.ok(match !== null, 'electron/note.js 里应能找到 DEFAULT_NOTE 的 width/height');
  assert.equal(
    Number(match[1]),
    geometry.DEFAULT_NOTE_WIDTH,
    `note.js 的默认宽度 ${match[1]} 与 geometry.js 的 ${geometry.DEFAULT_NOTE_WIDTH} 不一致`,
  );
  assert.equal(
    Number(match[2]),
    geometry.DEFAULT_NOTE_HEIGHT,
    `note.js 的默认高度 ${match[2]} 与 geometry.js 的 ${geometry.DEFAULT_NOTE_HEIGHT} 不一致`,
  );
}

// ------------------------------------------------------------- manifest ==

assert.equal(pkg.name, 'dsh-sticky-notes-desktop', 'name 必须与 cordis.patch.yml 的 name 一致');
assert.ok(typeof pkg.main === 'string', 'main 必须存在（Host 半入口）');

const hostEntry = resolve(ROOT, pkg.main);
assert.ok(existsSync(hostEntry), `Host 入口不存在：${pkg.main}`);

const clientEntry = pkg.exports?.['./client']?.default;
assert.ok(typeof clientEntry === 'string', 'exports["./client"].default 必须存在（浏览器半入口）');
const clientPath = resolve(ROOT, clientEntry);
assert.ok(existsSync(clientPath), `浏览器入口不存在：${clientEntry}`);

// The browser half is served as ONE self-contained file, so it must not import.
const bundleSource = readFileSync(clientPath, 'utf8');
assert.ok(
  !/^\s*import\s/m.test(bundleSource) && !/^\s*export\s/m.test(bundleSource),
  '浏览器 bundle 必须是经典脚本（不得含 import/export）',
);
assert.ok(bundleSource.includes('__ModuleLoader__.load'), '浏览器 bundle 必须调用 window.__ModuleLoader__.load');
assert.ok(bundleSource.includes("id: 'dsh-sticky-notes-desktop'"), 'bundle 的 id 必须等于包名');

// The patch is what actually mounts the plugin.
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向补丁文件');
const patchPath = resolve(ROOT, 'cordis.patch.yml');
assert.ok(existsSync(patchPath), 'cordis.patch.yml 不存在');
const patch = readFileSync(patchPath, 'utf8');
assert.ok(patch.includes('insert:'), '补丁必须包含 insert 段');
assert.ok(patch.includes("name: 'dsh-sticky-notes-desktop'"), '补丁里的 name 必须与 package.json 一致');
assert.ok(patch.includes('id: sticky-notes'), '补丁必须声明 entry id');

// Electron helper assets must ship with the package.
assert.ok(pkg.files.includes('electron'), 'files 必须包含 electron 目录');
for (const asset of ['main.mjs', 'preload-note.cjs', 'note.html', 'preload-shot.cjs', 'shot.html', 'package.json']) {
  assert.ok(existsSync(join(ROOT, 'electron', asset)), `electron/${asset} 缺失`);
}

// --------------------------------------------------------- host entry ==

const module = await import(pathToFileURL(hostEntry).href);
assert.equal(module.name, 'sticky-notes', 'Host 半必须导出 name');
assert.equal(typeof module.apply, 'function', 'Host 半必须导出 apply');
assert.ok(Array.isArray(module.inject), 'Host 半必须导出 inject 数组');

// `apply` must survive a hostile context: DSH marks an entry FAILED when a plugin
// callback throws, so apply has to swallow everything.
const calls = [];
const hostileCtx = {
  logger: {
    info: (m) => calls.push(m),
    warn: (m) => calls.push(m),
    error: (m) => calls.push(m),
  },
  get() {
    throw new Error('service lookup exploded');
  },
  inject() {
    throw new Error('inject exploded');
  },
  effect() {
    throw new Error('effect exploded');
  },
};

assert.doesNotThrow(() => module.apply(hostileCtx), 'apply 在恶劣环境下也不得抛异常');
assert.ok(
  calls.some((line) => String(line).includes('sticky-notes')),
  'apply 降级时必须留下日志，便于排障',
);

// A clean-but-empty context: no services at all, still no throw.
assert.doesNotThrow(() => module.apply({}), 'apply 在空 context 下也不得抛异常');

// ------------------------------------------------- publish completeness ==
//
// A registry install copies only `files`, so anything loaded at runtime that is not covered by
// it works perfectly in a local checkout and is missing for everyone else. That failure is
// invisible from here — it only appears on someone else's machine — so the reachable asset set
// is derived from the code and checked against `files` explicitly.

/** Every shipped source file, relative to the package root. */
function shippedSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(mjs|cjs|js|html|css)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ['lib', 'electron']) walk(dir);
  return out;
}

/** Whether a path is inside one of the `files` entries (or is one). */
function coveredByFiles(rel) {
  return pkg.files.some((entry) => rel === entry || rel.startsWith(`${entry}/`) || rel.startsWith(`${entry}.`));
}

const referenced = new Set();
for (const rel of shippedSources()) {
  const source = readFileSync(join(ROOT, rel), 'utf8');
  // Relative ESM/CJS imports.
  for (const match of source.matchAll(/(?:from|import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    referenced.add(resolve(join(ROOT, rel, '..'), match[1]).slice(ROOT.length + 1).replace(/\\/g, '/'));
  }
  // Sibling assets named as strings — the helper's html/css/js and preload files are loaded by
  // path, not imported, so the import scan alone would miss them entirely.
  for (const match of source.matchAll(/['"]([\w.-]+\.(?:html|css|js|cjs|mjs|png))['"]/g)) {
    const prefix = rel.startsWith('electron/') ? 'electron/' : 'lib/';
    referenced.add(`${prefix}${match[1]}`);
  }
}

const missingFromFiles = [...referenced]
  .filter((rel) => !rel.startsWith('..') && !rel.includes('node_modules'))
  .filter((rel) => existsSync(join(ROOT, rel)))
  .filter((rel) => !coveredByFiles(rel));

assert.deepEqual(
  missingFromFiles,
  [],
  `以下运行时会用到的文件没有被 package.json 的 files 覆盖，发布后别人装上会缺文件：${JSON.stringify(missingFromFiles)}`,
);

// The patch has to ship, or the bundle mounts nothing at all.
assert.ok(coveredByFiles('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml，否则装上也挂不进去');

// ------------------------------------------------------------- summary ==

console.log('包契约测试通过');
console.log(`  name            ${pkg.name}`);
console.log(`  Host 入口       ${pkg.main}`);
console.log(`  浏览器入口      ${clientEntry}（${bundleSource.length} 字节，自包含）`);
console.log(`  补丁            ${pkg.dsh.bundle.patch}`);
console.log(`  降级日志        ${calls.length} 条`);
console.log(`  发布完整性      ${shippedSources().length} 个源文件，${referenced.size} 处运行期引用全部被 files 覆盖`);

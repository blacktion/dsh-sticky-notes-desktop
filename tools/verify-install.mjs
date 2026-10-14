/**
 * Verify an *installed* bundle the way DSH's loader resolves it.
 *
 * After an install, the failure that matters is module resolution: DSH asks Node for
 * `<bundle name>`, then reads `exports["./client"]`, `dsh.bundle.patch`, and the patch's own
 * `name` rows. Every one of those is a string that has to agree, and a rename is exactly the
 * operation that makes them disagree — one stale occurrence and the entry "failed to import"
 * with no indication of which string is wrong.
 *
 * Run against a profile directory, so it resolves from that profile's `node_modules`:
 *
 *   node tools/verify-install.mjs <profileDir> <packageName>
 *
 * @module dsh-sticky-notes-desktop/tools/verify-install
 */
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [, , profileDirArg, packageNameArg] = process.argv;
const profileDir = resolve(profileDirArg ?? '.');
const packageName = packageNameArg ?? 'dsh-sticky-notes-desktop';

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

// Resolve exactly as DSH does: from the profile directory, by package name.
const require = createRequire(join(profileDir, 'package.json'));

let packageDir = null;
await step(`从 profile 能按包名解析到 ${packageName}`, () => {
  packageDir = dirname(require.resolve(`${packageName}/package.json`));
  assert.ok(existsSync(join(packageDir, 'package.json')), `解析出的目录不像个包：${packageDir}`);
});

let manifest = null;
await step('清单里的 name 就是被解析的那个名字（改名的核心一致性）', () => {
  manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(manifest.name, packageName, `目录里的 name 是 ${manifest.name}，但被当作 ${packageName} 解析`);
});

let patch = null;
await step('dsh.bundle.patch 存在且文件真的在（DSH 判定 bundle 的唯一字段）', () => {
  const rel = manifest.dsh?.bundle?.patch;
  assert.equal(typeof rel, 'string', `dsh.bundle.patch 缺失：${JSON.stringify(manifest.dsh)}`);
  patch = rel;
  assert.ok(existsSync(join(packageDir, rel)), `补丁文件不存在：${rel}`);
});

await step('补丁是顶层数组，且每行的 name 就是包名（写错就会 failed to import）', () => {
  const text = readFileSync(join(packageDir, patch), 'utf8');
  const names = [...text.matchAll(/^\s*name:\s*['"]?([^'"\s]+)['"]?\s*$/gm)].map((m) => m[1]);
  assert.ok(names.length > 0, '补丁里没有任何 name 行');
  for (const name of names) {
    assert.equal(name, packageName, `补丁里写的是 ${name}，但包名是 ${packageName}`);
  }
  assert.ok(/^-\s/m.test(text) || /insert:/.test(text), '补丁必须包含顶层数组项（insert 段）');
});

await step('浏览器入口 exports["./client"] 存在且文件真的在', () => {
  const entry = manifest.exports?.['./client'];
  const rel = typeof entry === 'string' ? entry : entry?.default;
  assert.equal(typeof rel, 'string', `exports["./client"] 缺失：${JSON.stringify(manifest.exports)}`);
  assert.ok(existsSync(join(packageDir, rel)), `浏览器 bundle 不存在：${rel}`);
  const source = readFileSync(join(packageDir, rel), 'utf8');
  // The loader keys on this id; a mismatch means the browser never runs the plugin.
  assert.ok(
    source.includes(`id: '${packageName}'`) || source.includes(`id: "${packageName}"`),
    `浏览器 bundle 的 __ModuleLoader__ id 不是 ${packageName}`,
  );
  assert.ok(!/^\s*import\s/m.test(source), '浏览器 bundle 不得含 import（必须是自包含脚本）');
});

await step('Host 入口能被真的 import，并导出 name/apply/inject', async () => {
  const module = await import(pathToFileURL(join(packageDir, manifest.main)).href);
  assert.equal(typeof module.apply, 'function', 'Host 半必须导出 apply');
  assert.ok(Array.isArray(module.inject), 'Host 半必须导出 inject 数组');
  assert.equal(typeof module.name, 'string', 'Host 半必须导出 name');
});

await step('apply 在恶劣 context 下不抛异常（DSH 会把抛异常的条目标为 FAILED）', async () => {
  const module = await import(pathToFileURL(join(packageDir, manifest.main)).href);
  const hostile = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get() { throw new Error('boom'); },
    inject() { throw new Error('boom'); },
    effect() { throw new Error('boom'); },
  };
  assert.doesNotThrow(() => module.apply(hostile), 'apply(恶劣) 抛了异常');
  assert.doesNotThrow(() => module.apply({}), 'apply(空) 抛了异常');
});

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log(`已安装的 ${packageName} 解析与加载全部通过 ✅`);
  console.log(`  包目录   ${packageDir}`);
  process.exit(0);
}
console.error(`${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

/**
 * Concatenate the browser half into one self-contained bundle.
 *
 * DSH serves a plugin's client entry as a single file, so anything it needs must
 * already be inside it — a sibling `import` would 404 at runtime. Rather than
 * keep one unmaintainable mega-file, the sources stay split under `lib/ui/` and
 * this script welds them together:
 *
 *   lib/ui/core.js  →  lib/ui/panel.js  →  lib/ui/settings.js  →  lib/client.js
 *
 * Every part is a plain script sharing the `globalThis.__dshSticky` namespace,
 * so no transform is involved and the output is exactly as reviewable as the
 * input. `react` stays a runtime `require`, resolved by the DSH loader.
 *
 * Usage:  node tools/build-client.mjs [--check]
 *
 *   --check  report whether the bundle on disk is already current, and exit
 *            non-zero when it is stale (used by `npm run check`).
 *
 * @module dsh-sticky-notes-desktop/tools/build-client
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'lib', 'client.bundle.js');

/** Concatenation order. Each part must be a plain script. */
const PARTS = ['lib/ui/core.js', 'lib/ui/panel.js', 'lib/ui/settings.js', 'lib/client.js'];

const BANNER = `/**
 * dsh-sticky-notes-desktop — GENERATED browser bundle. DO NOT EDIT.
 *
 * Built by \`tools/build-client.mjs\` from:
${PARTS.map((part) => ` *   - ${part}`).join('\n')}
 *
 * Edit those sources and re-run \`node tools/build-client.mjs\`.
 */`;

/** Fail loudly on an ESM-only construct: the bundle is a classic script. */
function assertPlainScript(name, source) {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*import\s/.test(line) || /^\s*export\s/.test(line) || /^\s*export\{/.test(line)) {
      throw new Error(
        `${name}:${index + 1} 使用了 ESM 语法（import/export）。浏览器 bundle 是经典脚本，` +
          '请改用 globalThis.__dshSticky 命名空间。',
      );
    }
  }
}

function build() {
  const chunks = [BANNER];
  for (const part of PARTS) {
    const path = join(ROOT, part);
    if (!existsSync(path)) throw new Error(`缺少源文件：${part}`);
    const source = readFileSync(path, 'utf8');
    assertPlainScript(part, source);
    chunks.push(`// ==================== ${part} ====================\n${source.trimEnd()}`);
  }
  return `${chunks.join('\n\n')}\n`;
}

const check = process.argv.includes('--check');
const bundle = build();

if (check) {
  if (!existsSync(OUT)) {
    console.error('client bundle 缺失，请运行：node tools/build-client.mjs');
    process.exit(1);
  }
  const current = readFileSync(OUT, 'utf8');
  if (current !== bundle) {
    console.error('client bundle 已过期，请运行：node tools/build-client.mjs');
    process.exit(1);
  }
  console.log('client bundle 是最新的。');
  process.exit(0);
}

writeFileSync(OUT, bundle, 'utf8');
const bytes = statSync(OUT).size;
console.log(`已写出 ${OUT.replace(ROOT, '.')}（${bytes} 字节，来源 ${PARTS.length} 个文件）`);

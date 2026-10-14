/**
 * Check the documentation: every relative link resolves, each language links to its counterpart,
 * and every asset the docs display is actually shipped.
 *
 * Three failures this exists to catch, none of which is visible locally:
 *
 *  1. **A 404'd screenshot.** Nobody notices until a stranger opens the repository, and shipping
 *     every document in two languages doubles the number of links that can rot.
 *  2. **A displayed asset that is not in `files`.** A registry install copies only `files`, so an
 *     image can resolve perfectly in a checkout and be missing for everyone who installs it. That is
 *     the same trap `test-package.mjs` guards for runtime assets, applied to the docs.
 *  3. **A one-way language switcher**, which strands the reader in the language they did not want —
 *     the whole failure mode of shipping two of everything.
 *
 * Usage: node tools/check-readme-links.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/check-readme-links
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/**
 * Every document, and the counterpart its language switcher must point at.
 *
 * A pair is only enforced when the file actually exists and the other one references it: internal
 * notes are not part of the public README, and demanding a switcher on a document nobody links to
 * would be a rule about our own filing rather than about the shipped docs.
 */
const ALL_DOCS = [
  ['README.md', 'README.zh.md'],
  ['README.zh.md', 'README.md'],
  ['DEVELOPMENT.md', 'DEVELOPMENT.zh.md'],
  ['DEVELOPMENT.zh.md', 'DEVELOPMENT.md'],
];
const DOCS = ALL_DOCS.filter(([file]) => existsSync(join(ROOT, file)));
const FILES = DOCS.map(([file]) => file);

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Whether a path is inside one of the `files` entries (or is one). */
function coveredByFiles(rel) {
  return (pkg.files ?? []).some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

const failures = [];
const missingFiles = [];
let checked = 0;

for (const file of FILES) {
  const source = readFileSync(join(ROOT, file), 'utf8');

  // Markdown inline links and images: [text](target) / ![alt](target)
  const targets = [...source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
  // HTML <img src="..."> too, since GitHub renders those.
  targets.push(...[...source.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]));

  for (const target of targets) {
    // Skip absolute URLs, anchors and mailto.
    if (/^(?:[a-z]+:|\/\/|#)/i.test(target)) continue;
    checked += 1;
    const withoutAnchor = target.split('#')[0];
    if (withoutAnchor.length === 0) continue;
    if (!existsSync(join(ROOT, withoutAnchor))) {
      failures.push(`${file}: ${target}`);
      continue;
    }
    // The asset exists in the checkout, but would it exist for someone who installed it?
    // Only images have to ship; a link to another document in the repo is not an install asset.
    const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(withoutAnchor);
    if (isImage && !coveredByFiles(withoutAnchor)) {
      missingFiles.push(`${file}: ${withoutAnchor}`);
    }
  }
}

console.log(`检查了 ${FILES.length} 份文档 / ${checked} 个相对链接`);

// Each document must offer a way to switch to its counterpart, and the two must point at each other.
for (const [file, other] of DOCS) {
  const source = readFileSync(join(ROOT, file), 'utf8');
  if (!source.includes(`](${other})`)) {
    failures.push(`${file}: 缺少指向 ${other} 的语言切换链接`);
  }
}

for (const entry of missingFiles) {
  failures.push(`${entry} —— 文件在仓库里存在，但不在 package.json 的 files 里，装上之后图片会 404`);
}

if (failures.length === 0) {
  const docs = pkg.files.filter((entry) => !['lib', 'electron', 'locale'].includes(entry));
  console.log(`文档检查通过 ✅（双语互链、展示的图片都能随包发布）`);
  console.log(`  files 覆盖：${docs.join(', ')}`);
  process.exit(0);
}
console.error('以下问题需要修：');
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

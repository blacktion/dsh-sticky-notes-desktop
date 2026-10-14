/**
 * Guard the annotator's colour swatches against being repainted by the generic toolbar button rules.
 *
 * ## The bug this exists for
 *
 * Selecting a colour, or hovering one to choose it, painted the swatch **accent blue / translucent
 * white instead of its own colour** — so the one control whose entire purpose is to show a colour was
 * hiding it. The cause was pure cascade specificity:
 *
 *     #toolbar button.active  { background: var(--accent); }   →  (1,1,1)
 *     #toolbar .swatch        { background: var(--c); }         →  (1,1,0)
 *
 * The generic rule wins, and the swatch renders blue. The same applied to `:hover`.
 *
 * ## Why this is a static check
 *
 * The fix must not be "out-specify it" (`#toolbar button.swatch.active`), because the next person to
 * restyle the toolbar buttons would reintroduce the bug and nothing would complain. The invariant that
 * actually holds is narrower and checkable by reading the stylesheet: **no rule whose background can
 * land on a swatch may paint it**, and **the swatch's selected/hover indicators must not use a
 * background at all**. So this parses the CSS and asserts exactly that — no browser needed, and it
 * fails on the shape of the mistake rather than on one spelling of it.
 *
 * Usage: node tools/check-swatch-css.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/check-swatch-css
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const css = readFileSync(join(ROOT, 'electron', 'shot.css'), 'utf8');

/** Split the stylesheet into simple `{selector, body}` rules, ignoring comments and at-rules. */
function rules(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    if (selector.startsWith('@') || selector.length === 0) continue;
    out.push({ selector, body: match[2] });
  }
  return out;
}

const all = rules(css);
const failures = [];

// ---------------------------------------------------------------------------------------------
// 1. No rule with a background may match a swatch, unless it is the swatch's own colour rule.
// ---------------------------------------------------------------------------------------------

/**
 * Whether a selector actually targets a swatch.
 *
 * A plain `includes('.swatch')` is wrong: `#toolbar button:not(.swatch)` contains that substring but
 * means the opposite — it is the guard that keeps the generic rules *off* swatches. This test got
 * fooled by exactly that on its first run.
 */
function targetsSwatch(selector) {
  if (/:not\(\s*\.swatch\s*\)/.test(selector)) return false;
  return /\.swatch\b/.test(selector);
}

for (const { selector, body } of all) {
  const setsBackground = /(^|[;\s])background(-color)?\s*:/.test(body);
  if (!setsBackground) continue;

  // Every selector in the list must be examined: a rule matching both a button and a swatch is the bug.
  for (const part of selector.split(',').map((s) => s.trim())) {
    // A rule that targets swatches deliberately is fine; the guard is about *generic* button rules
    // reaching a swatch by accident.
    if (targetsSwatch(part)) continue;
    // Does this selector's subject plausibly match a toolbar button?
    if (!/(^|\s|>)#toolbar\b/.test(part) && !part.startsWith('#toolbar')) continue;
    if (!/\bbutton\b/.test(part) && !/\*/.test(part)) continue;

    // A generic button rule with a background MUST exclude swatches.
    if (!/:not\(\s*\.swatch\s*\)/.test(part)) {
      failures.push(
        `规则会覆盖色块颜色：\n      ${part}\n    声明了 background，但没有 :not(.swatch)。\n` +
          `    色块必须永远显示自己的颜色 —— 请加上 :not(.swatch)，或用 outline/box-shadow 做选中标识。`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The selected/hover indicators must not be a background fill.
// ---------------------------------------------------------------------------------------------
for (const { selector, body } of all) {
  for (const part of selector.split(',').map((s) => s.trim())) {
    if (!targetsSwatch(part)) continue;
    // `.swatch { background: var(--c) }` is the colour itself — that is the one allowed background.
    if (part === '#toolbar .swatch') continue;

    if (/background(-color)?\s*:/.test(body)) {
      failures.push(
        `色块的选中/悬停标识用了 background，会遮住颜色：\n      ${part} { ${body.trim().replace(/\s+/g, ' ')} }`,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 3. The swatch must actually be colour-driven, and its indicators must be rings.
// ---------------------------------------------------------------------------------------------
const swatchRules = all.filter(({ selector }) => selector.split(',').some((s) => s.trim() === '#toolbar .swatch'));
if (swatchRules.length !== 1) {
  failures.push(`应当恰好有一条 #toolbar .swatch 规则，实际 ${swatchRules.length} 条`);
} else if (!/background\s*:\s*var\(--c\)/.test(swatchRules[0].body)) {
  failures.push(`#toolbar .swatch 必须用 background: var(--c) 显示颜色，实际：${swatchRules[0].body.trim()}`);
}

const activeRule = all.find(({ selector }) =>
  selector.split(',').some((s) => s.trim().replace(/\s+/g, ' ') === '#toolbar .swatch.active'),
);
if (activeRule === undefined) {
  failures.push('缺少 #toolbar .swatch.active 规则 —— 选中态必须有可见标识');
} else if (!/outline\s*:/.test(activeRule.body)) {
  failures.push(`#toolbar .swatch.active 必须用 outline 画圈，实际：${activeRule.body.trim()}`);
}

const hoverRule = all.find(({ selector }) =>
  selector.split(',').some((s) => /\.swatch:hover/.test(s)),
);
if (hoverRule === undefined) {
  failures.push('缺少 .swatch:hover 规则 —— 悬停态必须有可见标识');
} else if (!/outline\s*:/.test(hoverRule.body)) {
  failures.push(`.swatch:hover 必须用 outline 画圈，实际：${hoverRule.body.trim()}`);
}

// ---------------------------------------------------------------------------------------------
// 4. A light swatch needs a dark outer ring, or its white indicator vanishes into the toolbar.
// ---------------------------------------------------------------------------------------------
if (activeRule !== undefined && !/box-shadow\s*:/.test(activeRule.body)) {
  failures.push('#toolbar .swatch.active 需要 box-shadow 深色外圈，否则白色/近白色色块的白色圈看不清');
}

if (failures.length === 0) {
  console.log('色块样式检查通过 ✅');
  console.log('  通用按钮规则全部排除 .swatch；选中/悬停只用 outline 画圈，不覆盖颜色');
  process.exit(0);
}
console.error('色块样式检查失败：');
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

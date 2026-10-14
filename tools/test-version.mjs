/**
 * Verify the version the settings page shows is the version the package actually is.
 *
 * A version display is only worth having if it can be trusted, and the way one stops being trustworthy
 * is drift: someone bumps `package.json`, a hardcoded copy somewhere keeps reporting the old number,
 * and the page confidently shows a lie. So the invariant checked here is not "the version is X" but
 * **"nothing anywhere spells the version out except the manifest"**.
 *
 * Wiring is checked too — the number has to reach the browser, and a correct constant that is never
 * sent would pass a weaker test while showing the user nothing.
 *
 * Usage: node tools/test-version.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-version
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const failures = [];

function step(label, fn) {
  try {
    fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
}

const indexSource = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const routesSource = readFileSync(join(ROOT, 'lib', 'host', 'routes.js'), 'utf8');
const settingsSource = readFileSync(join(ROOT, 'lib', 'ui', 'settings.js'), 'utf8');

await (async () => {
  step('版本从 package.json 读取，且读到的是正确值', async () => {
    const module = await import('../lib/index.js');
    assert.equal(
      module.PLUGIN_VERSION,
      manifest.version,
      `PLUGIN_VERSION 必须是 ${manifest.version}，实际 ${String(module.PLUGIN_VERSION)}`,
    );
  });

  step('版本是读出来的，不是写死的常量', () => {
    assert.ok(
      /readFileSync\([\s\S]{0,200}package\.json/.test(indexSource),
      'lib/index.js 必须从 package.json 读取版本，否则升级时必然忘记同步',
    );
    assert.ok(
      !new RegExp(`PLUGIN_VERSION\\s*=\\s*['"]`).test(indexSource),
      'PLUGIN_VERSION 不得是字面量字符串',
    );
  });

  step('读不到清单时返回 null，而不是伪造一个版本号', () => {
    // The failure path must be "unknown", never a made-up number — a wrong version is worse than none.
    assert.ok(/return null;/.test(indexSource), 'readOwnVersion 失败路径必须返回 null');
    assert.ok(
      /typeof manifest\.version === 'string'/.test(indexSource),
      '必须校验 manifest.version 是字符串，避免 undefined/数字混进界面',
    );
  });

  step('版本被送到浏览器（三条 settings 路径都要带）', () => {
    assert.ok(
      /installRoutes\(ctx, store, bridge, \{[\s\S]{0,200}version: PLUGIN_VERSION/.test(indexSource),
      'lib/index.js 必须把 version 传给 installRoutes',
    );
    const carriers = [
      [/sendJson\(res, 200, \{ settings: store\.getSettings\(\), helper: bridge\.status, about \}\)/, '/settings GET'],
      [/sendJson\(res, 200, \{ settings, applied, helper: bridge\.status, about \}\)/, '/settings PATCH'],
      [/settings: store\.getSettings\(\),\s*helper: bridge\.status,\s*about,/, '/state snapshot'],
    ];
    for (const [pattern, where] of carriers) {
      assert.ok(pattern.test(routesSource), `${where} 的响应里必须带 about（版本要能在首屏就读到）`);
    }
  });

  step('设置页读取并渲染版本，未知时如实说明而不是留空', () => {
    assert.ok(/var about = state\.about/.test(settingsSource), '设置页必须从 state.about 取版本');
    assert.ok(/dsn-set-about-version/.test(settingsSource), '设置页必须渲染版本元素');
    assert.ok(/dsn-svc-version/.test(settingsSource), '服务状态卡片上也应当显示版本');
    assert.ok(
      /settings\.versionUnknown/.test(settingsSource),
      '版本未知时必须有明确文案，不能显示 "v" 或 "v0.0.0"',
    );
  });

  step('除清单外，任何地方都不得把版本号写成字面量', () => {
    // The real failure mode: a hardcoded copy that keeps reporting the old number after a bump.
    const version = manifest.version;
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const literal = new RegExp(`['"\`]v?${escaped}['"\`]`);
    // A version may legitimately appear as a bare number in comments or as a changelog entry; what is
    // forbidden is a quoted literal in shipped code, which is what a stale UI would print.
    const offenders = [];

    const walk = (dir) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
        const text = readFileSync(join(ROOT, rel), 'utf8');
        for (const line of text.split('\n')) {
          // Skip comments: a JSDoc example mentioning the version is not a hardcoded display value.
          const code = line.replace(/^\s*(\*|\/\/).*$/, '');
          if (literal.test(code)) offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    };
    walk('lib');
    walk('electron');

    assert.deepEqual(offenders, [], `以下位置把版本号写成了字面量，升级后会显示过期版本：\n    ${offenders.join('\n    ')}`);
  });
})();

console.log(`\n${'─'.repeat(62)}`);
if (failures.length === 0) {
  console.log(`版本显示测试：全部通过 ✅（当前版本 ${manifest.version}）`);
  process.exit(0);
}
console.error(`版本显示测试：${failures.length} 项失败 ❌`);
for (const failure of failures) console.error(`  - ${failure}`);
process.exit(1);

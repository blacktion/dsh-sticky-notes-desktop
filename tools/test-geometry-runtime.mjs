/**
 * Execute every geometry export, on a machine whose taskbar makes bounds differ from the work area.
 *
 * ## Why this exists
 *
 * A rename inside `geometry.js` left one branch referring to the old parameter name. `node --check`
 * passed — it only parses — and the mistake surfaced only when the Electron helper started, where a
 * `ReferenceError` from a hidden note's geometry became "the plugin failed to import". A syntax check
 * cannot find a typo'd identifier; only running the code can.
 *
 * So this calls every export across every edge and both hide modes, with a display whose `bounds` and
 * `workArea` genuinely differ. The taskbar is what makes the two rectangles distinct, and a machine
 * without one would let a broken call pass unnoticed — which is exactly how this got out.
 *
 * Usage: node tools/test-geometry-runtime.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-geometry-runtime
 */
import assert from 'node:assert/strict';

const geometry = await import('../lib/host/geometry.js');

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  [通过] ${label}`);
  } catch (error) {
    console.error(`  [失败] ${label}`);
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
    failures.push(label);
  }
};

/** A desktop with a bottom taskbar: the only configuration where the two rectangles differ. */
const DISPLAY = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const SCREEN = geometry.screenRectOf(DISPLAY);
const EDGES = [geometry.EDGE_LEFT, geometry.EDGE_RIGHT, geometry.EDGE_TOP, geometry.EDGE_BOTTOM];
const MODES = [geometry.HIDE_MODE_OFFSCREEN, geometry.HIDE_MODE_TAB];

const note = (edge, extra = {}) => ({ edge, x: 500, y: 400, width: 260, height: 200, ...extra });

console.log('=== 每个导出都要能真的跑起来（不是只有语法正确） ===');

check('screenRectOf / displayFor 不抛异常', () => {
  geometry.screenRectOf(DISPLAY);
  geometry.screenRectOf({});
  geometry.screenRectOf(undefined);
  geometry.displayFor([DISPLAY], note(null));
  geometry.displayFor([], note(null));
  geometry.displayFor(undefined, note(null));
});

check('snapToEdge：四条边 × 三种阈值都不抛异常', () => {
  for (const edge of EDGES) for (const t of [0, 10, 200]) geometry.snapToEdge(note(edge, { x: 3, y: 3 }), SCREEN, t);
  geometry.snapToEdge(note(null), SCREEN, NaN);
  geometry.snapToEdge(note(null), SCREEN, undefined);
  geometry.snapToEdge(note(null), SCREEN, -5);
});

check('hiddenBounds：四条边 × 两种模式都必须返回矩形（回归：曾有分支引用未定义变量）', () => {
  for (const mode of MODES) {
    for (const edge of EDGES) {
      const rect = geometry.hiddenBounds(note(edge), SCREEN, mode);
      assert.ok(rect !== undefined && rect !== null, `${mode}/${edge} 必须返回矩形`);
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Number.isFinite(rect[key]), `${mode}/${edge} 的 ${key} 必须是有限数，实际 ${rect[key]}`);
        assert.ok(rect[key] > -10000 && rect[key] < 10000, `${mode}/${edge} 的 ${key} 离谱：${rect[key]}`);
      }
    }
  }
});

check('hiddenBounds：edge 为 null / 未知值时不抛异常', () => {
  for (const mode of MODES) {
    geometry.hiddenBounds(note(null), SCREEN, mode);
    geometry.hiddenBounds(note('nonsense'), SCREEN, mode);
  }
});

check('revealZone：四条边 × 两种模式都必须返回可用的感应区', () => {
  for (const mode of MODES) {
    for (const edge of EDGES) {
      const zone = geometry.revealZone(note(edge), SCREEN, undefined, mode);
      assert.ok(zone !== null, `${mode}/${edge} 的感应区不应为 null`);
      for (const key of ['x', 'y', 'width', 'height']) {
        assert.ok(Number.isFinite(zone[key]), `${mode}/${edge} 的感应区 ${key} 无效：${zone[key]}`);
      }
      assert.ok(zone.width > 0 && zone.height > 0, `${mode}/${edge} 的感应区必须有面积`);
    }
  }
});

check('revealZone：slack 取 0 / 极大值都不抛异常', () => {
  for (const slack of [0, 8, 5000]) {
    for (const mode of MODES) for (const edge of EDGES) geometry.revealZone(note(edge), SCREEN, slack, mode);
  }
});

check('shouldReveal：四种边都要能给出布尔值', () => {
  for (const edge of EDGES) {
    const result = geometry.shouldReveal(note(edge), { x: 960, y: 540 }, SCREEN);
    assert.equal(typeof result, 'boolean', `${edge} 应返回布尔值，实际 ${typeof result}`);
  }
});

check('clampX / clampY：正常值、负值、超大值都不抛异常', () => {
  for (const value of [-9999, -1, 0, 500, 1919, 9999]) {
    geometry.clampX(value, 260, SCREEN);
    geometry.clampY(value, 200, SCREEN);
  }
  geometry.clampX(0, 5000, SCREEN);
  geometry.clampY(0, 5000, SCREEN);
});

check('placeNear：弹出层仍按工作区落点，不抛异常', () => {
  for (const point of [{ x: 0, y: 0 }, { x: 1919, y: 1079 }, { x: 960, y: 540 }]) {
    const spot = geometry.placeNear(point, 260, 200, DISPLAY.workArea);
    assert.ok(Number.isFinite(spot.x) && Number.isFinite(spot.y), `${JSON.stringify(point)} 的落点无效`);
    assert.ok(spot.y + 200 <= DISPLAY.workArea.y + DISPLAY.workArea.height, '落点必须在工作区内');
  }
});

check('constrainSize / revealedBounds / pointInRect 不抛异常', () => {
  geometry.constrainSize(10, 10);
  geometry.constrainSize(9999, 9999);
  geometry.revealedBounds(note(geometry.EDGE_LEFT));
  geometry.pointInRect({ x: 1, y: 1 }, { x: 0, y: 0, width: 10, height: 10 });
  geometry.pointInRect({ x: 1, y: 1 }, null);
});

console.log(`\n${'─'.repeat(64)}`);
if (failures.length === 0) {
  console.log('几何运行期检查：全部通过 ✅（每个导出都真的被调用过）');
  process.exit(0);
}
console.error(`几何运行期检查：${failures.length} 项失败 ❌`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);

#!/usr/bin/env node
/**
 * dsh-sticky-notes-desktop · lib/host/geometry.js 单元测试
 *
 * 运行：node tools/test-geometry.mjs
 *   - 退出码 0 = 全部通过；非 0 = 有失败（失败用例、断言说明、实际值/期望值都会打印）
 *   - 只用 Node 内置模块（node:assert/strict、node:util、node:url），零第三方依赖
 *
 * 覆盖的函数 / 常量：
 *   displayFor、snapToEdge、clampX、clampY、hiddenBounds、revealedBounds、
 *   revealZone、pointInRect、shouldReveal、constrainSize、placeNear、
 *   MIN_NOTE_WIDTH、MIN_NOTE_HEIGHT、TAB_THICKNESS、TAB_SPAN、TAB_MIN_SPAN、
 *   HIDE_MODE_OFFSCREEN、HIDE_MODE_TAB、OFFSCREEN_SLIVER、REVEAL_SLACK、
 *   EDGE_LEFT/RIGHT/TOP/BOTTOM
 *
 * 坐标空间：屏幕 DIP，原点在主显示器左上角（与 geometry.js 的约定一致）。
 *
 * 隐藏模型（本文件针对当前版本）：hiddenBounds(note, workArea, mode) 有两种模式。
 *
 *   - offscreen（默认，HIDE_MODE_OFFSCREEN）：便签**整块移出屏幕外**，只在屏幕边缘留下
 *     OFFSCREEN_SLIVER = 1px。返回矩形的宽高保持便签**原本的尺寸**，位置被推到工作区之外
 *     —— 所以它故意**不完全落在工作区内**，与工作区的交集恰好就是那 1px。
 *   - tab（可选，HIDE_MODE_TAB）：把便签收成 TAB_THICKNESS = 36px 厚、跨度收敛到
 *     TAB_MIN_SPAN..TAB_SPAN 的小标签，居中于便签原来的跨度并 clamp 进工作区，
 *     整个标签都在工作区内。
 *
 * 为什么默认改成"整块移出屏幕外"：旧实现假设"窗口管理器会把窗口夹回屏内"，因此只能把
 * 便签收成小标签。这个假设是错的 —— Windows 上实测 Electron 窗口可以真的整块移到屏幕外：
 * 请求 x = 1920（工作区右边界）时实际返回 x = 1920、可见面积 0.0%；请求 x = -260 同样原样
 * 生效。既然"完全移出去"是可达的，默认行为就该是最干净的整块移出，小标签退化成可选项保留。
 *
 * 那 1px 的作用：0% 可见的窗口没有任何可以瞄准的物理目标，便签一旦藏起来就只能靠"猜坐标"
 * 找回来。留 1px 在屏内既不显眼，又让便签保住一条真实可碰的边。感应区（revealZone）也因此
 * 改为**锚定屏幕边缘**：从边缘向内 slack（REVEAL_SLACK = 8）+ 屏内那 1px，沿边方向覆盖便签
 * 的跨度 —— 鼠标推到屏幕边缘就能唤出，不必瞄准那 1px。
 *
 * 于是本套件的关键回归不变量变成下面这些（对两种模式都成立，除非特别注明）：
 *   1) 隐藏矩形与工作区的交集非空（至少 1px 在屏内，鼠标才有东西可碰）；
 *   2) revealZone 与工作区的交集非空（鼠标只能在工作区内移动）；
 *   3) 屏幕边缘、且落在便签跨度内的点必须能触发唤出（便签不会"永远回不来"）；
 *   4) offscreen 专属：与工作区的交集恰好是 OFFSCREEN_SLIVER（真的移出去了，但还够得着），
 *      且尺寸保持便签原尺寸；
 *   5) tab 专属：整个标签都在工作区内，厚度恒为 TAB_THICKNESS 且 >= 32px —— Windows 上
 *      Electron 实测最小窗口宽度 32px，比它更细的窗口会被系统撑大，几何就与真实窗口不符。
 */
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  EDGE_BOTTOM,
  EDGE_LEFT,
  EDGE_RIGHT,
  EDGE_TOP,
  HIDE_MODE_OFFSCREEN,
  HIDE_MODE_TAB,
  MIN_NOTE_HEIGHT,
  MIN_NOTE_WIDTH,
  OFFSCREEN_SLIVER,
  REVEAL_SLACK,
  TAB_MIN_SPAN,
  TAB_SPAN,
  TAB_THICKNESS,
  clampX,
  clampPinned,
  clampY,
  PINNED_OVERHANG,
  constrainSize,
  displayFor,
  screenRectOf,
  hiddenBounds,
  placeNear,
  pointInRect,
  revealZone,
  revealedBounds,
  shouldReveal,
  snapToEdge,
} from '../lib/host/geometry.js';

const GEOMETRY_FILE = fileURLToPath(new URL('../lib/host/geometry.js', import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// 迷你测试框架（不引入任何依赖）
// ─────────────────────────────────────────────────────────────────────────────
const failures = [];
let passed = 0;
let failed = 0;
let assertions = 0;
let currentGroup = '(未分组)';

function group(title) {
  currentGroup = title;
  console.log(`\n${title}`);
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [通过] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name: `${currentGroup} → ${name}`, error });
    console.log(`  [失败] ${name}`);
    for (const line of explain(error).split('\n')) console.log(`         ${line}`);
  }
}

function explain(error) {
  if (error instanceof assert.AssertionError) {
    const out = [`断言失败：${error.message || '(无说明)'}`];
    if ('actual' in error) out.push(`实际值：${inspect(error.actual, { depth: 4 })}`);
    if ('expected' in error) out.push(`期望值：${inspect(error.expected, { depth: 4 })}`);
    return out.join('\n');
  }
  return `抛出了意外异常：${error && error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : String(error)}`;
}

// —— 断言助手（每条都计数，失败时给出中文说明 + 实际/期望值）——
function eq(actual, expected, message) {
  assertions += 1;
  assert.strictEqual(actual, expected, message);
}
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}
function deepEq(actual, expected, message) {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}
function isFiniteNum(value, message) {
  assertions += 1;
  assert.ok(Number.isFinite(value), `${message}（实际得到 ${inspect(value)}，要求是有限数字）`);
}
function near(actual, expected, message, eps = 1e-9) {
  assertions += 1;
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
    `${message}（实际 ${inspect(actual)}，期望 ${inspect(expected)}，容差 ${eps}）`,
  );
}
function noThrow(fn, message) {
  assertions += 1;
  try {
    return fn();
  } catch (error) {
    assert.fail(`${message}（但它抛出了 ${error?.name ?? 'Error'}: ${error?.message ?? error}）`);
  }
  return undefined;
}
function inside(rect, workArea, message) {
  assertions += 1;
  assert.ok(
    fullyInside(rect, workArea),
    `${message}（矩形 ${inspect(rect)} 没有完全落在工作区 ${inspect(workArea)} 内）`,
  );
}
/** 矩形是否完全落在工作区内（含 1e-9 容差）。offscreen 模式的隐藏矩形故意不满足它。 */
function fullyInside(rect, workArea) {
  const horizontal = rect.x >= workArea.x - 1e-9 && rect.x + rect.width <= workArea.x + workArea.width + 1e-9;
  const vertical = rect.y >= workArea.y - 1e-9 && rect.y + rect.height <= workArea.y + workArea.height + 1e-9;
  return horizontal && vertical;
}
function isEdge(value, message) {
  assertions += 1;
  assert.ok(
    value === null || value === EDGE_LEFT || value === EDGE_RIGHT || value === EDGE_TOP || value === EDGE_BOTTOM,
    `${message}（实际 ${inspect(value)}，只允许 left/right/top/bottom/null）`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试数据（吸附阈值取自 electron/main.mjs 的默认设置）
// ─────────────────────────────────────────────────────────────────────────────
const WA = { x: 0, y: 0, width: 1000, height: 800 }; // 主显示器工作区
const WA_SECOND = { x: 1920, y: 0, width: 1920, height: 1080 }; // 右侧第二显示器
const FALLBACK_AREA = { x: 0, y: 0, width: 1920, height: 1080 }; // displayFor 的兜底区域
const THRESHOLD = 12; // settings.snapDistance 默认值
/** revealZone / shouldReveal 的 slack 默认值（= 导出的 REVEAL_SLACK；旧 settings.hiddenRevealWidth 已删除）。 */
const SLACK = 8;
/** 显式传入的非默认 slack：用来证明这个参数确实被采纳，而不是被忽略。 */
const SLACK_WIDE = 20;
/** Windows 上 Electron 实测的最小窗口宽度：标签厚度一旦小于它，窗口会被系统撑大、几何与实际不符。 */
const PLATFORM_MIN_WINDOW_WIDTH = 32;
const ALL_EDGES = [EDGE_LEFT, EDGE_RIGHT, EDGE_TOP, EDGE_BOTTOM];
/** 两种隐藏模式：默认的 offscreen 与可选的 tab。所有通用不变量都要对两者分别成立。 */
const MODES = [HIDE_MODE_OFFSCREEN, HIDE_MODE_TAB];

const rect = (x, y, width = 200, height = 150) => ({ x, y, width, height });
const note = (edge, x, y, width = 200, height = 150) => ({ edge, x, y, width, height });
const disp = (id, workArea) => ({ id, workArea, bounds: { ...workArea }, scaleFactor: 1 });

/** 便签隐藏后标签沿边方向的跨度（按导出的常量收敛）。 */
const tabSpanOf = (span) => Math.max(TAB_MIN_SPAN, Math.min(span, TAB_SPAN));
/** 标签的"厚度"落在哪一维：左右贴边是宽度，上下贴边是高度。 */
const tabThicknessOnScreen = (tab, edge) =>
  edge === EDGE_LEFT || edge === EDGE_RIGHT ? tab.width : tab.height;
/** 隐藏后屏幕上真正还能看见的那条（矩形 ∩ 工作区）。 */
function visibleSliver(hidden, workArea) {
  const x1 = Math.max(hidden.x, workArea.x);
  const y1 = Math.max(hidden.y, workArea.y);
  const x2 = Math.min(hidden.x + hidden.width, workArea.x + workArea.width);
  const y2 = Math.min(hidden.y + hidden.height, workArea.y + workArea.height);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
/** 两个矩形是否有任意重叠（哪怕 1px）。 */
const overlaps = (r, a) => r.x < a.x + a.width && r.x + r.width > a.x && r.y < a.y + a.height && r.y + r.height > a.y;
const centerOf = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });

// —— 模式无关的几何助手：offscreen / tab 两套断言都建立在它们之上 ——
/** 吸附轴：左右贴边时"厚度"落在 x 上，上下贴边时落在 y 上。 */
const snapAxisOf = (edge) => (edge === EDGE_LEFT || edge === EDGE_RIGHT ? 'x' : 'y');
/** 沿边轴：垂直于吸附边的那一轴（左右贴边 → y，上下贴边 → x）。 */
const alongAxisOf = (edge) => (edge === EDGE_LEFT || edge === EDGE_RIGHT ? 'y' : 'x');
/** 矩形在某一维上的区间。 */
const rangeOn = (r, axis) => (axis === 'x' ? { lo: r.x, hi: r.x + r.width } : { lo: r.y, hi: r.y + r.height });
/** 矩形在吸附轴上的尺寸（左右贴边看宽，上下贴边看高）。 */
const sizeOn = (r, edge) => (snapAxisOf(edge) === 'x' ? r.width : r.height);
/** 矩形在沿边轴上的尺寸（= tab 沿边方向的跨度）。 */
const alongSizeOf = (r, edge) => (alongAxisOf(edge) === 'x' ? r.width : r.height);
/** outer 是否完整覆盖 inner（两种模式共用：感应区必须罩住屏内可见的那部分）。 */
function covers(outer, inner) {
  const x = rangeOn(outer, 'x');
  const ix = rangeOn(inner, 'x');
  const y = rangeOn(outer, 'y');
  const iy = rangeOn(inner, 'y');
  return x.lo <= ix.lo + 1e-9 && x.hi >= ix.hi - 1e-9 && y.lo <= iy.lo + 1e-9 && y.hi >= iy.hi - 1e-9;
}
/** 隐藏矩形与工作区的交集在吸附轴上的长度：offscreen 模式即"留在屏内的那 1px"。 */
const sliverOnSnapAxis = (hidden, workArea, edge) => Math.max(0, sizeOn(visibleSliver(hidden, workArea), edge));
/** 便签沿边方向的跨度 ∩ 工作区：鼠标在屏幕上真正能够到的那段跨度。 */
function onScreenSpan(r, workArea, axis) {
  const a = rangeOn(r, axis);
  const b = rangeOn(workArea, axis);
  return { lo: Math.max(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
}
/**
 * 屏幕边缘上"最该被响应"的那个点：便签在屏内的跨度 ∩ 隐藏矩形在屏内的跨度，取其中点。
 *
 * 为什么取交集：tab 模式下标签会被 clamp 进工作区，所以"便签的跨度"和"标签的跨度"可能只
 * 部分重叠（例如便签被拖到左上角之外、吸附上边后，标签被拉回 x=0..120，而便签在屏内的跨度
 * 是 0..271）。这个中点同时落在两者之内，正是"屏幕边缘 + 便签跨度内"的鼠标位置；两种模式下
 * 它都必定落在感应区的沿边范围内。返回 null 表示两者在屏内没有重叠（此时不做该断言）。
 */
function reachableAlong(note, hidden, workArea, edge) {
  const axis = alongAxisOf(edge);
  const a = onScreenSpan(note, workArea, axis);
  const h = onScreenSpan(hidden, workArea, axis);
  const lo = Math.max(a.lo, h.lo);
  const hi = Math.min(a.hi, h.hi);
  return hi > lo ? (lo + hi) / 2 : null;
}
/** 屏幕边缘上的点：鼠标能到达的最外侧坐标（沿边方向取 along）。 */
function edgePoint(workArea, edge, along) {
  if (edge === EDGE_LEFT) return { x: workArea.x, y: along };
  if (edge === EDGE_RIGHT) return { x: workArea.x + workArea.width, y: along };
  if (edge === EDGE_TOP) return { x: along, y: workArea.y };
  return { x: along, y: workArea.y + workArea.height };
}
/** 从屏幕边缘向工作区内 d 像素的点。 */
function inwardPoint(workArea, edge, along, d) {
  if (edge === EDGE_LEFT) return { x: workArea.x + d, y: along };
  if (edge === EDGE_RIGHT) return { x: workArea.x + workArea.width - d, y: along };
  if (edge === EDGE_TOP) return { x: along, y: workArea.y + d };
  return { x: along, y: workArea.y + workArea.height - d };
}
/**
 * 带 mode 的"鼠标是否落在感应区里"。
 * shouldReveal 只有 (note, point, workArea, slack) 四个参数、始终按默认 offscreen 模式判定，
 * 所以 tab 模式的判定只能显式走 revealZone(..., mode) + pointInRect。
 */
const revealHits = (shown, point, workArea, slack, mode) => pointInRect(point, revealZone(shown, workArea, slack, mode));
/** 沿边方向的坐标必须被夹进工作区（否则那 1px / 标签本体可能落到鼠标够不到的地方）。 */
function assertAlongClamped(hidden, workArea, edge, message) {
  const { lo, hi } = rangeOn(workArea, alongAxisOf(edge));
  const start = rangeOn(hidden, alongAxisOf(edge)).lo;
  const limit = Math.max(lo, hi - alongSizeOf(hidden, edge));
  assertions += 1;
  assert.ok(
    start >= lo - 1e-9 && start <= limit + 1e-9,
    `${message}（沿边坐标 ${inspect(start)} 不在 [${lo}, ${limit}] 内）`,
  );
}

console.log('dsh-sticky-notes-desktop · geometry.js 单元测试');
console.log(`被测文件：${GEOMETRY_FILE}`);
console.log(`Node：${process.version}`);

// ─────────────────────────────────────────────────────────────────────────────
group('[1] displayFor —— 矩形中心落在哪个显示器');
// ─────────────────────────────────────────────────────────────────────────────
const D1 = disp(1, { x: 0, y: 0, width: 1920, height: 1080 });
const D2 = disp(2, { x: 1920, y: 0, width: 1920, height: 1080 });

check('中心落在第二个显示器 → 返回第二个显示器', () => {
  const found = displayFor([D1, D2], rect(2500, 400, 200, 150)); // 中心 (2600, 475)
  eq(found?.id, 2, '矩形中心在第二显示器内，必须返回第二个显示器');
});

check('中心落在第一个显示器 → 返回第一个显示器', () => {
  const found = displayFor([D1, D2], rect(100, 100, 200, 150));
  eq(found?.id, 1, '矩形中心在第一显示器内，必须返回第一个显示器');
});

check('中心正好跨在两显示器公共边界上 → 确定性归属后一个显示器（左显示器右边界为开区间）', () => {
  const found = displayFor([D1, D2], rect(1820, 400, 200, 150)); // 中心 x = 1920
  eq(found?.id, 2, '边界点必须落在 1920..3840 的那个显示器上，结果要确定');
});

check('中心落在两显示器之间的空隙 → 回落到第一个显示器，绝不返回 undefined', () => {
  const a = disp(1, { x: 0, y: 0, width: 1000, height: 800 });
  const b = disp(2, { x: 2000, y: 0, width: 1000, height: 800 });
  const found = displayFor([a, b], rect(1400, 300, 200, 150)); // 中心 x = 1500，落在空隙里
  ok(found !== undefined && found !== null, '找不到归属时必须回落到第一个显示器，不能返回 undefined/null');
  eq(found?.id, 1, '空隙时回落到第一个显示器');
});

check('显示器在主显示器左侧（负坐标）时也能正确定位', () => {
  const left = disp(9, { x: -1920, y: 0, width: 1920, height: 1080 });
  const found = displayFor([D1, left], rect(-1500, 300, 200, 150));
  eq(found?.id, 9, '负坐标显示器上的矩形必须归到该显示器');
});

check('displays 为空数组 → 返回 1920x1080 兜底区域且不抛异常', () => {
  const found = noThrow(() => displayFor([], rect(10, 10, 100, 100)), 'displayFor([], rect) 不应抛异常');
  ok(found && found.workArea, '兜底结果必须自带 workArea，调用方才能继续算');
  deepEq(found.workArea, FALLBACK_AREA, '兜底区域应为 {0,0,1920,1080}');
});

check('displays 为 undefined → 不抛异常并返回兜底区域', () => {
  const found = noThrow(() => displayFor(undefined, rect(10, 10, 100, 100)), 'displayFor(undefined, rect) 不应抛异常');
  deepEq(found?.workArea, FALLBACK_AREA, 'undefined 时返回兜底区域');
});

check('displays 为 null → 不抛异常并返回兜底区域', () => {
  const found = noThrow(() => displayFor(null, rect(10, 10, 100, 100)), 'displayFor(null, rect) 不应抛异常');
  deepEq(found?.workArea, FALLBACK_AREA, 'null 时返回兜底区域');
});

check('displayFor 是纯函数：不修改传入的数组和显示器对象', () => {
  const list = [D1, D2];
  const before = JSON.stringify(list);
  displayFor(list, rect(2500, 400, 200, 150));
  eq(JSON.stringify(list), before, '输入数组/显示器对象不应被修改');
  eq(list.length, 2, '输入数组长度不应变化');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[2] snapToEdge —— 四条边的吸附与优先级');
// ─────────────────────────────────────────────────────────────────────────────
check('左边缘：距左边 5px（阈值 12 内）→ x 精确吸附到工作区左边界，y 不动', () => {
  const out = snapToEdge(rect(5, 300), WA, THRESHOLD);
  eq(out.edge, EDGE_LEFT, '距左边缘 5px 应吸附左边');
  eq(out.x, WA.x, '吸附左边后 x 必须精确等于工作区左边界 0');
  eq(out.y, 300, '不吸附的方向（y）必须保持原值');
});

check('右边缘：距右边 5px → x 吸附到 工作区右边 - 便签宽', () => {
  const r = rect(795, 300);
  const out = snapToEdge(r, WA, THRESHOLD);
  eq(out.edge, EDGE_RIGHT, '距右边缘 5px 应吸附右边');
  eq(out.x, WA.x + WA.width - r.width, '吸附右边后 x 必须等于 1000 - 200 = 800');
  eq(out.y, 300, 'y 不动');
  eq(out.x + r.width, WA.x + WA.width, '吸附后便签右边缘应精确贴合工作区右边界');
});

check('上边缘：距上边 7px → y 吸附到工作区上边界', () => {
  const out = snapToEdge(rect(400, 7), WA, THRESHOLD);
  eq(out.edge, EDGE_TOP, '距上边缘 7px 应吸附上边');
  eq(out.y, WA.y, '吸附上边后 y 必须精确等于 0');
  eq(out.x, 400, 'x 不动');
});

check('下边缘：距下边 5px → y 吸附到 工作区下边 - 便签高', () => {
  const r = rect(400, 645);
  const out = snapToEdge(r, WA, THRESHOLD);
  eq(out.edge, EDGE_BOTTOM, '距下边缘 5px 应吸附下边');
  eq(out.y, WA.y + WA.height - r.height, '吸附下边后 y 必须等于 800 - 150 = 650');
  eq(out.x, 400, 'x 不动');
  eq(out.y + r.height, WA.y + WA.height, '吸附后便签下边缘应精确贴合工作区下边界');
});

check('距离恰好等于阈值 → 算吸附（闭区间，不能漏掉边界）', () => {
  const out = snapToEdge(rect(THRESHOLD, 300), WA, THRESHOLD);
  eq(out.edge, EDGE_LEFT, '距离 == threshold 时必须吸附，否则用户会觉得"明明碰到了却不贴"');
  eq(out.x, WA.x, 'x 吸附到左边界');
});

check('阈值外（最近边还有 300px）→ edge === null 且坐标原样不动', () => {
  const r = rect(400, 300);
  const out = snapToEdge(r, WA, THRESHOLD);
  eq(out.edge, null, '远离所有边缘时必须返回 edge === null');
  eq(out.x, r.x, '不吸附时 x 必须原样返回（便签不能被偷偷挪走）');
  eq(out.y, r.y, '不吸附时 y 必须原样返回');
  ok(out.distance > THRESHOLD, `返回的 distance 应大于阈值，实际 ${out.distance}`);
});

check('阈值 0：只有完全贴边才吸附', () => {
  const snapped = snapToEdge(rect(0, 300), WA, 0);
  eq(snapped.edge, EDGE_LEFT, '阈值 0 时完全贴边（距离 0）仍应吸附');
  eq(snapped.x, WA.x, 'x 吸附到左边界');
  const untouched = snapToEdge(rect(1, 300), WA, 0);
  eq(untouched.edge, null, '阈值 0 时差 1px 不应吸附');
  eq(untouched.x, 1, '坐标必须保持不变');
  eq(untouched.y, 300, '坐标必须保持不变');
});

check('阈值是 NaN / undefined / 负数（设置项没读到）→ 按 0 处理，不抛异常', () => {
  const withNaN = noThrow(() => snapToEdge(rect(5, 300), WA, NaN), 'NaN 阈值不应抛异常');
  eq(withNaN.edge, null, 'NaN 阈值按 0 处理：5px 不应吸附');
  eq(withNaN.x, 5, '坐标不变');
  const withUndefined = noThrow(() => snapToEdge(rect(0, 300), WA, undefined), 'undefined 阈值不应抛异常');
  eq(withUndefined.edge, EDGE_LEFT, 'undefined 阈值按 0 处理：贴边仍吸附');
  const withNegative = noThrow(() => snapToEdge(rect(5, 300), WA, -20), '负数阈值不应抛异常');
  eq(withNegative.edge, null, '负数阈值按 0 处理：5px 不应吸附');
});

check('四边距离完全相等（都等于 5px）→ 按 left → right → top → bottom 优先级，left 胜出', () => {
  // 四边等距且都在阈值内：便签 990x990 居中放在 1000x1000 的工作区里，四边距离都是 5px
  const squareArea = { x: 0, y: 0, width: 1000, height: 1000 };
  const square = { x: 5, y: 5, width: 990, height: 990 };
  const out = snapToEdge(square, squareArea, THRESHOLD);
  eq(out.edge, EDGE_LEFT, '四边等距时必须选 left（优先级最高）');
  eq(out.x, squareArea.x, '左吸附 x = 0');
  eq(out.y, 5, 'y 保持不动');
});

check('right / top / bottom 三者等距 → right 优先于 top、bottom', () => {
  // left 794、right 6、top 6、bottom 6
  const area = { x: 0, y: 0, width: 1000, height: 600 };
  const r = { x: 794, y: 6, width: 200, height: 588 };
  const out = snapToEdge(r, area, THRESHOLD);
  eq(out.edge, EDGE_RIGHT, 'right 与 top/bottom 等距时必须选 right');
  eq(out.x, 800, '右吸附 x = 1000 - 200');
  eq(out.y, 6, 'y 保持不动');
});

check('top / bottom 等距（且比 left/right 近）→ top 优先于 bottom', () => {
  // left 400、right 400、top 6、bottom 6
  const area = { x: 0, y: 0, width: 1000, height: 600 };
  const r = { x: 400, y: 6, width: 200, height: 588 };
  const out = snapToEdge(r, area, THRESHOLD);
  eq(out.edge, EDGE_TOP, 'top 与 bottom 等距时必须选 top');
  eq(out.y, 0, '上吸附 y = 0');
  eq(out.x, 400, 'x 保持不动');
});

check('非零原点工作区（第二显示器）：吸附坐标按该工作区计算', () => {
  const r = rect(1920 + 3, 300); // 贴着第二显示器左边缘
  const out = snapToEdge(r, WA_SECOND, THRESHOLD);
  eq(out.edge, EDGE_LEFT, '应吸附第二显示器的左边缘');
  eq(out.x, WA_SECOND.x, 'x 必须精确等于 1920，而不是 0');
});

check('便签比工作区还大 → 不产生 NaN、不抛异常、返回合法边', () => {
  const huge = rect(0, 0, 2000, 1200);
  const out = noThrow(() => snapToEdge(huge, WA, THRESHOLD), '超大矩形不应抛异常');
  isFiniteNum(out.x, '超大矩形吸附后的 x 必须是有限数字');
  isFiniteNum(out.y, '超大矩形吸附后的 y 必须是有限数字');
  isEdge(out.edge, '超大矩形也必须返回合法边或 null');
  ok(Number.isFinite(out.distance), 'distance 也不能是 NaN');
});

check('snapToEdge 是纯函数：不修改传入的 rect', () => {
  const r = rect(5, 300);
  snapToEdge(r, WA, THRESHOLD);
  deepEq(r, { x: 5, y: 300, width: 200, height: 150 }, '输入矩形不应被就地修改');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[3] clampX / clampY —— 夹回工作区');
// ─────────────────────────────────────────────────────────────────────────────
check('clampX：负数 → 夹到工作区左边界', () => {
  eq(clampX(-50, 200, WA), WA.x, 'x=-50 应夹到 0');
  eq(clampX(-99999, 200, WA), WA.x, '极负值同样夹到 0');
});

check('clampX：超出右侧 → 夹到 工作区右边 - 宽度', () => {
  eq(clampX(5000, 200, WA), WA.x + WA.width - 200, 'x=5000 应夹到 800');
  eq(clampX(801, 200, WA), 800, '刚超出 1px 也要夹回');
});

check('clampX：宽度大于工作区宽 → 返回工作区左边界且不是 NaN', () => {
  const out = clampX(300, 2000, WA);
  isFiniteNum(out, '超宽时的返回值必须是有限数字');
  eq(out, WA.x, '便签比工作区还宽时对齐到左边界 0');
});

check('clampX：本来就在工作区内 → 原样返回', () => {
  eq(clampX(300, 200, WA), 300, '工作区内的值不应被改动');
  eq(clampX(0, 200, WA), 0, '正好贴左边界保持 0');
  eq(clampX(800, 200, WA), 800, '正好贴右边界保持 800');
});

check('clampX：非零原点显示器（第二屏）也正确', () => {
  eq(clampX(0, 200, WA_SECOND), 1920, '落在第一屏的值应被夹到第二屏左边界 1920');
  eq(clampX(99999, 200, WA_SECOND), 1920 + 1920 - 200, '应夹到第二屏右边界减宽度 3640');
  eq(clampX(2000, 200, WA_SECOND), 2000, '第二屏内部的值不改动');
});

check('clampY：负数 → 夹到工作区上边界', () => {
  eq(clampY(-50, 150, WA), WA.y, 'y=-50 应夹到 0');
});

check('clampY：超出下边界 → 夹到 工作区下边 - 高度', () => {
  eq(clampY(5000, 150, WA), WA.y + WA.height - 150, 'y=5000 应夹到 650');
  eq(clampY(651, 150, WA), 650, '刚超出 1px 也要夹回');
});

check('clampY：高度大于工作区高 → 返回工作区上边界且不是 NaN', () => {
  const out = clampY(300, 900, WA);
  isFiniteNum(out, '超高时的返回值必须是有限数字');
  eq(out, WA.y, '便签比工作区还高时对齐到上边界 0');
});

check('clampY：本来就在工作区内 → 原样返回', () => {
  eq(clampY(300, 150, WA), 300, '工作区内的值不应被改动');
  eq(clampY(0, 150, WA), 0, '正好贴上边界保持 0');
  eq(clampY(650, 150, WA), 650, '正好贴下边界保持 650');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[4] hiddenBounds —— offscreen（默认：整块移出屏幕外）/ tab（可选：收成小标签）');
// ─────────────────────────────────────────────────────────────────────────────
check('导出常量：HIDE_MODE_* / OFFSCREEN_SLIVER / REVEAL_SLACK / TAB_* 都符合约定', () => {
  eq(HIDE_MODE_OFFSCREEN, 'offscreen', '默认模式（整块移出屏幕外）必须叫 offscreen');
  eq(HIDE_MODE_TAB, 'tab', '可选模式（收成小标签）必须叫 tab');
  eq(OFFSCREEN_SLIVER, 1, 'offscreen 模式留在屏内的部分必须是 1px');
  ok(OFFSCREEN_SLIVER > 0, '留在屏内的部分必须 > 0，否则鼠标没有任何可以瞄准的物理边缘');
  eq(REVEAL_SLACK, 8, '感应区的默认 slack 必须是 8');
  eq(REVEAL_SLACK, SLACK, `导出的 REVEAL_SLACK 必须等于本套件假定的默认 slack ${SLACK}`);
  ok(SLACK_WIDE > SLACK, '非默认 slack 必须真的更宽，才能证明这个参数被采纳');
  eq(TAB_THICKNESS, 36, `标签厚度必须是固定的 36px（且 >= 平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px）`);
  eq(TAB_SPAN, 120, '标签跨度上限必须是 120');
  eq(TAB_MIN_SPAN, 56, '标签跨度下限必须是 56');
  ok(TAB_MIN_SPAN <= TAB_SPAN, 'TAB_MIN_SPAN 不能大于 TAB_SPAN');
  ok(TAB_MIN_SPAN > TAB_THICKNESS, `标签跨度下限 ${TAB_MIN_SPAN} 必须大于厚度 ${TAB_THICKNESS}，标签才是"任务栏式"的扁条`);
  ok(
    TAB_THICKNESS >= PLATFORM_MIN_WINDOW_WIDTH,
    `标签厚度 ${TAB_THICKNESS}px 不得小于平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px，否则窗口会被系统撑大`,
  );
});

/** [4]/[5]/[8] 共用的标准场景：便签本来就在工作区（1000x800）内，四种贴边各一份。 */
const SHOWN_CASES = [
  { edge: EDGE_LEFT, shown: rect(0, 300) },
  { edge: EDGE_RIGHT, shown: rect(800, 300) },
  { edge: EDGE_TOP, shown: rect(400, 0) },
  { edge: EDGE_BOTTOM, shown: rect(400, 650) },
];

check('offscreen（默认）：右边缘 → x = 工作区右边 - OFFSCREEN_SLIVER，尺寸保持便签原尺寸、屏内恰好 1px', () => {
  const shown = note(EDGE_RIGHT, 800, 300); // 200x150
  const off = hiddenBounds(shown, WA); // 省略 mode → 默认 offscreen
  eq(off.x, WA.x + WA.width - OFFSCREEN_SLIVER, '右隐藏时 x 必须等于 1000 - 1 = 999');
  eq(off.x, 999, '右隐藏时 x 必须是 999');
  eq(off.width, shown.width, `吸附轴尺寸必须保持便签原尺寸 ${shown.width}px，而不是收成 ${TAB_THICKNESS}px 的小标签`);
  eq(off.height, shown.height, `沿边轴尺寸也必须保持原尺寸 ${shown.height}px`);
  eq(off.y, shown.y, '沿边方向（y）本来就在工作区内，clamp 不生效，必须原样保留');
  eq(sliverOnSnapAxis(off, WA, EDGE_RIGHT), OFFSCREEN_SLIVER, '与工作区的交集必须恰好是那 1px');
  eq(visibleSliver(off, WA).width, OFFSCREEN_SLIVER, '屏内可见宽度就是 OFFSCREEN_SLIVER');
  eq(visibleSliver(off, WA).height, shown.height, '沿边方向整条便签都还在屏内');
  ok(off.x + off.width > WA.x + WA.width, '便签必须大部分移到屏幕右边界之外（这才是"移出屏幕外"）');
  ok(!fullyInside(off, WA), 'offscreen 模式返回的矩形故意不完全落在工作区内');
  ok(overlaps(off, WA), '但必须至少留下 1px 在屏内，否则鼠标够不到');
});

check('offscreen（默认）：左边缘 → x = 工作区左边 - 宽度 + sliver，尺寸不变、屏内恰好 1px', () => {
  const shown = note(EDGE_LEFT, 0, 300);
  const off = hiddenBounds(shown, WA);
  eq(off.x, WA.x - shown.width + OFFSCREEN_SLIVER, '左隐藏时 x 必须等于 0 - 200 + 1 = -199');
  eq(off.x, -199, '左隐藏时 x 必须是 -199');
  eq(off.width, shown.width, '尺寸必须保持便签原尺寸');
  eq(off.height, shown.height, '高度必须保持便签原尺寸');
  eq(off.y, shown.y, '沿边方向（y）原样保留');
  eq(sliverOnSnapAxis(off, WA, EDGE_LEFT), OFFSCREEN_SLIVER, '与工作区的交集必须恰好是那 1px');
  eq(visibleSliver(off, WA).x, WA.x, '屏内那 1px 必须紧贴屏幕左边缘');
  eq(visibleSliver(off, WA).height, shown.height, '沿边方向整条便签都还在屏内');
  ok(!fullyInside(off, WA), '故意不完全落在工作区内');
  ok(overlaps(off, WA), '但交集非空');
});

check('offscreen（默认）：上边缘 → y = 工作区上边 - 高度 + sliver，尺寸不变、屏内恰好 1px', () => {
  const shown = note(EDGE_TOP, 400, 0);
  const off = hiddenBounds(shown, WA);
  eq(off.y, WA.y - shown.height + OFFSCREEN_SLIVER, '上隐藏时 y 必须等于 0 - 150 + 1 = -149');
  eq(off.y, -149, '上隐藏时 y 必须是 -149');
  eq(off.width, shown.width, '尺寸必须保持便签原尺寸');
  eq(off.height, shown.height, '高度必须保持便签原尺寸');
  eq(off.x, shown.x, '沿边方向（x）原样保留');
  eq(sliverOnSnapAxis(off, WA, EDGE_TOP), OFFSCREEN_SLIVER, '与工作区的交集必须恰好是那 1px');
  eq(visibleSliver(off, WA).y, WA.y, '屏内那 1px 必须紧贴屏幕上边缘');
  eq(visibleSliver(off, WA).width, shown.width, '沿边方向整条便签都还在屏内');
  ok(!fullyInside(off, WA), '故意不完全落在工作区内');
  ok(overlaps(off, WA), '但交集非空');
});

check('offscreen（默认）：下边缘 → y = 工作区下边 - sliver，尺寸不变、屏内恰好 1px', () => {
  const shown = note(EDGE_BOTTOM, 400, 650);
  const off = hiddenBounds(shown, WA);
  eq(off.y, WA.y + WA.height - OFFSCREEN_SLIVER, '下隐藏时 y 必须等于 800 - 1 = 799');
  eq(off.y, 799, '下隐藏时 y 必须是 799');
  eq(off.width, shown.width, '尺寸必须保持便签原尺寸');
  eq(off.height, shown.height, '高度必须保持便签原尺寸');
  eq(off.x, shown.x, '沿边方向（x）原样保留');
  eq(sliverOnSnapAxis(off, WA, EDGE_BOTTOM), OFFSCREEN_SLIVER, '与工作区的交集必须恰好是那 1px');
  const sliver = visibleSliver(off, WA);
  eq(sliver.y + sliver.height, WA.y + WA.height, '屏内那 1px 必须紧贴屏幕下边缘');
  eq(sliver.width, shown.width, '沿边方向整条便签都还在屏内');
  ok(!fullyInside(off, WA), '故意不完全落在工作区内');
  ok(overlaps(off, WA), '但交集非空');
});

check('offscreen 不变量：四方向精确坐标 + 原尺寸 + 交集恰好 OFFSCREEN_SLIVER + 沿边坐标被夹进工作区', () => {
  const expected = {
    [EDGE_LEFT]: { x: WA.x - 200 + OFFSCREEN_SLIVER, y: 300, width: 200, height: 150 },
    [EDGE_RIGHT]: { x: WA.x + WA.width - OFFSCREEN_SLIVER, y: 300, width: 200, height: 150 },
    [EDGE_TOP]: { x: 400, y: WA.y - 150 + OFFSCREEN_SLIVER, width: 200, height: 150 },
    [EDGE_BOTTOM]: { x: 400, y: WA.y + WA.height - OFFSCREEN_SLIVER, width: 200, height: 150 },
  };
  for (const { edge, shown } of SHOWN_CASES) {
    const off = hiddenBounds({ edge, ...shown }, WA);
    deepEq(off, expected[edge], `${edge}：offscreen 的精确坐标与尺寸`);
    eq(sizeOn(off, edge), sizeOn(shown, edge), `${edge}：吸附轴尺寸必须保持便签原尺寸`);
    eq(alongSizeOf(off, edge), alongSizeOf(shown, edge), `${edge}：沿边轴尺寸也必须保持原尺寸`);
    // 这条就是"真的移出去了、但还够得着"的量化表述
    eq(sliverOnSnapAxis(off, WA, edge), OFFSCREEN_SLIVER, `${edge}：返回矩形与工作区的交集必须恰好是 ${OFFSCREEN_SLIVER}px`);
    ok(!fullyInside(off, WA), `${edge}：offscreen 返回的矩形故意不完全落在工作区内`);
    ok(overlaps(off, WA), `${edge}：交集非空（那 1px 在屏内）`);
    assertAlongClamped(off, WA, edge, `${edge}：沿边方向（垂直于吸附边的轴）的坐标必须被夹进工作区`);
  }
});

check('offscreen：便签被拖到屏幕外或比工作区还大时，沿边坐标仍被夹进工作区，那 1px 不会被甩出屏幕', () => {
  const cases = [
    { why: '左贴边但纵向整个在屏幕下方', n: note(EDGE_LEFT, 0, 5000) },
    { why: '上贴边但横向整个在屏幕右侧', n: note(EDGE_TOP, 5000, 0) },
    { why: '右贴边但纵向为负', n: note(EDGE_RIGHT, 800, -900) },
    { why: '下贴边但横向为负', n: note(EDGE_BOTTOM, -900, 650) },
    { why: '比工作区还大（2000x1600）且贴左边', n: note(EDGE_LEFT, 0, 0, 2000, 1600) },
    { why: '比工作区还大（2000x1600）且贴下边', n: note(EDGE_BOTTOM, 0, 0, 2000, 1600) },
  ];
  for (const { why, n } of cases) {
    const off = hiddenBounds(n, WA);
    assertAlongClamped(off, WA, n.edge, `${why}：沿边坐标必须被夹进工作区`);
    eq(
      sliverOnSnapAxis(off, WA, n.edge),
      Math.min(OFFSCREEN_SLIVER, sizeOn(n, n.edge)),
      `${why}：屏内那 1px 不能被甩到屏幕外`,
    );
    ok(overlaps(off, WA), `${why}：与工作区的交集仍必须非空`);
  }
});

check('tab（HIDE_MODE_TAB）：右边缘隐藏 → x === workArea.x + workArea.width - TAB_THICKNESS', () => {
  const out = hiddenBounds(note(EDGE_RIGHT, 800, 300), WA, HIDE_MODE_TAB);
  eq(out.x, WA.x + WA.width - TAB_THICKNESS, '右隐藏时 x 必须等于 1000 - 36');
  eq(out.x, 964, '右隐藏时 x 必须是 964');
  eq(out.width, TAB_THICKNESS, `标签厚度必须是固定的 TAB_THICKNESS（${TAB_THICKNESS}px）`);
  eq(out.height, tabSpanOf(150), '标签跨度必须按 TAB_MIN_SPAN..TAB_SPAN 收敛');
  near(out.y + out.height / 2, 300 + 150 / 2, '标签应在便签原来的纵向跨度上居中', 1);
  inside(out, WA, '标签必须完全落在工作区内');
});

check('tab：左边缘隐藏 → x === workArea.x，且纵向仍居中于便签原跨度', () => {
  const out = hiddenBounds(note(EDGE_LEFT, 0, 300), WA, HIDE_MODE_TAB);
  eq(out.x, WA.x, '左隐藏时标签贴在 0');
  eq(out.width, TAB_THICKNESS, '标签厚度 = TAB_THICKNESS');
  eq(out.height, tabSpanOf(150), '标签跨度必须收敛');
  near(out.y + out.height / 2, 300 + 150 / 2, '标签应纵向居中', 1);
  inside(out, WA, '标签必须完全落在工作区内');
});

check('tab：上边缘隐藏 → y === workArea.y，且横向仍居中于便签原跨度', () => {
  const out = hiddenBounds(note(EDGE_TOP, 400, 0), WA, HIDE_MODE_TAB);
  eq(out.y, WA.y, '上隐藏时标签贴在 0');
  eq(out.height, TAB_THICKNESS, '标签厚度 = TAB_THICKNESS');
  eq(out.width, tabSpanOf(200), '标签跨度必须收敛');
  near(out.x + out.width / 2, 400 + 200 / 2, '标签应横向居中', 1);
  inside(out, WA, '标签必须完全落在工作区内');
});

check('tab：下边缘隐藏 → y === workArea.y + workArea.height - TAB_THICKNESS', () => {
  const out = hiddenBounds(note(EDGE_BOTTOM, 400, 650), WA, HIDE_MODE_TAB);
  eq(out.y, WA.y + WA.height - TAB_THICKNESS, '下隐藏时 y 必须等于 800 - 36');
  eq(out.y, 764, '下隐藏时 y 必须是 764');
  eq(out.height, TAB_THICKNESS, '标签厚度 = TAB_THICKNESS');
  near(out.x + out.width / 2, 400 + 200 / 2, '标签应横向居中', 1);
  inside(out, WA, '标签必须完全落在工作区内');
});

check('两种模式互不相同，且省略 mode 等价于 offscreen：tab 整块在屏内、offscreen 保持原尺寸并移到屏外', () => {
  for (const { edge, shown } of SHOWN_CASES) {
    const defaults = hiddenBounds({ edge, ...shown }, WA);
    const off = hiddenBounds({ edge, ...shown }, WA, HIDE_MODE_OFFSCREEN);
    const tab = hiddenBounds({ edge, ...shown }, WA, HIDE_MODE_TAB);
    deepEq(defaults, off, `${edge}：省略 mode 必须等价于显式传 HIDE_MODE_OFFSCREEN`);
    eq(sizeOn(off, edge), sizeOn(shown, edge), `${edge}：offscreen 吸附轴尺寸 = 便签原尺寸`);
    eq(sizeOn(tab, edge), TAB_THICKNESS, `${edge}：tab 吸附轴尺寸 = TAB_THICKNESS`);
    ok(
      sizeOn(off, edge) !== sizeOn(tab, edge),
      `${edge}：两种模式的吸附轴尺寸语义必须真的不同（${sizeOn(off, edge)} vs ${sizeOn(tab, edge)}）`,
    );
    ok(!fullyInside(off, WA), `${edge}：offscreen 必须有一部分在屏幕外`);
    inside(tab, WA, `${edge}：tab 必须整块落在工作区内`);
    eq(sliverOnSnapAxis(off, WA, edge), OFFSCREEN_SLIVER, `${edge}：offscreen 与工作区的交集恰好 1px`);
    eq(sliverOnSnapAxis(tab, WA, edge), TAB_THICKNESS, `${edge}：tab 与工作区的交集就是整个标签厚度`);
    ok(covers(tab, visibleSliver(tab, WA)), `${edge}：标签完整覆盖自己与工作区的交集`);
  }
});

check('tab：四个方向的标签都必须完全落在工作区内（否则鼠标根本够不到）', () => {
  for (const { edge, shown } of SHOWN_CASES) {
    const out = hiddenBounds({ edge, ...shown }, WA, HIDE_MODE_TAB);
    inside(out, WA, `${edge} 隐藏后的标签必须完全落在工作区内`);
    const sliver = visibleSliver(out, WA);
    ok(sliver.width > 0 && sliver.height > 0, `${edge} 隐藏后必须仍有像素留在屏幕内`);
    eq(tabThicknessOnScreen(out, edge), TAB_THICKNESS, `${edge} 隐藏后的标签厚度必须是 TAB_THICKNESS`);
    eq(sliverOnSnapAxis(out, WA, edge), TAB_THICKNESS, `${edge} tab 与工作区的交集就是整个标签厚度`);
    assertAlongClamped(out, WA, edge, `${edge}：沿边坐标也必须被夹进工作区`);
  }
});

check('tab：标签跨度被约束在 TAB_MIN_SPAN..TAB_SPAN 之间（太长的便签也要留下可点的把手）', () => {
  const tall = hiddenBounds(note(EDGE_RIGHT, 800, 100, 200, 1000), WA, HIDE_MODE_TAB);
  eq(tall.height, TAB_SPAN, `高 1000px 的便签，标签跨度应收敛到 TAB_SPAN=${TAB_SPAN}`);
  inside(tall, WA, '收敛后的标签必须在工作区内');
  const flat = hiddenBounds(note(EDGE_RIGHT, 800, 300, 200, 20), WA, HIDE_MODE_TAB);
  eq(flat.height, TAB_MIN_SPAN, `只有 20px 高的便签，标签也要撑到 TAB_MIN_SPAN=${TAB_MIN_SPAN} 以保证可点`);
  inside(flat, WA, '撑高后的标签仍必须在工作区内');
});

check('新回归：tab 模式下无论便签尺寸/位置如何，标签厚度都不得小于平台最小窗口宽度 32px', () => {
  // 为什么单独立一条：Windows 上 Electron 对窗口有最小宽度限制（实测 32px）。
  // 厚度一旦小于它，我们算出来的"细条"就不是系统里那个窗口 —— 系统会把窗口撑回
  // 最小宽度，几何与真实窗口不符，点击/感应区也就跟着错位。所以厚度下限是硬约束，
  // 必须对任意尺寸、任意位置、任意边缘都成立。
  //
  // 这条约束的是 **tab 模式**的厚度：offscreen 模式返回的是便签原尺寸（>= 最小便签尺寸
  // 140x90），本来就不会碰到这个平台下限。
  const shapes = [
    { why: '常规便签', n: { x: 800, y: 300, width: 200, height: 150 } },
    { why: '极端扁平（高度 1px）', n: { x: 800, y: 300, width: 200, height: 1 } },
    { why: '退化成一个点（0x0）', n: { x: 800, y: 300, width: 0, height: 0 } },
    { why: '宽度几乎为 0', n: { x: 800, y: 300, width: 1, height: 150 } },
    { why: '巨高（99999px）', n: { x: 800, y: 300, width: 200, height: 99999 } },
    { why: '实际尺寸小于最小便签尺寸', n: { x: 800, y: 300, width: 10, height: 10 } },
    { why: '被拖到工作区左上角之外（负坐标）', n: { x: -900, y: -700, width: 200, height: 150 } },
    { why: '存档坐标整个落在屏幕外', n: { x: 5000, y: 5000, width: 200, height: 150 } },
    { why: '比工作区还大', n: { x: 0, y: 0, width: 2000, height: 1600 } },
  ];
  for (const edge of ALL_EDGES) {
    for (const { why, n } of shapes) {
      const tab = hiddenBounds({ edge, ...n }, WA, HIDE_MODE_TAB);
      const thickness = tabThicknessOnScreen(tab, edge);
      isFiniteNum(thickness, `${edge}｜${why}：标签厚度必须是有限数字`);
      ok(
        thickness >= PLATFORM_MIN_WINDOW_WIDTH,
        `${edge}｜${why}：标签厚度 ${thickness}px 低于平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px，`
          + '窗口会被系统撑大，几何就与真实窗口不符',
      );
      eq(thickness, TAB_THICKNESS, `${edge}｜${why}：厚度必须恒为 TAB_THICKNESS=${TAB_THICKNESS}px`);
      eq(alongSizeOf(tab, edge), tabSpanOf(alongSizeOf(n, edge)), `${edge}｜${why}：跨度必须按 TAB_MIN_SPAN..TAB_SPAN 收敛`);
      inside(tab, WA, `${edge}｜${why}：标签仍必须完全落在工作区内`);
      // 同一条约束在 offscreen 模式下换了个说法：尺寸是便签原尺寸，绝不可能变成细条
      const off = hiddenBounds({ edge, ...n }, WA, HIDE_MODE_OFFSCREEN);
      eq(sizeOn(off, edge), sizeOn(n, edge), `${edge}｜${why}：offscreen 尺寸必须始终等于便签原尺寸`);
      eq(
        sliverOnSnapAxis(off, WA, edge),
        Math.min(OFFSCREEN_SLIVER, sizeOn(n, edge)),
        `${edge}｜${why}：offscreen 与工作区的交集必须恰好是那 1px`,
      );
    }
  }
});

check('mode 参数：只认 HIDE_MODE_TAB 这一个值，其它任何值都回落到默认 offscreen，且不抛异常', () => {
  // 旧版本里第三个参数是调用方传入的 revealWidth（还带一套非法值回落规则）。现在第三个
  // 参数是 mode：只有精确等于 'tab' 才走标签分支，其余一律按默认的 offscreen 处理。
  const shown = note(EDGE_RIGHT, 800, 300);
  const offscreen = hiddenBounds(shown, WA, HIDE_MODE_OFFSCREEN);
  deepEq(hiddenBounds(shown, WA), offscreen, '省略 mode 必须等价于 HIDE_MODE_OFFSCREEN');
  for (const bad of [undefined, null, NaN, 0, 1, -5, true, false, '', 'TAB', 'tab ', ' offscreen', 'OFFSCREEN', 'offscreen', 36, {}, []]) {
    const out = noThrow(() => hiddenBounds(shown, WA, bad), `mode=${String(bad)} 时不应抛异常`);
    deepEq(out, offscreen, `mode=${String(bad)} 不是精确的 'tab'，必须回落到默认 offscreen`);
    isFiniteNum(out.x, `mode=${String(bad)} 时 x 不能是 NaN`);
    isFiniteNum(out.y, `mode=${String(bad)} 时 y 不能是 NaN`);
  }
  deepEq(
    hiddenBounds(shown, WA, HIDE_MODE_TAB),
    { x: WA.x + WA.width - TAB_THICKNESS, y: 315, width: TAB_THICKNESS, height: TAB_SPAN },
    "mode === 'tab' 时必须走标签分支（x=964、y=315、36x120）",
  );
});

check('tab 模式的厚度是固定常量：与便签自身尺寸/位置完全无关（旧的 revealWidth 参数已删除）', () => {
  const shaped = [
    { why: '常规便签', n: { x: 800, y: 300, width: 200, height: 150 } },
    { why: '1px 宽', n: { x: 800, y: 300, width: 1, height: 150 } },
    { why: '0x0', n: { x: 800, y: 300, width: 0, height: 0 } },
    { why: '99999px 高', n: { x: 800, y: 300, width: 200, height: 99999 } },
    { why: '比工作区还大', n: { x: 0, y: 0, width: 2000, height: 1600 } },
    { why: '整个在屏幕外', n: { x: 5000, y: 5000, width: 200, height: 150 } },
  ];
  for (const edge of ALL_EDGES) {
    for (const { why, n } of shaped) {
      const tab = hiddenBounds({ edge, ...n }, WA, HIDE_MODE_TAB);
      eq(tabThicknessOnScreen(tab, edge), TAB_THICKNESS, `${edge}｜${why}：厚度必须恒为 TAB_THICKNESS=${TAB_THICKNESS}px`);
      ok(
        tabThicknessOnScreen(tab, edge) >= PLATFORM_MIN_WINDOW_WIDTH,
        `${edge}｜${why}：厚度必须 >= 平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px`,
      );
      if (edge === EDGE_LEFT) eq(tab.x, WA.x, `${why}：无论便签什么样，标签都必须贴住左边缘`);
      if (edge === EDGE_RIGHT) eq(tab.x, WA.x + WA.width - TAB_THICKNESS, `${why}：无论便签什么样，标签都必须贴住右边缘`);
      if (edge === EDGE_TOP) eq(tab.y, WA.y, `${why}：无论便签什么样，标签都必须贴住上边缘`);
      if (edge === EDGE_BOTTOM) eq(tab.y, WA.y + WA.height - TAB_THICKNESS, `${why}：无论便签什么样，标签都必须贴住下边缘`);
      isFiniteNum(tab.x, `${edge}｜${why}：x 不能是 NaN`);
      isFiniteNum(tab.y, `${edge}｜${why}：y 不能是 NaN`);
      inside(tab, WA, `${edge}｜${why}：标签必须完全落在工作区内`);
    }
  }
});

check('tab 模式：固定厚度与感应区同源 —— 标签被默认 slack 的感应区完整覆盖、中心可命中', () => {
  for (const { edge, shown } of SHOWN_CASES) {
    const noteShown = { edge, ...shown };
    const hidden = { edge, ...hiddenBounds(noteShown, WA, HIDE_MODE_TAB) };
    const zone = revealZone(noteShown, WA, SLACK, HIDE_MODE_TAB); // 显式四参：slack + mode
    ok(zone !== null, `${edge}：tab 模式的感应区不应为 null`);
    eq(sizeOn(zone, edge), TAB_THICKNESS + SLACK, `${edge}：感应区必须按标签厚度推算，并在标签外侧再留默认 slack=${SLACK}px`);
    eq(sliverOnSnapAxis(hidden, WA, edge), TAB_THICKNESS, `${edge}：标签与工作区的交集就是整个标签厚度`);
    inside(zone, WA, `${edge}：感应区必须留在工作区内`);
    ok(covers(zone, hidden), `${edge}：感应区必须完整覆盖标签，否则这块便签点不回来`);
    eq(revealHits(noteShown, centerOf(hidden), WA, SLACK, HIDE_MODE_TAB), true, `${edge}：标签中心必须能被感应到`);
    // 感应区厚度只由 (TAB_THICKNESS, slack) 决定，与便签原尺寸无关
    const huge = { edge, ...shown, width: 999, height: 999 };
    eq(
      sizeOn(zone, edge),
      sizeOn(revealZone(huge, WA, SLACK, HIDE_MODE_TAB), edge),
      `${edge}：感应区厚度只由 TAB_THICKNESS 与 slack 决定，与便签原尺寸无关`,
    );
  }
});

check('edge === null → 两种模式下坐标都完全不变（没有方向就不隐藏，交给调用方处理）', () => {
  const input = note(null, 800, 300);
  for (const mode of MODES) {
    deepEq(hiddenBounds(input, WA, mode), { x: 800, y: 300, width: 200, height: 150 }, `mode=${mode}：edge=null 时必须原地不动`);
  }
  deepEq(hiddenBounds(input, WA), { x: 800, y: 300, width: 200, height: 150 }, 'edge=null 且省略 mode 时也必须原地不动');
});

check('edge 是未定义的怪值（undefined / "LEFT"）→ 两种模式下都不抛异常且原地不动', () => {
  for (const mode of MODES) {
    const withUndefined = noThrow(
      () => hiddenBounds({ x: 800, y: 300, width: 200, height: 150 }, WA, mode),
      `mode=${mode}：edge 缺失时不应抛异常`,
    );
    deepEq(withUndefined, { x: 800, y: 300, width: 200, height: 150 }, `mode=${mode}：edge 缺失时原地不动`);
    const withUnknown = noThrow(() => hiddenBounds(note('LEFT', 800, 300), WA, mode), `mode=${mode}：未知 edge 不应抛异常`);
    deepEq(withUnknown, { x: 800, y: 300, width: 200, height: 150 }, `mode=${mode}：未知 edge 时原地不动`);
  }
});

check('hiddenBounds 是纯函数：两种模式下都不修改传入的 note / workArea', () => {
  const n = note(EDGE_RIGHT, 800, 300);
  const areaBefore = JSON.stringify(WA);
  for (const mode of MODES) {
    hiddenBounds(n, WA, mode);
    deepEq(n, { edge: EDGE_RIGHT, x: 800, y: 300, width: 200, height: 150 }, `mode=${mode}：输入 note 不应被就地修改`);
    eq(JSON.stringify(WA), areaBefore, `mode=${mode}：输入 workArea 不应被就地修改`);
  }
});

check('revealedBounds 返回弹回后的完整尺寸（便签不会被永久缩成小标签）', () => {
  const n = note(EDGE_RIGHT, 800, 300);
  deepEq(revealedBounds(n), { x: 800, y: 300, width: 200, height: 150 }, 'revealedBounds 必须原样携带便签的真实尺寸');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[5] revealZone / pointInRect / shouldReveal —— 感应区锚定屏幕边缘，鼠标推到边缘就弹回');
// ─────────────────────────────────────────────────────────────────────────────
const SHOWN_RIGHT = note(EDGE_RIGHT, 800, 300); // 显示态
const SHOWN_LEFT = note(EDGE_LEFT, 0, 300);
const SHOWN_TOP = note(EDGE_TOP, 400, 0);
const SHOWN_BOTTOM = note(EDGE_BOTTOM, 400, 650);
// 隐藏态：默认（offscreen）与 tab 各一份，下面的断言对两种模式分别做
const HIDDEN_RIGHT = { edge: EDGE_RIGHT, ...hiddenBounds(SHOWN_RIGHT, WA) };
const HIDDEN_LEFT = { edge: EDGE_LEFT, ...hiddenBounds(SHOWN_LEFT, WA) };
const HIDDEN_TOP = { edge: EDGE_TOP, ...hiddenBounds(SHOWN_TOP, WA) };
const HIDDEN_BOTTOM = { edge: EDGE_BOTTOM, ...hiddenBounds(SHOWN_BOTTOM, WA) };
const HIDDEN_RIGHT_TAB = { edge: EDGE_RIGHT, ...hiddenBounds(SHOWN_RIGHT, WA, HIDE_MODE_TAB) };
const HIDDEN_LEFT_TAB = { edge: EDGE_LEFT, ...hiddenBounds(SHOWN_LEFT, WA, HIDE_MODE_TAB) };
const HIDDEN_TOP_TAB = { edge: EDGE_TOP, ...hiddenBounds(SHOWN_TOP, WA, HIDE_MODE_TAB) };
const HIDDEN_BOTTOM_TAB = { edge: EDGE_BOTTOM, ...hiddenBounds(SHOWN_BOTTOM, WA, HIDE_MODE_TAB) };
/** 某条边的四个标准场景（显示态 + 两种模式的隐藏态）。 */
const EDGE_SCENARIOS = [
  { edge: EDGE_LEFT, shown: SHOWN_LEFT, off: HIDDEN_LEFT, tab: HIDDEN_LEFT_TAB },
  { edge: EDGE_RIGHT, shown: SHOWN_RIGHT, off: HIDDEN_RIGHT, tab: HIDDEN_RIGHT_TAB },
  { edge: EDGE_TOP, shown: SHOWN_TOP, off: HIDDEN_TOP, tab: HIDDEN_TOP_TAB },
  { edge: EDGE_BOTTOM, shown: SHOWN_BOTTOM, off: HIDDEN_BOTTOM, tab: HIDDEN_BOTTOM_TAB },
];
const hiddenIn = (scenario, mode) => (mode === HIDE_MODE_TAB ? scenario.tab : scenario.off);

check('屏幕边缘触发（两种模式）：鼠标离边缘 0..slack 像素、且在便签跨度内 → 必须能唤出', () => {
  for (const scenario of EDGE_SCENARIOS) {
    const { edge, shown } = scenario;
    for (const mode of MODES) {
      const hidden = hiddenIn(scenario, mode);
      const along = centerOf(hidden)[alongAxisOf(edge)];
      // 沿边方向取隐藏矩形的跨度中心：两种模式下它都落在便签原本的跨度内
      const span = onScreenSpan(shown, WA, alongAxisOf(edge));
      ok(along >= span.lo - 1e-9 && along <= span.hi + 1e-9, `${edge}｜${mode}：命中点必须落在便签的跨度内`);
      for (const d of [0, 1, Math.floor(SLACK / 2), SLACK]) {
        eq(revealHits(shown, inwardPoint(WA, edge, along, d), WA, SLACK, mode), true, `${edge}｜${mode}：离边缘 ${d}px（<= slack=${SLACK}）必须能唤出便签`);
      }
      // 边界之外不该触发：感应区厚度恰好是"屏内可见厚度 + slack"，一点不多
      const justOutside = sliverOnSnapAxis(hidden, WA, edge) + SLACK + 1;
      eq(
        revealHits(shown, inwardPoint(WA, edge, along, justOutside), WA, SLACK, mode),
        false,
        `${edge}｜${mode}：离边缘 ${justOutside}px 已经出了感应区，不应触发`,
      );
    }
  }
});

check('右边缘（offscreen）：隐藏矩形大部分在屏外，感应区仍锚定屏幕边缘并完整覆盖屏内那 1px', () => {
  const zone = revealZone(SHOWN_RIGHT, WA, SLACK, HIDE_MODE_OFFSCREEN);
  ok(zone !== null, 'edge=right 时 revealZone 不应为 null');
  eq(zone.x + zone.width, WA.x + WA.width, '感应区右边界必须贴住屏幕右边缘 1000');
  eq(zone.x, WA.x + WA.width - OFFSCREEN_SLIVER - SLACK, `感应区必须从"屏内 1px + slack=${SLACK}"处开始`);
  eq(sizeOn(zone, EDGE_RIGHT), OFFSCREEN_SLIVER + SLACK, `感应区宽度必须是 1 + ${SLACK}（而不是隐藏矩形的 ${HIDDEN_RIGHT.width}）`);
  inside(zone, WA, '感应区必须整体留在工作区内（鼠标只能在工作区里移动）');
  ok(!fullyInside(HIDDEN_RIGHT, WA), 'offscreen 的隐藏矩形故意不完全落在工作区内');
  ok(HIDDEN_RIGHT.x + HIDDEN_RIGHT.width > WA.x + WA.width, '隐藏矩形必须越过屏幕右边界（真的移出去了）');
  ok(overlaps(zone, WA), '感应区与工作区的交集必须非空');
  const sliver = visibleSliver(HIDDEN_RIGHT, WA);
  eq(sliver.width, OFFSCREEN_SLIVER, '屏内可见宽度就是那 1px');
  ok(covers(zone, sliver), `感应区必须完整覆盖屏内那 1px（${inspect(sliver)}）`);
  eq(revealHits(SHOWN_RIGHT, { x: WA.x + WA.width, y: 375 }, WA, SLACK, HIDE_MODE_OFFSCREEN), true, '鼠标顶到屏幕最右边界必须命中');
  eq(
    revealHits(SHOWN_RIGHT, { x: WA.x + WA.width - OFFSCREEN_SLIVER / 2, y: 375 }, WA, SLACK, HIDE_MODE_OFFSCREEN),
    true,
    '鼠标落在那 1px 上必须命中',
  );
});

check('右边缘（offscreen）：离边缘较远的点 → false', () => {
  const p = centerOf(HIDDEN_RIGHT); // (1099, 375)：整块移出屏幕后，矩形中心已经在屏幕外了
  ok(p.x > WA.x + WA.width, 'offscreen 模式下隐藏矩形的中心确实在屏幕之外（这正是"移出去"的含义）');
  eq(shouldReveal(SHOWN_RIGHT, { x: 500, y: p.y }, WA), false, '鼠标在屏幕中间不应触发弹回');
  eq(shouldReveal(SHOWN_RIGHT, { x: HIDDEN_RIGHT.x - 60, y: p.y }, WA), false, '鼠标在感应区之外不应触发弹回');
  eq(shouldReveal(SHOWN_RIGHT, { x: p.x, y: HIDDEN_RIGHT.y - 60 }, WA), false, '鼠标在便签跨度之外不应触发弹回');
  eq(
    revealHits(SHOWN_RIGHT, inwardPoint(WA, EDGE_RIGHT, p.y, OFFSCREEN_SLIVER + SLACK + 1), WA, SLACK, HIDE_MODE_OFFSCREEN),
    false,
    `离边缘超过 ${OFFSCREEN_SLIVER}+${SLACK}px 就不该触发`,
  );
});

check('感应区 slack：默认 8、显式传参生效、非法值回落到默认（四参调用，两种模式）', () => {
  const p = { x: HIDDEN_RIGHT.x - 12, y: HIDDEN_RIGHT.y + HIDDEN_RIGHT.height / 2 }; // 屏内、离右边缘 13px 的点
  const dflt = revealZone(SHOWN_RIGHT, WA); // 省略 slack 与 mode
  deepEq(dflt, revealZone(SHOWN_RIGHT, WA, SLACK, HIDE_MODE_OFFSCREEN), `省略 slack/mode 必须等价于显式的 (${SLACK}, offscreen)`);
  eq(dflt.width, OFFSCREEN_SLIVER + SLACK, `offscreen 默认感应区宽度必须是 1 + ${SLACK}（不是旧的 6）`);
  eq(revealHits(SHOWN_RIGHT, p, WA, SLACK, HIDE_MODE_OFFSCREEN), false, `slack=${SLACK} 时离边缘 13px 的点够不到`);
  eq(revealHits(SHOWN_RIGHT, p, WA, SLACK_WIDE, HIDE_MODE_OFFSCREEN), true, `显式 slack=${SLACK_WIDE} 时必须覆盖到离边缘 13px 的点`);
  const wide = revealZone(SHOWN_RIGHT, WA, SLACK_WIDE, HIDE_MODE_OFFSCREEN);
  eq(wide.x, WA.x + WA.width - OFFSCREEN_SLIVER - SLACK_WIDE, `显式 slack=${SLACK_WIDE} 必须被采纳`);
  eq(wide.width, OFFSCREEN_SLIVER + SLACK_WIDE, `显式 slack=${SLACK_WIDE} 必须被采纳`);
  eq(wide.x + wide.width, WA.x + WA.width, '无论 slack 多大，感应区右边界仍要贴住屏幕右边缘');
  // tab 模式同样按四参调用，slack 也必须生效，只是起点由标签厚度决定
  const tabWide = revealZone(SHOWN_RIGHT, WA, SLACK_WIDE, HIDE_MODE_TAB);
  eq(tabWide.width, TAB_THICKNESS + SLACK_WIDE, `tab 模式下 slack=${SLACK_WIDE} 也必须被采纳`);
  eq(tabWide.x + tabWide.width, WA.x + WA.width, 'tab 模式感应区右边界同样贴住屏幕右边缘');
  const zero = revealZone(SHOWN_RIGHT, WA, 0, HIDE_MODE_OFFSCREEN);
  eq(zero.width, OFFSCREEN_SLIVER, 'slack=0 时感应区退化成屏内那 1px 本身');
  eq(revealHits(SHOWN_RIGHT, { x: WA.x + WA.width, y: 375 }, WA, 0, HIDE_MODE_OFFSCREEN), true, 'slack=0 时屏幕边缘那一点仍必须命中');
  eq(revealZone(SHOWN_RIGHT, WA, -5, HIDE_MODE_OFFSCREEN).width, OFFSCREEN_SLIVER, 'slack 为负数时按 0 处理');
  for (const bad of [NaN, Infinity, undefined, null]) {
    eq(revealZone(SHOWN_RIGHT, WA, bad, HIDE_MODE_OFFSCREEN).width, dflt.width, `slack=${String(bad)} 必须回落到默认值 ${SLACK}`);
    eq(
      revealZone(SHOWN_RIGHT, WA, bad, HIDE_MODE_TAB).width,
      TAB_THICKNESS + SLACK,
      `slack=${String(bad)} 在 tab 模式下也必须回落到默认值 ${SLACK}`,
    );
  }
});

check('左边缘：感应区贴住屏幕左边缘并覆盖屏内可见部分，边缘必然能命中（两种模式）', () => {
  for (const mode of MODES) {
    const hidden = mode === HIDE_MODE_TAB ? HIDDEN_LEFT_TAB : HIDDEN_LEFT;
    const along = centerOf(hidden).y;
    eq(revealHits(SHOWN_LEFT, { x: WA.x, y: along }, WA, SLACK, mode), true, `${mode}：屏幕最左边界（含边界）必须命中`);
    eq(revealHits(SHOWN_LEFT, { x: WA.x + SLACK, y: along }, WA, SLACK, mode), true, `${mode}：离边缘 slack=${SLACK}px 内必须命中`);
    eq(revealHits(SHOWN_LEFT, { x: 300, y: along }, WA, SLACK, mode), false, `${mode}：屏幕中部不应命中`);
    const zone = revealZone(SHOWN_LEFT, WA, SLACK, mode);
    eq(zone.x, WA.x, `${mode}：感应区左边界必须贴住屏幕左边缘 0`);
    eq(
      sizeOn(zone, EDGE_LEFT),
      sliverOnSnapAxis(hidden, WA, EDGE_LEFT) + SLACK,
      `${mode}：感应区厚度必须是"屏内可见厚度 + slack=${SLACK}"`,
    );
    inside(zone, WA, `${mode}：感应区必须留在工作区内`);
    ok(covers(zone, visibleSliver(hidden, WA)), `${mode}：感应区必须覆盖屏内可见的那部分`);
  }
});

check('上边缘：感应区贴住屏幕上边缘并覆盖屏内可见部分，边缘必然能命中（两种模式）', () => {
  for (const mode of MODES) {
    const hidden = mode === HIDE_MODE_TAB ? HIDDEN_TOP_TAB : HIDDEN_TOP;
    const along = centerOf(hidden).x;
    eq(revealHits(SHOWN_TOP, { x: along, y: WA.y }, WA, SLACK, mode), true, `${mode}：屏幕最上边界（含边界）必须命中`);
    eq(revealHits(SHOWN_TOP, { x: along, y: WA.y + SLACK }, WA, SLACK, mode), true, `${mode}：离边缘 slack=${SLACK}px 内必须命中`);
    eq(revealHits(SHOWN_TOP, { x: along, y: 300 }, WA, SLACK, mode), false, `${mode}：屏幕中部不应命中`);
    const zone = revealZone(SHOWN_TOP, WA, SLACK, mode);
    eq(zone.y, WA.y, `${mode}：感应区上边界必须贴住屏幕上边缘 0`);
    eq(
      sizeOn(zone, EDGE_TOP),
      sliverOnSnapAxis(hidden, WA, EDGE_TOP) + SLACK,
      `${mode}：感应区厚度必须是"屏内可见厚度 + slack=${SLACK}"`,
    );
    inside(zone, WA, `${mode}：感应区必须留在工作区内`);
    ok(covers(zone, visibleSliver(hidden, WA)), `${mode}：感应区必须覆盖屏内可见的那部分`);
  }
});

check('下边缘：感应区贴住屏幕下边缘并覆盖屏内可见部分，边缘必然能命中（两种模式）', () => {
  for (const mode of MODES) {
    const hidden = mode === HIDE_MODE_TAB ? HIDDEN_BOTTOM_TAB : HIDDEN_BOTTOM;
    const along = centerOf(hidden).x;
    eq(revealHits(SHOWN_BOTTOM, { x: along, y: WA.y + WA.height }, WA, SLACK, mode), true, `${mode}：屏幕最下边界（含边界）必须命中`);
    eq(revealHits(SHOWN_BOTTOM, { x: along, y: WA.y + WA.height - SLACK }, WA, SLACK, mode), true, `${mode}：离边缘 slack=${SLACK}px 内必须命中`);
    eq(revealHits(SHOWN_BOTTOM, { x: along, y: 400 }, WA, SLACK, mode), false, `${mode}：屏幕中部不应命中`);
    const zone = revealZone(SHOWN_BOTTOM, WA, SLACK, mode);
    eq(zone.y + zone.height, WA.y + WA.height, `${mode}：感应区下边界必须贴住屏幕下边缘 800`);
    eq(
      sizeOn(zone, EDGE_BOTTOM),
      sliverOnSnapAxis(hidden, WA, EDGE_BOTTOM) + SLACK,
      `${mode}：感应区厚度必须是"屏内可见厚度 + slack=${SLACK}"`,
    );
    inside(zone, WA, `${mode}：感应区必须留在工作区内`);
    ok(covers(zone, visibleSliver(hidden, WA)), `${mode}：感应区必须覆盖屏内可见的那部分`);
  }
});

check('edge === null：两种模式下 revealZone 都返回 null、shouldReveal 返回 false，且都不抛异常', () => {
  const plain = note(null, 100, 100);
  const zone = noThrow(() => revealZone(plain, WA), 'edge=null 时 revealZone 不应抛异常');
  eq(zone, null, 'edge=null 时 revealZone 必须返回 null');
  const result = noThrow(() => shouldReveal(plain, { x: 100, y: 100 }, WA), 'edge=null 时 shouldReveal 不应抛异常');
  eq(result, false, 'edge=null 时 shouldReveal 必须返回 false');
  eq(shouldReveal(plain, { x: -9999, y: -9999 }, WA), false, '屏幕外的点也必须是 false');
  for (const mode of MODES) {
    eq(noThrow(() => revealZone(plain, WA, SLACK, mode), `mode=${mode} 时不应抛异常`), null, `mode=${mode}：edge=null → null`);
    eq(revealHits(plain, { x: 100, y: 100 }, WA, SLACK, mode), false, `mode=${mode}：edge=null → false`);
    eq(revealHits(plain, { x: WA.x, y: WA.y }, WA, SLACK, mode), false, `mode=${mode}：屏幕角落的点也必须是 false`);
  }
});

check('edge 是 undefined / 未知字符串时同样返回 null + false（两种模式），不抛异常', () => {
  const noEdgeKey = { x: 100, y: 100, width: 200, height: 150 };
  eq(noThrow(() => revealZone(noEdgeKey, WA), 'edge 缺失时 revealZone 不应抛异常'), null, 'edge 缺失 → null');
  eq(shouldReveal(noEdgeKey, { x: 100, y: 100 }, WA), false, 'edge 缺失 → false');
  eq(revealZone(note('LEFT', 100, 100), WA), null, '未知 edge → null');
  for (const mode of MODES) {
    eq(revealZone(noEdgeKey, WA, SLACK, mode), null, `mode=${mode}：edge 缺失 → null`);
    eq(revealZone(note('LEFT', 100, 100), WA, SLACK, mode), null, `mode=${mode}：未知 edge → null`);
    eq(revealHits(note('', 100, 100), { x: WA.x, y: WA.y }, WA, SLACK, mode), false, `mode=${mode}：空字符串 edge → false`);
  }
});

check('pointInRect：边界包含（左闭右闭）、rect 为 null/undefined 时返回 false', () => {
  const r = { x: 10, y: 10, width: 100, height: 50 };
  eq(pointInRect({ x: 10, y: 10 }, r), true, '左上角点应算命中');
  eq(pointInRect({ x: 110, y: 60 }, r), true, '右下角点应算命中');
  eq(pointInRect({ x: 111, y: 60 }, r), false, '右边界外 1px 应算不命中');
  eq(pointInRect({ x: 10, y: 61 }, r), false, '下边界外 1px 应算不命中');
  eq(pointInRect({ x: 10, y: 10 }, null), false, 'rect=null 应返回 false');
  eq(pointInRect({ x: 10, y: 10 }, undefined), false, 'rect=undefined 应返回 false');
});

check('shouldReveal 与 revealZone 同源：shouldReveal(note, point, area, slack) 恒等于按默认 offscreen 模式的判定', () => {
  // shouldReveal 只有四个参数（没有 mode），内部固定按默认的 offscreen 模式算感应区。
  for (const { edge, shown, off } of EDGE_SCENARIOS) {
    const p = centerOf(visibleSliver(off, WA)); // 屏内可见那部分的中心
    eq(shouldReveal(shown, p, WA), revealHits(shown, p, WA, SLACK, HIDE_MODE_OFFSCREEN), `${edge}：省略 slack 时必须与 offscreen 模式的 revealZone 同源`);
    eq(shouldReveal(shown, p, WA), true, `${edge}：屏内可见部分的中心必须能触发弹回`);
    eq(shouldReveal(shown, p, WA, SLACK_WIDE), revealHits(shown, p, WA, SLACK_WIDE, HIDE_MODE_OFFSCREEN), `${edge}：显式 slack 时也必须同源`);
    eq(shouldReveal(shown, p, WA, 0), revealHits(shown, p, WA, 0, HIDE_MODE_OFFSCREEN), `${edge}：slack=0 时也必须同源`);
    eq(shouldReveal(shown, p, WA, 0), true, `${edge}：slack=0 时屏内那部分仍必须能命中`);
  }
});

check('回归：四条边隐藏后，屏幕边缘（便签跨度内）的点都必须能触发弹回（便签不会"永远回不来"）', () => {
  for (const scenario of EDGE_SCENARIOS) {
    const { edge, shown } = scenario;
    for (const mode of MODES) {
      const hidden = hiddenIn(scenario, mode);
      const hiddenNote = { edge, ...hidden };
      const sliver = visibleSliver(hidden, WA);
      ok(sliver.width > 0 && sliver.height > 0, `${edge}｜${mode}：隐藏后必须有像素留在屏幕内`);
      const zone = revealZone(shown, WA, SLACK, mode);
      ok(zone !== null && overlaps(zone, WA), `${edge}｜${mode}：感应区与工作区的交集必须非空（鼠标只能在工作区内移动）`);
      eq(sizeOn(zone, edge), sizeOn(sliver, edge) + SLACK, `${edge}｜${mode}：感应区厚度必须是"屏内可见厚度 + slack=${SLACK}"`);
      const along = centerOf(hidden)[alongAxisOf(edge)];
      eq(revealHits(shown, edgePoint(WA, edge, along), WA, SLACK, mode), true, `${edge}｜${mode}：鼠标推到屏幕边缘必须能触发弹回`);
      eq(revealHits(shown, centerOf(sliver), WA, SLACK, mode), true, `${edge}｜${mode}：屏内可见部分的中心必须能触发弹回`);
      eq(revealHits(hiddenNote, edgePoint(WA, edge, along), WA, SLACK, mode), true, `${edge}｜${mode}：传入隐藏态坐标也必须能触发弹回`);
      if (mode === HIDE_MODE_TAB) {
        inside(hidden, WA, `${edge}：tab 标签必须完全落在工作区内`);
        eq(tabThicknessOnScreen(hidden, edge), TAB_THICKNESS, `${edge}：标签厚度必须是 TAB_THICKNESS`);
        ok(
          tabThicknessOnScreen(hidden, edge) >= PLATFORM_MIN_WINDOW_WIDTH,
          `${edge}：标签厚度必须 >= 平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px`,
        );
      } else {
        eq(sliverOnSnapAxis(hidden, WA, edge), OFFSCREEN_SLIVER, `${edge}：offscreen 与工作区的交集必须恰好是那 1px`);
        eq(sizeOn(hidden, edge), sizeOn(shown, edge), `${edge}：offscreen 必须保持便签原尺寸`);
        ok(!fullyInside(hidden, WA), `${edge}：offscreen 故意不完全落在工作区内`);
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
group('[6] constrainSize —— 最小尺寸约束');
// ─────────────────────────────────────────────────────────────────────────────
check('导出常量：MIN_NOTE_WIDTH === 140、MIN_NOTE_HEIGHT === 90', () => {
  eq(MIN_NOTE_WIDTH, 140, '最小宽度必须是 140');
  eq(MIN_NOTE_HEIGHT, 90, '最小高度必须是 90');
});

check('小于最小尺寸 → 抬到 140x90', () => {
  deepEq(constrainSize(100, 50), { width: 140, height: 90 }, '100x50 应被抬到 140x90');
  deepEq(constrainSize(0, 0), { width: 140, height: 90 }, '0x0 应被抬到 140x90');
  deepEq(constrainSize(-500, -500), { width: 140, height: 90 }, '负尺寸应被抬到 140x90');
});

check('刚好差 1px → 也要抬到最小值', () => {
  deepEq(constrainSize(139, 89), { width: 140, height: 90 }, '139x89 应被抬到 140x90');
});

check('大于最小尺寸 → 保留，并四舍五入为整数', () => {
  deepEq(constrainSize(300, 200), { width: 300, height: 200 }, '合法尺寸不应被改动');
  deepEq(constrainSize(300.4, 200.6), { width: 300, height: 201 }, '小数应四舍五入成整数像素');
  eq(constrainSize(140, 90).width, 140, '正好等于最小值时保持 140');
});

check('NaN / undefined / null / 字符串输入 → 回落到最小值，不产生 NaN', () => {
  for (const [w, h] of [[NaN, NaN], [undefined, undefined], [null, null], ['abc', 'abc'], [Infinity, -Infinity]]) {
    const out = noThrow(() => constrainSize(w, h), `constrainSize(${String(w)}, ${String(h)}) 不应抛异常`);
    isFiniteNum(out.width, `width 输入 ${String(w)} 时输出必须是有限数字`);
    isFiniteNum(out.height, `height 输入 ${String(h)} 时输出必须是有限数字`);
    eq(out.width, MIN_NOTE_WIDTH, `width 输入 ${String(w)} 时应回落到 ${MIN_NOTE_WIDTH}`);
    eq(out.height, MIN_NOTE_HEIGHT, `height 输入 ${String(h)} 时应回落到 ${MIN_NOTE_HEIGHT}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
group('[7] placeNear —— 新便签落点');
// ─────────────────────────────────────────────────────────────────────────────
check('普通锚点：结果完全落在工作区内，且 x/y 是数字', () => {
  const p = placeNear({ x: 100, y: 100 }, 200, 150, WA);
  isFiniteNum(p.x, 'x 必须是有限数字');
  isFiniteNum(p.y, 'y 必须是有限数字');
  inside({ ...p, width: 200, height: 150 }, WA, '放置结果必须完全落在工作区内');
});

check('锚点在右下角：不得越界（回归：便签跑到屏幕外）', () => {
  const p = placeNear({ x: 995, y: 795 }, 200, 150, WA);
  inside({ ...p, width: 200, height: 150 }, WA, '右下角锚点的结果必须仍在工作区内');
  eq(p.x, WA.x + WA.width - 200, 'x 应被夹到 800');
  eq(p.y, WA.y + WA.height - 150, 'y 应被夹到 650');
});

check('锚点在工作区外（负坐标 / 超大坐标）：仍落在工作区内', () => {
  const topLeft = placeNear({ x: -800, y: -600 }, 200, 150, WA);
  inside({ ...topLeft, width: 200, height: 150 }, WA, '负坐标锚点的结果必须仍在工作区内');
  eq(topLeft.x, WA.x, 'x 夹到左边界 0');
  eq(topLeft.y, WA.y, 'y 夹到上边界 0');
  const bottomRight = placeNear({ x: 99999, y: 99999 }, 200, 150, WA);
  inside({ ...bottomRight, width: 200, height: 150 }, WA, '超大坐标锚点的结果必须仍在工作区内');
});

check('请求尺寸小于最小值：先抬到 140x90 再落位，仍不越界', () => {
  const p = placeNear({ x: 980, y: 780 }, 10, 10, WA);
  eq(p.x, WA.x + WA.width - MIN_NOTE_WIDTH, 'x 必须按 140 宽夹取（860）');
  eq(p.y, WA.y + WA.height - MIN_NOTE_HEIGHT, 'y 必须按 90 高夹取（710）');
  inside({ ...p, width: MIN_NOTE_WIDTH, height: MIN_NOTE_HEIGHT }, WA, '最小尺寸便签也必须完全在工作区内');
});

check('第二显示器（非零原点）：结果落在该显示器工作区内', () => {
  const p = placeNear({ x: 2000, y: 100 }, 300, 200, WA_SECOND);
  inside({ ...p, width: 300, height: 200 }, WA_SECOND, '第二屏上的落点必须完全在第二屏工作区内');
  eq(p.x, 2000 + 24, '正常情况应落在锚点右下 24px');
  eq(p.y, 100 + 24, '正常情况应落在锚点右下 24px');
});

check('便签比工作区还大 → 仍返回有限数字、不抛异常', () => {
  const p = noThrow(() => placeNear({ x: 100, y: 100 }, 5000, 5000, WA), '超大尺寸不应抛异常');
  isFiniteNum(p.x, '超大尺寸时 x 仍必须是有限数字');
  isFiniteNum(p.y, '超大尺寸时 y 仍必须是有限数字');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[8] 回归：隐藏后必须留在屏幕内、鼠标够得到（两种模式都成立）');
// ─────────────────────────────────────────────────────────────────────────────
/**
 * 两种模式共有的"还够得着"保证：
 *   1) 隐藏矩形与工作区的交集非空（至少 1px 在屏内，鼠标才有东西可碰）；
 *   2) 屏内可见部分是有面积的（存在可见宽度与可见高度）；
 *   3) revealZone 与工作区的交集非空（鼠标只能在工作区内移动）；
 *   4) 屏幕边缘、落在隐藏跨度中央的那个点必须能触发唤出。
 * offscreen 模式下隐藏矩形本来就有一部分在屏外，"留在屏幕内"的正确表述就是这四条。
 */
function assertReachable(n, mode, why) {
  const hidden = { edge: n.edge, ...hiddenBounds(n, WA, mode) };
  ok(overlaps(hidden, WA), `${why}｜${mode}：隐藏后必须仍有像素留在屏幕内，实际 ${inspect(hidden)}`);
  const sliver = visibleSliver(hidden, WA);
  ok(sliver.width > 0 && sliver.height > 0, `${why}｜${mode}：屏内可见部分必须有面积，实际 ${inspect(sliver)}`);
  ok(overlaps(sliver, WA), `${why}｜${mode}：屏内可见部分必须真的压在屏幕内`);
  const zone = revealZone(n, WA, SLACK, mode);
  ok(zone !== null && overlaps(zone, WA), `${why}｜${mode}：感应区与工作区的交集必须非空（鼠标只能在工作区内移动）`);
  const along = centerOf(hidden)[alongAxisOf(n.edge)];
  eq(revealHits(n, edgePoint(WA, n.edge, along), WA, SLACK, mode), true, `${why}｜${mode}：鼠标推到屏幕边缘必须能唤出便签`);
  assertAlongClamped(hidden, WA, n.edge, `${why}｜${mode}：沿边坐标必须被夹进工作区`);
  return hidden;
}

check('已修 bug：便签仍有可见部分时，隐藏后绝不允许整块飞出屏幕外（两种模式）', () => {
  // 这三个用例在修复前会让标签整块落在工作区之外：
  //   修复前 bottom 例的标签是 (-130, 794)，right 例是 (994, -124)，left 例是 (0, 801)
  // —— 屏幕上一点像素都没有，鼠标永远进不了感应区，便签再也弹不回来。
  const cases = [
    { why: '大号便签吸附下边缘时左侧仍在屏幕外', n: { edge: EDGE_BOTTOM, x: -356, y: 147, width: 571, height: 653 } },
    { why: '高便签吸附右边缘时上方仍在屏幕外', n: { edge: EDGE_RIGHT, x: 160, y: -152, width: 840, height: 175 } },
    { why: '便签吸附左边缘时下方仍在屏幕外', n: { edge: EDGE_LEFT, x: 0, y: 607, width: 441, height: 507 } },
  ];
  for (const mode of MODES) {
    for (const { why, n } of cases) {
      const hidden = assertReachable(n, mode, why);
      if (mode === HIDE_MODE_TAB) {
        inside(hidden, WA, `${why}｜tab：标签必须完全落在工作区内`);
        eq(tabThicknessOnScreen(hidden, n.edge), TAB_THICKNESS, `${why}｜tab：标签厚度必须是 TAB_THICKNESS`);
      } else {
        eq(sliverOnSnapAxis(hidden, WA, n.edge), OFFSCREEN_SLIVER, `${why}｜offscreen：与工作区的交集恰好那 1px（真的移出去了，但还够得着）`);
        eq(sizeOn(hidden, n.edge), sizeOn(n, n.edge), `${why}｜offscreen：尺寸保持便签原尺寸`);
        ok(!fullyInside(hidden, WA), `${why}｜offscreen：故意不完全落在工作区内`);
      }
    }
  }
});

check('已修 bug 的真实场景：便签被拖到屏幕左上角之外、吸附左边后隐藏，仍要够得到（两种模式）', () => {
  // 用户把 400x300 的便签甩到左上角外面：左边缘超出 396px、上边缘超出 250px。
  // snapToEdge 只会对齐最近的那条边（这里是最负的 left），上边缘的超出会保留下来。
  const dragged = { x: -396, y: -250, width: 400, height: 300 };
  const snapped = snapToEdge(dragged, WA, THRESHOLD);
  eq(snapped.edge, EDGE_LEFT, '最近的是左边缘，应吸附左边');
  eq(snapped.y, -250, '吸附只修正被选中的那条边，y 原样保留（这是既有设计）');
  const shown = { edge: snapped.edge, x: snapped.x, y: snapped.y, width: 400, height: 300 };
  for (const mode of MODES) {
    const hidden = assertReachable(shown, mode, '拖到屏幕左上角之外');
    if (mode === HIDE_MODE_TAB) {
      inside(hidden, WA, 'tab：标签必须完全落在工作区内（修复前是 {x:0,y:-160}，整块在屏幕外）');
      eq(tabThicknessOnScreen(hidden, EDGE_LEFT), TAB_THICKNESS, 'tab：标签厚度必须是 TAB_THICKNESS');
      eq(hidden.y, WA.y, 'tab：沿边坐标被夹回工作区顶部');
    } else {
      eq(hidden.y, WA.y, 'offscreen：沿边坐标被夹回工作区顶部（否则那 1px 会跑到屏幕上边界之外）');
      eq(hidden.x, WA.x - 400 + OFFSCREEN_SLIVER, 'offscreen：x 推到屏幕左侧之外，只留那 1px');
      eq(sliverOnSnapAxis(hidden, WA, EDGE_LEFT), OFFSCREEN_SLIVER, 'offscreen：与工作区的交集恰好那 1px');
    }
  }
});

check('已修 bug 的真实场景：换了显示器布局后存档坐标整个落在屏幕外，隐藏后仍要够得到（两种模式）', () => {
  // notes.mjs 启动时会用存档里的 x/y 直接算 hiddenBounds：换了显示器布局后存档坐标可能整块
  // 落在当前工作区之外。此时隐藏矩形必须被拉回工作区边缘，用户才找得回便签。
  const stale = { edge: EDGE_RIGHT, x: 5000, y: 5000, width: 200, height: 150 };
  const tab = hiddenBounds(stale, WA, HIDE_MODE_TAB);
  eq(tab.x, WA.x + WA.width - TAB_THICKNESS, 'tab：仍然贴住右边缘');
  eq(tab.y, WA.y + WA.height - tab.height, 'tab：标签纵向被拉回工作区底部（修复前是 y=5015，全在屏幕外）');
  inside(tab, WA, 'tab：标签必须完全落在工作区内');
  eq(tabThicknessOnScreen(tab, EDGE_RIGHT), TAB_THICKNESS, 'tab：标签厚度必须是 TAB_THICKNESS');
  const off = hiddenBounds(stale, WA); // 省略 mode → 默认 offscreen
  eq(off.x, WA.x + WA.width - OFFSCREEN_SLIVER, 'offscreen：x 推到屏幕右边界之外，只留那 1px');
  eq(off.y, WA.y + WA.height - off.height, 'offscreen：沿边方向被夹回工作区底部（修复前是 y=5015，鼠标够不到）');
  eq(off.width, stale.width, 'offscreen：尺寸保持便签原尺寸');
  eq(off.height, stale.height, 'offscreen：尺寸保持便签原尺寸');
  eq(sliverOnSnapAxis(off, WA, EDGE_RIGHT), OFFSCREEN_SLIVER, 'offscreen：与工作区的交集恰好那 1px');
  ok(!fullyInside(off, WA), 'offscreen：故意不完全落在工作区内（这正是"移出去"）');
  for (const mode of MODES) {
    assertReachable(stale, mode, '换了显示器布局');
  }
});

check('修 bug 不能破坏正常行为：便签本来就在工作区内时，tab 仍精确居中、offscreen 坐标尺寸都不动', () => {
  for (const { edge, shown } of SHOWN_CASES) {
    const tab = hiddenBounds({ edge, ...shown }, WA, HIDE_MODE_TAB);
    if (edge === EDGE_LEFT || edge === EDGE_RIGHT) {
      near(tab.y + tab.height / 2, shown.y + shown.height / 2, `${edge}｜tab：纵向仍应居中`, 1);
    } else {
      near(tab.x + tab.width / 2, shown.x + shown.width / 2, `${edge}｜tab：横向仍应居中`, 1);
    }
    eq(tabThicknessOnScreen(tab, edge), TAB_THICKNESS, `${edge}｜tab：厚度仍是固定的 TAB_THICKNESS`);
    inside(tab, WA, `${edge}｜tab：标签仍完全落在工作区内`);
    const off = hiddenBounds({ edge, ...shown }, WA); // 默认 offscreen
    eq(sizeOn(off, edge), sizeOn(shown, edge), `${edge}｜offscreen：吸附轴尺寸保持便签原尺寸`);
    eq(alongSizeOf(off, edge), alongSizeOf(shown, edge), `${edge}｜offscreen：沿边轴尺寸保持便签原尺寸`);
    eq(
      off[alongAxisOf(edge)],
      shown[alongAxisOf(edge)],
      `${edge}｜offscreen：便签本来就在屏内，沿边坐标不需要夹取，必须原样保留`,
    );
    eq(sliverOnSnapAxis(off, WA, edge), OFFSCREEN_SLIVER, `${edge}｜offscreen：与工作区的交集仍恰好那 1px`);
    ok(!fullyInside(off, WA), `${edge}｜offscreen：仍然有一部分移到屏幕外`);
    assertReachable({ edge, ...shown }, HIDE_MODE_OFFSCREEN, `${edge} 便签本来就在工作区内`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
group('[9] 随机不变量回归（固定随机种子，可复现）');
// ─────────────────────────────────────────────────────────────────────────────
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

check('300 组随机工作区/便签：吸附、隐藏、感应、落点的关键不变量全部成立', () => {
  const random = makeRandom(20240617);
  const randInt = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  for (let i = 0; i < 300; i += 1) {
    const area = {
      x: randInt(-1920, 1920),
      y: randInt(-300, 300),
      width: randInt(320, 2560),
      height: randInt(240, 1440),
    };
    const width = randInt(160, area.width);
    const height = randInt(100, area.height);
    const shown = {
      x: randInt(area.x, area.x + area.width - width),
      y: randInt(area.y, area.y + area.height - height),
      width,
      height,
    };
    const threshold = randInt(0, 40);
    const slack = randInt(0, 20);
    const tag = `#${i} 工作区=${inspect(area)} 便签=${inspect(shown)} 阈值=${threshold} slack=${slack}`;

    for (const edge of ALL_EDGES) {
      // 1) 贴边吸附：坐标有限；吸附成功的那条边必须精确贴边
      const corner = edge === EDGE_LEFT ? { ...shown, x: area.x + randInt(0, threshold) }
        : edge === EDGE_RIGHT ? { ...shown, x: area.x + area.width - width - randInt(0, threshold) }
          : edge === EDGE_TOP ? { ...shown, y: area.y + randInt(0, threshold) }
            : { ...shown, y: area.y + area.height - height - randInt(0, threshold) };
      const snapped = snapToEdge(corner, area, threshold);
      isFiniteNum(snapped.x, `${tag}｜贴 ${edge} 吸附后 x 必须有限`);
      isFiniteNum(snapped.y, `${tag}｜贴 ${edge} 吸附后 y 必须有限`);
      isEdge(snapped.edge, `${tag}｜edge 必须是合法值`);
      if (snapped.edge === EDGE_LEFT) eq(snapped.x, area.x, `${tag}｜应精确贴住左边`);
      if (snapped.edge === EDGE_RIGHT) near(snapped.x + width, area.x + area.width, `${tag}｜应精确贴住右边`);
      if (snapped.edge === EDGE_TOP) eq(snapped.y, area.y, `${tag}｜应精确贴住上边`);
      if (snapped.edge === EDGE_BOTTOM) near(snapped.y + height, area.y + area.height, `${tag}｜应精确贴住下边`);

      // 2) 隐藏：两种模式分别检查
      const noteAfterSnap = { edge, x: snapped.x, y: snapped.y, width, height };
      for (const mode of MODES) {
        const hidden = hiddenBounds(noteAfterSnap, area, mode);
        isFiniteNum(hidden.x, `${tag}｜${edge}｜${mode} 隐藏后 x 必须有限`);
        isFiniteNum(hidden.y, `${tag}｜${edge}｜${mode} 隐藏后 y 必须有限`);
        isFiniteNum(hidden.width, `${tag}｜${edge}｜${mode} 隐藏后 width 必须有限`);
        isFiniteNum(hidden.height, `${tag}｜${edge}｜${mode} 隐藏后 height 必须有限`);
        ok(overlaps(hidden, area), `${tag}｜${edge}｜${mode} 隐藏后必须仍有像素留在屏幕内（否则鼠标永远够不到）`);
        assertAlongClamped(hidden, area, edge, `${tag}｜${edge}｜${mode} 沿边坐标必须被夹进工作区`);

        // 3) 感应区：锚定屏幕边缘、留在工作区内、覆盖屏内可见部分、与工作区交集非空
        const zone = revealZone(noteAfterSnap, area, slack, mode);
        ok(zone !== null, `${tag}｜${edge}｜${mode} 感应区不应为 null`);
        ok(overlaps(zone, area), `${tag}｜${edge}｜${mode} 感应区与工作区必须有交集（鼠标只能在工作区内移动）`);
        inside(zone, area, `${tag}｜${edge}｜${mode} 感应区必须留在工作区内`);
        const sliver = visibleSliver(hidden, area);
        ok(zone.x <= sliver.x && zone.x + zone.width >= sliver.x + sliver.width
          && zone.y <= sliver.y && zone.y + zone.height >= sliver.y + sliver.height,
        `${tag}｜${edge}｜${mode} 感应区必须覆盖屏内可见的那部分`);
        eq(sizeOn(zone, edge), sizeOn(sliver, edge) + slack, `${tag}｜${edge}｜${mode} 感应区厚度必须是"屏内可见厚度 + slack"`);
        if (edge === EDGE_LEFT) eq(zone.x, area.x, `${tag}｜左感应区必须贴住左边缘`);
        if (edge === EDGE_RIGHT) eq(zone.x + zone.width, area.x + area.width, `${tag}｜右感应区必须贴住右边缘`);
        if (edge === EDGE_TOP) eq(zone.y, area.y, `${tag}｜上感应区必须贴住上边缘`);
        if (edge === EDGE_BOTTOM) eq(zone.y + zone.height, area.y + area.height, `${tag}｜下感应区必须贴住下边缘`);

        // 4) 屏幕边缘、便签在屏内跨度中央的点必须能触发弹回（两种模式都要成立）
        const alongEdge = reachableAlong(noteAfterSnap, hidden, area, edge);
        if (alongEdge !== null) {
          // offscreen 分支直接用 shouldReveal（它固定按默认模式），tab 分支显式走四参 revealZone
          const hits = (point) => (mode === HIDE_MODE_OFFSCREEN
            ? shouldReveal(noteAfterSnap, point, area, slack)
            : revealHits(noteAfterSnap, point, area, slack, mode));
          eq(hits(edgePoint(area, edge, alongEdge)), true, `${tag}｜${edge}｜${mode} 屏幕边缘（离边缘 0px）必须能触发弹回`);
          eq(
            hits(inwardPoint(area, edge, alongEdge, Math.floor(slack / 2))),
            true,
            `${tag}｜${edge}｜${mode} 离边缘 slack/2 以内必须能触发弹回`,
          );
        }

        // 5) 两种模式各自的专属不变量
        if (mode === HIDE_MODE_OFFSCREEN) {
          eq(sizeOn(hidden, edge), sizeOn(noteAfterSnap, edge), `${tag}｜${edge}｜offscreen 吸附轴尺寸必须保持不变`);
          eq(hidden.width, width, `${tag}｜${edge}｜offscreen 宽度必须保持便签原尺寸`);
          eq(hidden.height, height, `${tag}｜${edge}｜offscreen 高度必须保持便签原尺寸`);
          eq(
            sliverOnSnapAxis(hidden, area, edge),
            Math.min(OFFSCREEN_SLIVER, sizeOn(noteAfterSnap, edge)),
            `${tag}｜${edge}｜offscreen 与工作区的交集在吸附轴上必须恰好是 OFFSCREEN_SLIVER`,
          );
          ok(!fullyInside(hidden, area), `${tag}｜${edge}｜offscreen 故意不完全落在工作区内`);
        } else {
          inside(hidden, area, `${tag}｜${edge}｜tab 标签必须完全落在工作区内`);
          eq(tabThicknessOnScreen(hidden, edge), TAB_THICKNESS, `${tag}｜${edge}｜tab 厚度必须恒为 TAB_THICKNESS`);
          ok(
            tabThicknessOnScreen(hidden, edge) >= PLATFORM_MIN_WINDOW_WIDTH,
            `${tag}｜${edge}｜tab 厚度必须 >= 平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px，否则窗口会被系统撑大`,
          );
          eq(
            alongSizeOf(hidden, edge),
            tabSpanOf(alongSizeOf(noteAfterSnap, edge)),
            `${tag}｜${edge}｜tab 跨度必须按 TAB_MIN_SPAN..TAB_SPAN 收敛`,
          );
        }
      }

      // 6) 便签本来就在工作区内部时：
      //    tab → 标签居中于原跨度（±1px 取整误差）；offscreen → 尺寸与沿边坐标都原样保留
      const inner = { edge, ...shown };
      const innerTab = hiddenBounds(inner, area, HIDE_MODE_TAB);
      if (edge === EDGE_LEFT || edge === EDGE_RIGHT) {
        near(innerTab.y + innerTab.height / 2, shown.y + shown.height / 2, `${tag}｜${edge} tab 标签应纵向居中`, 1);
      } else {
        near(innerTab.x + innerTab.width / 2, shown.x + shown.width / 2, `${tag}｜${edge} tab 标签应横向居中`, 1);
      }
      const innerOff = hiddenBounds(inner, area, HIDE_MODE_OFFSCREEN);
      eq(innerOff.width, width, `${tag}｜${edge} offscreen 尺寸不随隐藏改变`);
      eq(innerOff.height, height, `${tag}｜${edge} offscreen 尺寸不随隐藏改变`);
      eq(innerOff[alongAxisOf(edge)], shown[alongAxisOf(edge)], `${tag}｜${edge} offscreen 沿边坐标必须原样保留`);
      eq(sliverOnSnapAxis(innerOff, area, edge), OFFSCREEN_SLIVER, `${tag}｜${edge} offscreen 与工作区的交集恰好 1px`);
    }

    // 7) 完全落在工作区内部（四面都留出 >=1px 余量）时不吸附、坐标不变
    if (area.width - width >= 3 && area.height - height >= 3) {
      const inner = {
        x: area.x + Math.max(1, Math.floor((area.width - width) / 2)),
        y: area.y + Math.max(1, Math.floor((area.height - height) / 2)),
        width,
        height,
      };
      const far = snapToEdge(inner, area, 0);
      eq(far.edge, null, `${tag}｜阈值 0 且四边都有余量时不应吸附`);
      eq(far.x, inner.x, `${tag}｜不吸附时 x 必须原样返回`);
      eq(far.y, inner.y, `${tag}｜不吸附时 y 必须原样返回`);
    }

    // 8) placeNear 必须完全落在工作区内
    const anchor = { x: randInt(area.x - 500, area.x + area.width + 500), y: randInt(area.y - 500, area.y + area.height + 500) };
    const placed = placeNear(anchor, width, height, area);
    isFiniteNum(placed.x, `${tag}｜placeNear x 必须有限`);
    isFiniteNum(placed.y, `${tag}｜placeNear y 必须有限`);
    inside({ ...placed, width, height }, area, `${tag}｜placeNear 结果必须完全在工作区内`);

    // 9) clampX / clampY 幂等且在界内
    const cx = clampX(anchor.x, width, area);
    isFiniteNum(cx, `${tag}｜clampX 必须有限`);
    ok(cx >= area.x && cx + width <= area.x + area.width + 1e-9, `${tag}｜clampX 结果必须在界内`);
    eq(clampX(cx, width, area), cx, `${tag}｜clampX 必须幂等`);
    const cy = clampY(anchor.y, height, area);
    isFiniteNum(cy, `${tag}｜clampY 必须有限`);
    ok(cy >= area.y && cy + height <= area.y + area.height + 1e-9, `${tag}｜clampY 结果必须在界内`);
    eq(clampY(cy, height, area), cy, `${tag}｜clampY 必须幂等`);
  }
});

check('500 组"随手乱拖"的便签：只要便签还有一部分可见，两种模式隐藏后都必须留在屏幕内且够得到', () => {
  const random = makeRandom(77251209);
  const randInt = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  let hiddenCount = 0;
  for (let i = 0; i < 500; i += 1) {
    const area = { x: 0, y: 0, width: 1000, height: 800 };
    const width = randInt(140, 900);
    const height = randInt(90, 700);
    // 故意允许便签被拖到工作区外面（只要求还有一部分压在工作区内）
    const shown = {
      x: randInt(area.x - width + 1, area.x + area.width - 1),
      y: randInt(area.y - height + 1, area.y + area.height - 1),
      width,
      height,
    };
    const snapped = snapToEdge(shown, area, THRESHOLD);
    if (snapped.edge === null) continue;
    const tag = `#${i} 拖动后=${inspect(shown)} 吸附=${inspect(snapped)}`;
    const noteAfterSnap = { edge: snapped.edge, x: snapped.x, y: snapped.y, width, height };
    if (!overlaps(noteAfterSnap, area)) continue; // 便签已经完全看不见，不属于本回归
    hiddenCount += 1;
    for (const mode of MODES) {
      const hidden = hiddenBounds(noteAfterSnap, area, mode);
      // 共同的底线：隐藏矩形与工作区交集非空（至少 1px 在屏内），感应区也必须与工作区有交集
      ok(
        overlaps(hidden, area),
        `${tag}｜${mode}｜隐藏后必须仍有像素留在屏幕内，否则这块便签再也点不回来（实际 ${inspect(hidden)}）`,
      );
      const zone = revealZone(noteAfterSnap, area, SLACK, mode);
      ok(zone !== null && overlaps(zone, area), `${tag}｜${mode}｜感应区与工作区必须有交集（鼠标只能在工作区内移动）`);
      const span = reachableAlong(noteAfterSnap, hidden, area, snapped.edge);
      if (span !== null) {
        eq(
          revealHits(noteAfterSnap, edgePoint(area, snapped.edge, span), area, SLACK, mode),
          true,
          `${tag}｜${mode}｜屏幕边缘（便签跨度内）必须能触发弹回`,
        );
      }
      if (mode === HIDE_MODE_TAB) {
        inside(hidden, area, `${tag}｜tab｜标签必须整块留在屏幕内，否则这块便签再也点不回来`);
        eq(tabThicknessOnScreen(hidden, snapped.edge), TAB_THICKNESS, `${tag}｜tab｜厚度必须恒为 TAB_THICKNESS`);
        ok(
          tabThicknessOnScreen(hidden, snapped.edge) >= PLATFORM_MIN_WINDOW_WIDTH,
          `${tag}｜tab｜厚度必须 >= 平台最小窗口宽度 ${PLATFORM_MIN_WINDOW_WIDTH}px`,
        );
      } else {
        eq(
          sliverOnSnapAxis(hidden, area, snapped.edge),
          Math.min(OFFSCREEN_SLIVER, sizeOn(noteAfterSnap, snapped.edge)),
          `${tag}｜offscreen｜与工作区的交集必须恰好是那 1px`,
        );
        eq(sizeOn(hidden, snapped.edge), sizeOn(noteAfterSnap, snapped.edge), `${tag}｜offscreen｜尺寸必须保持不变`);
        ok(!fullyInside(hidden, area), `${tag}｜offscreen｜故意不完全落在工作区内`);
      }
    }
  }
  ok(hiddenCount > 100, `样本量应当足够（实际覆盖了 ${hiddenCount} 个"仍有可见部分"的隐藏场景）`);
});

// ─────────────────────────────────────────────────────────────────────────────
group('[10] screenRectOf —— 便签按物理屏幕定位，弹出层仍按工作区避让任务栏');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A machine whose taskbar sits at the bottom, which is the case that exposed the bug.
 *
 * `bounds` and `workArea` differ only at the bottom, exactly as Windows reports them.
 */
const WITH_TASKBAR = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

check('screenRectOf 返回 bounds（物理屏幕），不是 workArea', () => {
  const rect = screenRectOf(WITH_TASKBAR);
  eq(rect.height, 1080, '必须用屏幕高度 1080，而不是工作区高度 1040');
  eq(rect.y + rect.height, 1080, '底边必须是屏幕底边 1080');
});

check('缺少 bounds 时退回 workArea，再退回 1920x1080 兜底，都不抛异常', () => {
  const noBounds = noThrow(() => screenRectOf({ workArea: WA }), '缺少 bounds 不应抛异常');
  deepEq(noBounds, WA, '没有 bounds 时必须退回 workArea');
  const nothing = noThrow(() => screenRectOf({}), '空对象不应抛异常');
  eq(nothing.width, 1920, '完全没有信息时用 1920x1080 兜底');
  const undef = noThrow(() => screenRectOf(undefined), 'undefined 不应抛异常');
  eq(undef.height, 1080, 'undefined 时用兜底高度');
});

check('向下吸附到物理屏幕底边（而非任务栏顶边）', () => {
  const screen = screenRectOf(WITH_TASKBAR);
  // 3px above the work-area bottom, i.e. as far down as the old boundary would let the user go while
  // still snapping. Under the work area that is 3px from "the edge"; on screen it is 43px from it.
  const note = { x: 500, y: 1040 - 200 - 3, width: 260, height: 200 };
  eq(note.y + note.height, 1040 - 3, '前置条件：便签底部在任务栏顶边上方 3px');

  const onWorkArea = snapToEdge(note, WITH_TASKBAR.workArea, 10);
  eq(onWorkArea.edge, EDGE_BOTTOM, '按工作区算：吸附下边');
  eq(onWorkArea.y, 840, '按工作区：y = 1040 - 200 = 840');
  eq(onWorkArea.y + note.height, 1040, '按工作区：底部停在 1040，即任务栏上方，看起来悬空');

  // A note near where the work area ends is nowhere near the screen's bottom edge, which is the whole
  // point: on this machine the two boundaries are 40px apart.
  const awayFromScreenEdge = snapToEdge(note, screen, 10);
  eq(awayFromScreenEdge.edge, null, '按屏幕算：距真正的底边还有 43px，超出阈值，不应吸附');
  eq(awayFromScreenEdge.y, note.y, '未吸附时坐标保持不变');

  // Now genuinely near the physical bottom, and closer to it than to anything else.
  const atBottom = { x: 500, y: 1080 - 200 - 4, width: 260, height: 200 };
  const onScreen = snapToEdge(atBottom, screen, 10);
  eq(onScreen.edge, EDGE_BOTTOM, '按屏幕算：贴近物理底边时吸附下边');
  eq(onScreen.y, 880, '按屏幕：y = 1080 - 200 = 880');
  eq(onScreen.y + atBottom.height, 1080, '按屏幕：便签底部贴住真正的屏幕底边');

  // And the same note measured against the work area is *pulled back out*: it lies past the boundary,
  // so `clampY` drags it up to sit on the taskbar again. That is the old behaviour in full — the note
  // could not simply be left where it was; the boundary actively undid the placement.
  const pulledBack = snapToEdge(atBottom, WITH_TASKBAR.workArea, 10);
  eq(pulledBack.y, 840, '（对照）按工作区算会把便签向上拉回 840，即拉回任务栏上方');
});

check('向下隐藏到屏幕外（而非停在任务栏上）', () => {
  const screen = screenRectOf(WITH_TASKBAR);
  const note = { edge: EDGE_BOTTOM, x: 500, y: 880, width: 260, height: 200 };
  const hidden = hiddenBounds(note, screen, HIDE_MODE_OFFSCREEN);
  eq(hidden.y, 1080 - OFFSCREEN_SLIVER, 'offscreen：露出那 1px 必须落在屏幕底边 1080 上');
  eq(hidden.y + hidden.height, 1080 - OFFSCREEN_SLIVER + 200, '整块便签被推到屏幕下沿之外');

  const tabbed = hiddenBounds(note, screen, HIDE_MODE_TAB);
  eq(tabbed.y + tabbed.height, 1080, 'tab：小标签贴住屏幕底边');
});

check('感应区覆盖屏幕底边 —— 否则便签藏下去就再也唤不回来', () => {
  const screen = screenRectOf(WITH_TASKBAR);
  const note = { edge: EDGE_BOTTOM, x: 500, y: 880, width: 260, height: 200 };

  // The pointer reaches the physical bottom edge. With the work area the zone stopped at 1040, so
  // these last 40px of screen belonged to no zone at all.
  const zone = revealZone(note, screen, undefined, HIDE_MODE_OFFSCREEN);
  ok(zone !== null, '感应区不应为 null');
  eq(zone.y + zone.height, 1080, '感应区必须一直伸到屏幕底边 1080');
  eq(pointInRect({ x: 600, y: 1075 }, zone), true, '屏幕最下沿 5px 内必须能触发唤回');

  const workAreaZone = revealZone(note, WITH_TASKBAR.workArea, undefined, HIDE_MODE_OFFSCREEN);
  eq(workAreaZone.y + workAreaZone.height, 1040, '（对照）按工作区算，感应区止步于任务栏顶边');
  eq(pointInRect({ x: 600, y: 1075 }, workAreaZone), false, '（对照）那 40px 落在感应区之外，唤不回来');
});

// ─────────────────────────────────────────────────────────────────────────────
group('[11] clampPinned —— 「保留」的便签可以往左右和下挂出，但必须抓得回来');
// ─────────────────────────────────────────────────────────────────────────────

/** 一台 1920x1080 的屏幕，尺寸固定，便于核对具体像素。 */
const PIN_SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };
const PIN_W = 260;
const PIN_H = 200;

check('向右拖超过边界：允许挂出，屏内仍留够 40px', () => {
  const at = clampPinned(1700, 400, PIN_W, PIN_H, PIN_SCREEN);
  eq(at.x, 1700, '应保持 1700，不再被夹回 1660');
  eq(at.x + PIN_W - PIN_SCREEN.width, PINNED_OVERHANG, '右侧应恰好挂出 40px');
});

check('往右拖到极远：最多挂出 40px，不会整个跑出屏幕', () => {
  const at = clampPinned(99999, 400, PIN_W, PIN_H, PIN_SCREEN);
  eq(at.x, PIN_SCREEN.width - PINNED_OVERHANG, 'x 应夹到 1920-40=1880');
  ok(at.x + PIN_W > PIN_SCREEN.width, '仍应挂出去一部分');
  ok(at.x < PIN_SCREEN.width, '但必须仍有部分在屏内，否则抓不回来');
});

check('向左拖：同样允许挂出并有下限', () => {
  const near = clampPinned(-30, 400, PIN_W, PIN_H, PIN_SCREEN);
  eq(near.x, -30, '应保持 -30');
  eq(-near.x, 30, '左侧挂出 30px');
  const far = clampPinned(-99999, 400, PIN_W, PIN_H, PIN_SCREEN);
  eq(far.x, -PIN_W + PINNED_OVERHANG, 'x 应夹到 -220');
  eq(far.x + PIN_W, PINNED_OVERHANG, '屏内恰好剩 40px');
});

check('向下拖：允许挂出，最多挂出 40px', () => {
  const at = clampPinned(800, 1000, PIN_W, PIN_H, PIN_SCREEN);
  eq(at.y, 1000, '应保持 1000，而不是被夹到 880');
  eq(at.y + PIN_H - PIN_SCREEN.height, 120, '下方挂出 120px');
  eq(clampPinned(800, 99999, PIN_W, PIN_H, PIN_SCREEN).y, PIN_SCREEN.height - PINNED_OVERHANG, 'y 应夹到 1040');
});

check('向上拖【不】允许挂出 —— 标题栏是唯一的拖动把手', () => {
  // 刻意的不对称：挂在屏幕上方会把标题栏推出屏幕，那条便签就再也拖不动了。
  eq(clampPinned(800, -30, PIN_W, PIN_H, PIN_SCREEN).y, 0, '上边缘必须贴齐 0');
  eq(clampPinned(800, -99999, PIN_W, PIN_H, PIN_SCREEN).y, 0, '拖到极上也要夹回 0');
  eq(clampPinned(800, 5, PIN_W, PIN_H, PIN_SCREEN).y, 5, '屏幕内的位置不应被改动');
});

check('屏幕内的位置完全不受影响（与普通夹取一致）', () => {
  // Coordinates that *both* clamps consider in-range, so the relaxation must be a no-op at each of
  // them: x ∈ [0, 1660], y ∈ [0, 880] on a 1080-tall screen. Values past 880 are on screen but beyond
  // the flush clamp — the two are *supposed* to disagree there, and the next check pins that down.
  for (const [x, y] of [[0, 0], [950, 500], [1660, 880], [10, 20], [1000, 700]]) {
    const pinned = clampPinned(x, y, PIN_W, PIN_H, PIN_SCREEN);
    eq(pinned.x, x, `x=${x} 不应被改动`);
    eq(pinned.y, y, `y=${y} 不应被改动`);
    eq(pinned.x, clampX(x, PIN_W, PIN_SCREEN), `x=${x} 应与普通夹取一致`);
    eq(pinned.y, clampY(y, PIN_H, PIN_SCREEN), `y=${y} 应与普通夹取一致`);
  }
});

check('普通夹取够不到、但保留的便签够得到（这就是放宽的意义）', () => {
  // y=900 leaves 20px of slack that the flush clamp refuses. Asserted explicitly so a future "tidy up"
  // of the clamp cannot quietly undo the relaxation.
  eq(clampY(900, PIN_H, PIN_SCREEN), 880, '普通夹取会把便签拉回 880');
  const relaxed = clampPinned(1000, 900, PIN_W, PIN_H, PIN_SCREEN);
  eq(relaxed.y, 900, '保留的便签应当能停在 900');
  eq(relaxed.y + PIN_H - PIN_SCREEN.height, 20, '下方挂出 20px');
});

check('任何位置都保证「抓得回来」：可见区域不小于 40px，且标题栏始终可见', () => {
  // 不变量：无论往哪个方向拖多远，便签与屏幕的交集在两个轴上都不小于 PINNED_OVERHANG，
  // 且上边缘不得越过屏幕顶边。
  for (const x of [-99999, -500, -40, 0, 500, 1700, 1900, 99999]) {
    for (const y of [-99999, -500, -40, 0, 500, 1040, 1200, 99999]) {
      const at = clampPinned(x, y, PIN_W, PIN_H, PIN_SCREEN);
      const visibleW = Math.min(at.x + PIN_W, PIN_SCREEN.x + PIN_SCREEN.width) - Math.max(at.x, PIN_SCREEN.x);
      const visibleH = Math.min(at.y + PIN_H, PIN_SCREEN.y + PIN_SCREEN.height) - Math.max(at.y, PIN_SCREEN.y);
      ok(visibleW >= PINNED_OVERHANG, `x=${x} 时屏内宽度仅 ${visibleW}px`);
      ok(visibleH >= PINNED_OVERHANG, `y=${y} 时屏内高度仅 ${visibleH}px`);
      ok(at.y >= PIN_SCREEN.y, `y=${y} 时上边缘被推出了屏幕（y=${at.y}）`);
    }
  }
});

check('便签比屏幕还大时退回贴边，不产生负的可见区域', () => {
  const huge = { width: 2400, height: 1400 };
  const at = clampPinned(-100, -100, huge.width, huge.height, PIN_SCREEN);
  eq(at.x, clampX(-100, huge.width, PIN_SCREEN), '超宽时横向退回普通夹取');
  eq(at.y, clampY(-100, huge.height, PIN_SCREEN), '超高时纵向退回普通夹取');
});

check('屏幕原点为负（副屏在主屏左边）时同样成立', () => {
  const leftScreen = { x: -1280, y: 0, width: 1280, height: 1024 };
  eq(clampPinned(-1300, 400, PIN_W, PIN_H, leftScreen).x, -1300, '屏幕内的位置不该动');
  const far = clampPinned(-99999, 400, PIN_W, PIN_H, leftScreen);
  eq(far.x + PIN_W, leftScreen.x + PINNED_OVERHANG, '左侧挂出上限要跟着屏幕原点走');
});

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────
const line = '─'.repeat(62);
console.log(`\n${line}`);
console.log(`用例：${passed + failed}（通过 ${passed}，失败 ${failed}）｜断言：${assertions}`);
if (failed > 0) {
  console.log(`\n失败清单：`);
  for (const [index, item] of failures.entries()) {
    console.log(`  ${index + 1}. ${item.name}`);
    for (const l of explain(item.error).split('\n')) console.log(`     ${l}`);
  }
  console.log(`\n结果：失败 ${failed} 个用例 ❌`);
  process.exitCode = 1;
} else {
  console.log(`结果：全部通过 ✅（退出码 0）`);
  process.exitCode = 0;
}

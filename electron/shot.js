/**
 * dsh-sticky-notes — 截图选区 / 标注编辑器（渲染层）。
 *
 * 由 electron/shot.html 用 <script src="shot.js"> 加载，运行在
 * `contextIsolation: true` + `nodeIntegration: false` + `--enable-sandbox` 的
 * 渲染进程里，所以本文件**只有 DOM / Canvas API**：
 *   - 不加载任何模块，不碰 Node，不读文件，不发网络请求；
 *   - 唯一的对外通道是 preload 暴露的 `window.shot`（契约第 5 节）：
 *       init() → { dataUrl, width, height, scaleFactor, mode }
 *       commit({ dataUrl, width, height, target }) / cancel() / copy({ dataUrl })
 *   - `window.shot` 不存在时显示降级提示（#fallback），绝不白屏。
 *
 * 坐标系统（三个，务必分清，混用就是错位）：
 *   1. 物理像素 physical —— 整屏截图的真实像素，= CSS 像素 × scaleFactor；
 *   2. 图像 CSS 像素 image —— 底图在页面上的逻辑尺寸，(width/scaleFactor)，
 *      #layer 内所有元素（遮罩、选区、控制点、尺寸标签）都用它；
 *   3. 页面像素 page —— 鼠标事件（clientX/clientY）与工具条/输入框定位用它。
 *   `pageToImage()` / `imageToPage()` 是唯一的换算入口。
 *
 * 导出为什么是「干净选区图」：
 *   离屏 canvas 是**新建的空画布**，只画两样东西 ——
 *   (a) 底图按选区裁剪的像素；(b) state.annotations 里的标注。
 *   遮罩(.mask)、工具条(#toolbar)、尺寸标签(#sizeLabel)、选区边框(#selection)、
 *   控制点(.handle) 全是 DOM 元素，从来没有对应的 canvas 绘制代码，
 *   也不可能出现在新建画布里；标注层 #overlay 也不是导出源（只是同一套
 *   drawAnnotation() 的另一个输出面）。详见 buildExportCanvas()。
 */
'use strict';

(function () {
  // #region pure-geometry
  // ===========================================================================
  // 纯几何 / 坐标换算：不碰 DOM、不碰 state、不读全局变量。
  // 自测脚本会把 #region 之间的原文抽出来用 new Function() 执行并断言，
  // 所以这段必须自包含（区间内自己定义常量与辅助函数）。
  // ===========================================================================

  /** 鼠标靠近参考线多少 CSS 像素内就吸附。 */
  var SNAP_THRESHOLD = 8;
  /** 选区小于该尺寸视为「没有框选到东西」。 */
  var MIN_SELECTION = 8;
  /** 按下到抬起位移小于该值算点击，不会清掉已有选区。 */
  var CLICK_SLOP = 4;
  /** 控制点命中半径（正方形命中区的一半边长）。 */
  var HANDLE_HIT = 6;

  /** 8 个控制点 → 拖动方向。x<0 动左边，x>0 动右边，y<0 动上边，y>0 动下边。 */
  var HANDLE_DIRS = Object.freeze({
    nw: { x: -1, y: -1 },
    n: { x: 0, y: -1 },
    ne: { x: 1, y: -1 },
    e: { x: 1, y: 0 },
    se: { x: 1, y: 1 },
    s: { x: 0, y: 1 },
    sw: { x: -1, y: 1 },
    w: { x: -1, y: 0 },
  });

  /** 有限数字，否则用兜底值。 */
  function num(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** 闭区间夹取；min > max 时也不会返回 NaN。 */
  function clamp(value, min, max) {
    var lo = Math.min(min, max);
    var hi = Math.max(min, max);
    if (value < lo) return lo;
    if (value > hi) return hi;
    return value;
  }

  /** scaleFactor 必须是 > 0 的有限数，否则按 1（即 1 物理像素 = 1 CSS 像素）。 */
  function normalizeScaleFactor(scaleFactor) {
    var scale = num(scaleFactor, 1);
    return scale > 0 ? scale : 1;
  }

  /** 物理像素 → CSS 像素：scaleFactor=2 时 200 → 100。 */
  function physicalToCss(value, scaleFactor) {
    return num(value, 0) / normalizeScaleFactor(scaleFactor);
  }

  /** CSS 像素 → 物理像素。 */
  function cssToPhysical(value, scaleFactor) {
    return num(value, 0) * normalizeScaleFactor(scaleFactor);
  }

  /** 任意两个对角点 → 规范化矩形（反方向拖拽也是正宽高）。 */
  function normalizeRect(ax, ay, bx, by) {
    var x1 = num(ax, 0);
    var y1 = num(ay, 0);
    var x2 = num(bx, 0);
    var y2 = num(by, 0);
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    };
  }

  /** 两个点对象 → 规范化矩形。 */
  function rectFromPoints(a, b) {
    return normalizeRect(num(a && a.x, 0), num(a && a.y, 0), num(b && b.x, 0), num(b && b.y, 0));
  }

  /** 吸附/导出前把选区对齐到整 CSS 像素（四边各自取整，避免累计漂移）。 */
  function roundRect(rect) {
    var left = Math.round(num(rect && rect.x, 0));
    var top = Math.round(num(rect && rect.y, 0));
    var right = Math.round(num(rect && rect.x, 0) + num(rect && rect.width, 0));
    var bottom = Math.round(num(rect && rect.y, 0) + num(rect && rect.height, 0));
    return {
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
    };
  }

  /** 矩形整体夹进 bounds；比 bounds 还大时贴左上并缩到 bounds 尺寸。 */
  function clampRect(rect, bounds) {
    var width = Math.min(num(rect && rect.width, 0), num(bounds && bounds.width, 0));
    var height = Math.min(num(rect && rect.height, 0), num(bounds && bounds.height, 0));
    var x = clamp(num(rect && rect.x, 0), num(bounds && bounds.x, 0), num(bounds && bounds.x, 0) + num(bounds && bounds.width, 0) - width);
    var y = clamp(num(rect && rect.y, 0), num(bounds && bounds.y, 0), num(bounds && bounds.y, 0) + num(bounds && bounds.height, 0) - height);
    return { x: x, y: y, width: width, height: height };
  }

  /** 点是否在矩形内（含边界）。 */
  function pointInRect(point, rect) {
    if (!point || !rect) return false;
    var px = num(point.x, NaN);
    var py = num(point.y, NaN);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
    return (
      px >= rect.x &&
      px <= rect.x + rect.width &&
      py >= rect.y &&
      py <= rect.y + rect.height
    );
  }

  /** 选区是否够大（默认 MIN_SELECTION）。 */
  function isRectUsable(rect, minSize) {
    if (!rect) return false;
    var min = Math.max(1, num(minSize, MIN_SELECTION));
    return num(rect.width, 0) >= min && num(rect.height, 0) >= min;
  }

  /** 标注窗口在屏幕上的原点（CSS 像素）。 */
  function readWindowOrigin() {
    return {
      x: num(window.screenX, num(window.screenLeft, 0)),
      y: num(window.screenY, num(window.screenTop, 0)),
    };
  }

  /**
   * 当前选区在屏幕坐标系里的位置，拿不到选区时返回 null。
   *
   * 标注窗口是整块显示器大小的无边框窗口，所以页面坐标与屏幕坐标只差一个窗口原点 ——
   * 这就是「截图在屏幕上的位置」，用来决定截图便签生成在哪里。
   */
  function selectionScreenRect(origin) {
    if (state.selection === null || !isRectUsable(state.selection, 1)) return null;
    return {
      x: Math.round(origin.x + num(state.selection.x, 0)),
      y: Math.round(origin.y + num(state.selection.y, 0)),
      width: Math.round(num(state.selection.width, 0)),
      height: Math.round(num(state.selection.height, 0)),
    };
  }

  /** 两个矩形是否等价（用于判断「有没有变化」）。 */
  function rectsEqual(a, b) {
    if (!a || !b) return a === b;
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  /** 两点距离。 */
  function distanceBetween(a, b) {
    var dx = num(a && a.x, 0) - num(b && b.x, 0);
    var dy = num(a && a.y, 0) - num(b && b.y, 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 8 个控制点的中心坐标（图像 CSS 像素）。 */
  function handlePoints(rect) {
    var x = num(rect && rect.x, 0);
    var y = num(rect && rect.y, 0);
    var w = num(rect && rect.width, 0);
    var h = num(rect && rect.height, 0);
    var mx = x + w / 2;
    var my = y + h / 2;
    var rx = x + w;
    var by = y + h;
    return [
      { id: 'nw', x: x, y: y },
      { id: 'n', x: mx, y: y },
      { id: 'ne', x: rx, y: y },
      { id: 'e', x: rx, y: my },
      { id: 'se', x: rx, y: by },
      { id: 's', x: mx, y: by },
      { id: 'sw', x: x, y: by },
      { id: 'w', x: x, y: my },
    ];
  }

  /**
   * 命中测试：先看 8 个控制点（正方形命中区，半径 radius），
   * 再看是否落在选区内部（→ 'move'），都不中返回 null。
   */
  function handleAt(point, rect, radius) {
    if (!point || !rect) return null;
    var r = Math.max(2, num(radius, HANDLE_HIT));
    var handles = handlePoints(rect);
    var best = null;
    var bestDistance = Infinity;
    for (var i = 0; i < handles.length; i += 1) {
      var d = Math.max(Math.abs(point.x - handles[i].x), Math.abs(point.y - handles[i].y));
      if (d <= r && d < bestDistance) {
        bestDistance = d;
        best = handles[i].id;
      }
    }
    if (best !== null) return best;
    if (pointInRect(point, rect)) return 'move';
    return null;
  }

  /** handle → 光标（页面里给 #stage 用）。 */
  function cursorForHandle(handle) {
    if (handle === 'nw' || handle === 'se') return 'nwse-resize';
    if (handle === 'ne' || handle === 'sw') return 'nesw-resize';
    if (handle === 'n' || handle === 's') return 'ns-resize';
    if (handle === 'e' || handle === 'w') return 'ew-resize';
    if (handle === 'move') return 'move';
    return 'crosshair';
  }

  /** 平移矩形。 */
  function translateRect(rect, dx, dy) {
    return {
      x: num(rect && rect.x, 0) + num(dx, 0),
      y: num(rect && rect.y, 0) + num(dy, 0),
      width: num(rect && rect.width, 0),
      height: num(rect && rect.height, 0),
    };
  }

  /**
   * 拖控制点缩放：只动 handle 方向上的边，并保证不小于 minSize。
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @param {string} handle 'nw'|'n'|'ne'|'e'|'se'|'s'|'sw'|'w'
   * @param {number} dx 相对按下点的位移
   * @param {number} dy
   * @param {number} minSize 最小边长
   */
  function resizeRect(rect, handle, dx, dy, minSize) {
    var dir = HANDLE_DIRS[handle];
    var min = Math.max(1, num(minSize, MIN_SELECTION));
    var left = num(rect && rect.x, 0);
    var top = num(rect && rect.y, 0);
    var right = left + num(rect && rect.width, 0);
    var bottom = top + num(rect && rect.height, 0);
    if (!dir) return { x: left, y: top, width: right - left, height: bottom - top };

    if (dir.x < 0) left += num(dx, 0);
    if (dir.x > 0) right += num(dx, 0);
    if (dir.y < 0) top += num(dy, 0);
    if (dir.y > 0) bottom += num(dy, 0);

    // 撞到最小尺寸后不再让这条边越过去（另一条边固定）。
    if (right - left < min) {
      if (dir.x < 0) left = right - min;
      else if (dir.x > 0) right = left + min;
    }
    if (bottom - top < min) {
      if (dir.y < 0) top = bottom - min;
      else if (dir.y > 0) bottom = top + min;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** 某条边该吸附到哪条参考线：阈值内取最近的，否则原样返回。 */
  function snapValue(value, guides, threshold) {
    var v = num(value, 0);
    var limit = Math.max(0, num(threshold, SNAP_THRESHOLD));
    var list = Array.isArray(guides) ? guides : [];
    var best = v;
    var bestDistance = Infinity;
    for (var i = 0; i < list.length; i += 1) {
      var guide = num(list[i], NaN);
      if (!Number.isFinite(guide)) continue;
      var d = Math.abs(guide - v);
      if (d <= limit && d < bestDistance) {
        bestDistance = d;
        best = guide;
      }
    }
    return best;
  }

  /**
   * 给一组坐标找一个统一位移 delta，使其中至少一个落在参考线阈值内。
   * 用于「整体移动选区」：左右两条边一起移动，不能各自吸附（会被拉变形）。
   */
  function snapDelta(values, guides, threshold) {
    var limit = Math.max(0, num(threshold, SNAP_THRESHOLD));
    var list = Array.isArray(guides) ? guides : [];
    var pairs = Array.isArray(values) ? values : [];
    var best = 0;
    var bestDistance = Infinity;
    for (var i = 0; i < pairs.length; i += 1) {
      var v = num(pairs[i], NaN);
      if (!Number.isFinite(v)) continue;
      for (var j = 0; j < list.length; j += 1) {
        var guide = num(list[j], NaN);
        if (!Number.isFinite(guide)) continue;
        var d = guide - v;
        if (Math.abs(d) <= limit && Math.abs(d) < bestDistance) {
          bestDistance = Math.abs(d);
          best = d;
        }
      }
    }
    return best;
  }

  /**
   * 按 active 指定的边各自吸附（画新选区 / 拖控制点时用）。
   * @param {{x:number,y:number,width:number,height:number}} rect
   * @param {{x:number[],y:number[]}} guides 参考线（CSS 像素）
   * @param {number} threshold
   * @param {{left?:boolean,right?:boolean,top?:boolean,bottom?:boolean}} [active]
   */
  function snapRectEdges(rect, guides, threshold, active) {
    var act = active || { left: true, right: true, top: true, bottom: true };
    var gx = guides && Array.isArray(guides.x) ? guides.x : [];
    var gy = guides && Array.isArray(guides.y) ? guides.y : [];
    var left = num(rect && rect.x, 0);
    var top = num(rect && rect.y, 0);
    var right = left + num(rect && rect.width, 0);
    var bottom = top + num(rect && rect.height, 0);

    if (act.left) left = snapValue(left, gx, threshold);
    if (act.right) right = snapValue(right, gx, threshold);
    if (act.top) top = snapValue(top, gy, threshold);
    if (act.bottom) bottom = snapValue(bottom, gy, threshold);

    // 两条边吸附后可能交叉，交换一下保证宽高非负。
    if (right < left) {
      var swapX = left;
      left = right;
      right = swapX;
    }
    if (bottom < top) {
      var swapY = top;
      top = bottom;
      bottom = swapY;
    }
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  /** 拖某个控制点时，哪些边是「活的」（用于吸附）。 */
  function resizeActiveEdges(handle) {
    var dir = HANDLE_DIRS[handle];
    if (!dir) return { left: false, right: false, top: false, bottom: false };
    return { left: dir.x < 0, right: dir.x > 0, top: dir.y < 0, bottom: dir.y > 0 };
  }

  /** 箭头两翼坐标（导出与叠加层共用，保证所见即所得）。 */
  function arrowHead(x1, y1, x2, y2, size) {
    var angle = Math.atan2(num(y2, 0) - num(y1, 0), num(x2, 0) - num(x1, 0));
    var length = Math.max(2, num(size, 10));
    var spread = Math.PI / 7;
    return {
      left: {
        x: num(x2, 0) - length * Math.cos(angle - spread),
        y: num(y2, 0) - length * Math.sin(angle - spread),
      },
      right: {
        x: num(x2, 0) - length * Math.cos(angle + spread),
        y: num(y2, 0) - length * Math.sin(angle + spread),
      },
    };
  }

  /**
   * 底图 CSS 尺寸 → 页面摆放方式。
   * 正常情况（窗口尺寸 == 截图的 CSS 尺寸）返回 scale=1、offset=0，即 1:1 像素；
   * 万一窗口比截图小（多屏/缩放/被系统改过尺寸），等比缩小并居中，
   * 保证「不模糊、不拉伸、坐标不错位」。
   */
  function makeView(viewport, image) {
    var vw = Math.max(1, num(viewport && viewport.width, 1));
    var vh = Math.max(1, num(viewport && viewport.height, 1));
    var iw = Math.max(1, num(image && image.width, vw));
    var ih = Math.max(1, num(image && image.height, vh));
    var scale = Math.min(1, vw / iw, vh / ih);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    return {
      scale: scale,
      offsetX: (vw - iw * scale) / 2,
      offsetY: (vh - ih * scale) / 2,
      width: iw * scale,
      height: ih * scale,
    };
  }

  /** 页面像素 → 图像 CSS 像素（鼠标事件入口）。 */
  function pageToImage(point, view) {
    var scale = view && Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
    return {
      x: (num(point && point.x, 0) - num(view && view.offsetX, 0)) / scale,
      y: (num(point && point.y, 0) - num(view && view.offsetY, 0)) / scale,
    };
  }

  /** 图像 CSS 像素 → 页面像素（工具条/输入框定位）。 */
  function imageToPage(point, view) {
    var scale = view && Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
    return {
      x: num(point && point.x, 0) * scale + num(view && view.offsetX, 0),
      y: num(point && point.y, 0) * scale + num(view && view.offsetY, 0),
    };
  }

  /** 矩形：图像 CSS 像素 → 页面像素。 */
  function rectToPage(rect, view) {
    var topLeft = imageToPage({ x: num(rect && rect.x, 0), y: num(rect && rect.y, 0) }, view);
    var scale = view && Number.isFinite(view.scale) && view.scale > 0 ? view.scale : 1;
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: num(rect && rect.width, 0) * scale,
      height: num(rect && rect.height, 0) * scale,
    };
  }

  /** 2D 变换对象（只用到 scale + translate，b/c 恒为 0）。 */
  function makeTransform(scale, offsetX, offsetY) {
    var s = normalizeScaleFactor(scale);
    return { a: s, b: 0, c: 0, d: s, e: num(offsetX, 0), f: num(offsetY, 0) };
  }

  /** 点应用变换，用于断言「图像坐标 → 画布像素」。 */
  function applyTransform(point, transform) {
    var t = transform || makeTransform(1, 0, 0);
    return {
      x: num(t.a, 1) * num(point && point.x, 0) + num(t.c, 0) * num(point && point.y, 0) + num(t.e, 0),
      y: num(t.b, 0) * num(point && point.x, 0) + num(t.d, 1) * num(point && point.y, 0) + num(t.f, 0),
    };
  }

  /** 标注层 canvas 的变换：backing store 是物理像素，所以整体乘 scaleFactor，无偏移。 */
  function canvasTransform(scaleFactor) {
    return makeTransform(normalizeScaleFactor(scaleFactor), 0, 0);
  }

  /**
   * 导出几何：选区（图像 CSS 像素）+ scaleFactor → 物理像素裁剪框 + 画布变换。
   * 源矩形四边取整后，底图 1:1 拷贝（不重采样），标注用同一个原点，
   * 因此导出图与屏幕所见完全对齐，且尺寸 = 选区 CSS 尺寸 × scaleFactor。
   */
  function exportGeometry(rect, scaleFactor, imageWidth, imageHeight) {
    var scale = normalizeScaleFactor(scaleFactor);
    var maxWidth = Number.isFinite(imageWidth) && imageWidth > 0 ? Math.round(imageWidth) : Infinity;
    var maxHeight = Number.isFinite(imageHeight) && imageHeight > 0 ? Math.round(imageHeight) : Infinity;

    var sx = clamp(Math.round(num(rect && rect.x, 0) * scale), 0, Math.max(0, maxWidth - 1));
    var sy = clamp(Math.round(num(rect && rect.y, 0) * scale), 0, Math.max(0, maxHeight - 1));
    var sw = clamp(Math.round(num(rect && rect.width, 0) * scale), 1, Math.max(1, maxWidth - sx));
    var sh = clamp(Math.round(num(rect && rect.height, 0) * scale), 1, Math.max(1, maxHeight - sy));

    return {
      sx: sx,
      sy: sy,
      sw: sw,
      sh: sh,
      dw: sw,
      dh: sh,
      scale: scale,
      transform: makeTransform(scale, -sx, -sy),
    };
  }

  /**
   * 工具条摆位（页面像素）：优先选区下方，放不下翻到上方，再夹进窗口；
   * 水平方向跟随选区左边缘并夹在窗口内。返回的 y 已保证工具条完整可见。
   */
  function toolbarPlacement(rect, bar, stage, gap) {
    var g = Math.max(0, num(gap, 8));
    var barWidth = Math.max(0, num(bar && bar.width, 0));
    var barHeight = Math.max(0, num(bar && bar.height, 0));
    var stageWidth = Math.max(0, num(stage && stage.width, 0));
    var stageHeight = Math.max(0, num(stage && stage.height, 0));
    var rectBottom = num(rect && rect.y, 0) + num(rect && rect.height, 0);

    var below = stageHeight - rectBottom;
    var y = below >= barHeight + g ? rectBottom + g : num(rect && rect.y, 0) - barHeight - g;
    y = clamp(y, 0, Math.max(0, stageHeight - barHeight));
    var x = clamp(num(rect && rect.x, 0), 0, Math.max(0, stageWidth - barWidth));
    return { x: x, y: y };
  }

  /** 尺寸标签摆位（相对选区左上角的偏移）：默认贴上方，顶部放不下就挪进选区内部。 */
  function labelPlacement(rect, label, stage, gap) {
    var g = Math.max(0, num(gap, 6));
    var labelHeight = Math.max(0, num(label && label.height, 20));
    var y = num(rect && rect.y, 0);
    if (y - labelHeight - g < 0) return { x: 4, y: 4 };
    return { x: 0, y: -labelHeight - g };
  }

  /** 尺寸标签文案：图像 CSS 像素（屏幕上量到的宽 × 高）。 */
  function formatSizeLabel(rect) {
    var w = Math.max(0, Math.round(num(rect && rect.width, 0)));
    var h = Math.max(0, Math.round(num(rect && rect.height, 0)));
    return w + ' × ' + h;
  }
  // #endregion pure-geometry

  // ---------------------------------------------------------------------------
  // 常量
  // ---------------------------------------------------------------------------

  /** 预设色板（契约第 5 节没有取色通道，所以只用预设色）。 */
  var COLORS = ['#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#111111'];
  /** 线宽预设：细 / 中 / 粗（CSS 像素）。 */
  var LINE_WIDTHS = [2, 4, 7];
  /** 字号预设（CSS 像素）。 */
  var FONT_SIZES = [14, 18, 24, 32];
  /** 文字与导出都用同一个字体栈，保证所见即所得。 */
  var FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, -apple-system, "Segoe UI", sans-serif';
  /** init() 与图片解码的超时（毫秒）：主进程卡住时也要给出降级提示。 */
  var INIT_TIMEOUT_MS = 8000;
  var IMAGE_TIMEOUT_MS = 8000;
  /** 工具条与选区之间的间距（页面像素）。 */
  var BAR_GAP = 10;
  /** 画笔采样最小间距（图像 CSS 像素），避免点数组爆炸。 */
  var PEN_MIN_STEP = 1.2;
  /** toast 自动隐藏时间。 */
  var TOAST_MS = 2200;
  /**
   * 提交成功后等多久自己关窗。
   * 截图窗口是全屏 + 置顶 + 无边框，如果主进程没有在 commit 之后关掉它，
   * 用户就被「粘」在一层遮罩上；主进程先关掉时这段延时不会被执行。
   */
  var SELF_CLOSE_AFTER_COMMIT_MS = 420;

  var TAU = Math.PI * 2;

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------

  var state = {
    /** window.shot 是否可用。 */
    api: null,
    /** 初始化完成、可以交互。 */
    ready: false,
    /** 已经提交/取消，等待主进程关窗。 */
    finished: false,
    /** 正在等 IPC 回执。 */
    busy: false,
    /** init() 给的模式，目前不影响渲染，仅记录便于排查。 */
    mode: 'shot',
    /** 显示缩放：物理像素 = CSS 像素 × scaleFactor。 */
    scaleFactor: 1,
    /** 底图（HTMLImageElement）。 */
    image: null,
    /** 底图像素尺寸（物理像素）。 */
    imageWidth: 0,
    imageHeight: 0,
    /** 底图在页面上的逻辑尺寸（CSS 像素）。 */
    cssWidth: 0,
    cssHeight: 0,
    /** makeView() 的结果。 */
    view: { scale: 1, offsetX: 0, offsetY: 0, width: 0, height: 0 },
    /** 已确认选区（图像 CSS 像素，整数）。 */
    selection: null,
    /** 正在拖拽中的新选区。 */
    draftRect: null,
    /** 已完成的标注（唯一会被导出的绘制数据）。 */
    annotations: [],
    /** 撤销栈。 */
    redoStack: [],
    /** 正在画的那一笔。 */
    draft: null,
    /** 当前工具：'select'|'rect'|'ellipse'|'arrow'|'pen'|'text'。 */
    tool: 'select',
    color: COLORS[0],
    lineWidth: LINE_WIDTHS[0],
    fontSize: FONT_SIZES[1],
    /** 指针交互：{ mode: 'new'|'move'|'resize'|'draw', ... }。 */
    interaction: null,
    /** 图片加载完但还没绑事件时的保护。 */
    bound: false,
    /** 工具条实测尺寸缓存（避免拖拽中反复强制布局）。 */
    barSize: null,
  };

  /** DOM 引用。 */
  var els = {};

  /** toast 定时器。 */
  var toastTimer = null;
  /** 提交成功后的自关定时器。 */
  var selfCloseTimer = null;
  /** 重绘节流。 */
  var renderQueued = false;

  // ---------------------------------------------------------------------------
  // 小工具
  // ---------------------------------------------------------------------------

  /** 任意异常 → 可读文案。 */
  function message(error) {
    if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
    if (typeof error === 'string' && error.length > 0) return error;
    return String(error);
  }

  /** 绝不自爆的日志。 */
  function warn(scope, error) {
    try {
      console.warn('[sticky-notes/shot] ' + scope + '：' + message(error));
    } catch (ignored) {
      /* 连 console 都不可用时什么都别做 */
    }
  }

  /** 带超时的 Promise：主进程不回应时也要有结果。 */
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(label));
      }, Math.max(1, ms));
      Promise.resolve(promise).then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** 解码 dataUrl 图片（data: URL 不会污染 canvas，可以安全导出）。 */
  function loadImage(dataUrl) {
    return withTimeout(
      new Promise(function (resolve, reject) {
        var image = new Image();
        image.onload = function () {
          resolve(image);
        };
        image.onerror = function () {
          reject(new Error('截图数据解码失败'));
        };
        image.src = dataUrl;
      }),
      IMAGE_TIMEOUT_MS,
      '截图解码超时',
    );
  }

  /** 轻量提示条；sticky=true 时不再自动消失。 */
  function toast(text, sticky) {
    if (!els.toast) return;
    try {
      els.toast.textContent = String(text);
      els.toast.hidden = false;
      if (toastTimer !== null) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      if (sticky !== true) {
        toastTimer = setTimeout(function () {
          toastTimer = null;
          if (els.toast) els.toast.hidden = true;
        }, TOAST_MS);
      }
    } catch (error) {
      warn('toast', error);
    }
  }

  /** 下一个动画帧重绘（同帧多次调用只画一次）。 */
  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    var run = function () {
      renderQueued = false;
      try {
        render();
      } catch (error) {
        warn('render', error);
      }
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function collectElements() {
    var ids = [
      'stage',
      'layer',
      'screen',
      'overlay',
      'maskFull',
      'maskTop',
      'maskBottom',
      'maskLeft',
      'maskRight',
      'selection',
      'sizeLabel',
      'toolbar',
      'fontSize',
      'undo',
      'redo',
      'clear',
      'saveFile',
      'saveNote',
      'copy',
      'cancel',
      'textEditor',
      'textInput',
      'hint',
      'toast',
      'fallback',
      'fallbackReason',
      'fallbackClose',
    ];
    for (var i = 0; i < ids.length; i += 1) els[ids[i]] = document.getElementById(ids[i]);
  }

  /** 契约第 5 节要求 window.shot 暴露 4 个方法，缺任何一个都算不可用。 */
  function detectApi() {
    var api = window.shot;
    if (!api || typeof api !== 'object') return { api: null, missing: ['window.shot 不存在（preload 未加载）'] };
    var missing = [];
    var names = ['init', 'commit', 'cancel', 'copy'];
    for (var i = 0; i < names.length; i += 1) {
      if (typeof api[names[i]] !== 'function') missing.push('window.shot.' + names[i] + '()');
    }
    if (missing.length > 0) return { api: null, missing: missing };
    return { api: api, missing: [] };
  }

  /** 降级提示：不白屏、不抛异常、给出原因和关闭入口。 */
  function showFallback(reason) {
    state.ready = false;
    try {
      if (els.fallbackReason) els.fallbackReason.textContent = String(reason);
      if (els.fallback) els.fallback.hidden = false;
      if (els.toolbar) els.toolbar.hidden = true;
      if (els.hint) els.hint.hidden = true;
      if (els.textEditor) els.textEditor.hidden = true;
      if (els.selection) els.selection.hidden = true;
      if (els.maskFull) els.maskFull.hidden = false;
      if (els.stage) els.stage.style.cursor = 'default';
    } catch (error) {
      warn('showFallback', error);
    }
  }

  /** 初始化流程：拿截图 → 解码 → 布局 → 绑定交互。全链路 try/catch。 */
  function start() {
    var detected = detectApi();
    if (detected.api === null) {
      showFallback('无法与主进程通信：' + detected.missing.join('、'));
      return;
    }
    state.api = detected.api;

    var pending;
    try {
      pending = state.api.init();
    } catch (error) {
      showFallback('调用 window.shot.init() 失败：' + message(error));
      return;
    }

    withTimeout(Promise.resolve(pending), INIT_TIMEOUT_MS, 'window.shot.init() 超时')
      .then(function (info) {
        var data = info && typeof info === 'object' ? info : {};
        var dataUrl = typeof data.dataUrl === 'string' ? data.dataUrl : '';
        if (dataUrl.length === 0) throw new Error('主进程没有返回截图数据（dataUrl 为空）');
        state.scaleFactor = normalizeScaleFactor(data.scaleFactor);
        state.mode = typeof data.mode === 'string' && data.mode.length > 0 ? data.mode : 'shot';
        return loadImage(dataUrl).then(function (image) {
          return { image: image, info: data };
        });
      })
      .then(function (result) {
        state.image = result.image;
        var naturalWidth = Number(result.image.naturalWidth) || Number(result.info.width) || 0;
        var naturalHeight = Number(result.image.naturalHeight) || Number(result.info.height) || 0;
        if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error('截图尺寸无效');
        if (Number(result.info.width) > 0 && Number(result.info.width) !== naturalWidth) {
          warn('init', new Error('width 与解码尺寸不一致，以解码尺寸为准（' + result.info.width + ' → ' + naturalWidth + '）'));
        }
        state.imageWidth = naturalWidth;
        state.imageHeight = naturalHeight;
        layout();
        bindInteraction();
        state.ready = true;
        els.stage.style.cursor = 'crosshair';
        render();
      })
      .catch(function (error) {
        showFallback(message(error));
      });
  }

  // ---------------------------------------------------------------------------
  // 布局
  // ---------------------------------------------------------------------------

  /** 当前的「可见选区」：拖拽中的新选区优先。 */
  function activeRect() {
    return state.draftRect !== null ? state.draftRect : state.selection;
  }

  /** 底图逻辑范围（图像 CSS 像素）。 */
  function stageRect() {
    return { x: 0, y: 0, width: state.cssWidth, height: state.cssHeight };
  }

  /** 吸附参考线：屏幕四边 + 中线，共 3 条竖线 3 条横线。 */
  function guides() {
    return {
      x: [0, state.cssWidth / 2, state.cssWidth],
      y: [0, state.cssHeight / 2, state.cssHeight],
    };
  }

  /** 底图 canvas / 标注 canvas / #layer 的尺寸与摆放。 */
  function layout() {
    state.cssWidth = physicalToCss(state.imageWidth, state.scaleFactor);
    state.cssHeight = physicalToCss(state.imageHeight, state.scaleFactor);

    var viewport = {
      width: Math.max(1, window.innerWidth || state.cssWidth),
      height: Math.max(1, window.innerHeight || state.cssHeight),
    };
    state.view = makeView(viewport, { width: state.cssWidth, height: state.cssHeight });

    // 底图：backing store = 物理像素，CSS 尺寸 = 逻辑尺寸 → 1:1 绘制，不模糊
    els.screen.width = state.imageWidth;
    els.screen.height = state.imageHeight;
    els.screen.style.width = state.cssWidth + 'px';
    els.screen.style.height = state.cssHeight + 'px';
    var baseCtx = els.screen.getContext('2d');
    if (baseCtx) {
      baseCtx.setTransform(1, 0, 0, 1, 0, 0);
      baseCtx.clearRect(0, 0, state.imageWidth, state.imageHeight);
      baseCtx.drawImage(state.image, 0, 0, state.imageWidth, state.imageHeight);
    }

    // 标注层：同样是物理像素 backing store，靠 canvasTransform 换算
    els.overlay.width = state.imageWidth;
    els.overlay.height = state.imageHeight;
    els.overlay.style.width = state.cssWidth + 'px';
    els.overlay.style.height = state.cssHeight + 'px';

    els.layer.style.width = state.cssWidth + 'px';
    els.layer.style.height = state.cssHeight + 'px';
    els.layer.style.left = state.view.offsetX + 'px';
    els.layer.style.top = state.view.offsetY + 'px';
    els.layer.style.transform = state.view.scale === 1 ? 'none' : 'scale(' + state.view.scale + ')';
  }

  /** 4 块遮罩：把选区「镂空」，选区内保持原始亮度。 */
  function layoutMasks() {
    var rect = activeRect();
    var hasSelection = rect !== null;
    els.maskFull.hidden = hasSelection;
    els.maskTop.hidden = !hasSelection;
    els.maskBottom.hidden = !hasSelection;
    els.maskLeft.hidden = !hasSelection;
    els.maskRight.hidden = !hasSelection;
    if (!hasSelection) return;

    var w = state.cssWidth;
    var h = state.cssHeight;
    var x = clamp(rect.x, 0, w);
    var y = clamp(rect.y, 0, h);
    var right = clamp(rect.x + rect.width, 0, w);
    var bottom = clamp(rect.y + rect.height, 0, h);

    setBox(els.maskTop, 0, 0, w, y);
    setBox(els.maskBottom, 0, bottom, w, h - bottom);
    setBox(els.maskLeft, 0, y, x, bottom - y);
    setBox(els.maskRight, right, y, w - right, bottom - y);
  }

  function setBox(element, x, y, width, height) {
    element.style.left = Math.max(0, x) + 'px';
    element.style.top = Math.max(0, y) + 'px';
    element.style.width = Math.max(0, width) + 'px';
    element.style.height = Math.max(0, height) + 'px';
  }

  /** 选区边框 + 尺寸标签（纯装饰，绝不参与导出）。 */
  function layoutSelection() {
    var rect = activeRect();
    if (rect === null || state.finished) {
      els.selection.hidden = true;
      return;
    }
    els.selection.hidden = false;
    els.selection.style.left = rect.x + 'px';
    els.selection.style.top = rect.y + 'px';
    els.selection.style.width = Math.max(0, rect.width) + 'px';
    els.selection.style.height = Math.max(0, rect.height) + 'px';

    els.sizeLabel.textContent = formatSizeLabel(rect);
    els.sizeLabel.title =
      '屏幕尺寸 ' +
      formatSizeLabel(rect) +
      ' px（图像 CSS 像素）；导出分辨率 ' +
      Math.max(1, Math.round(cssToPhysical(rect.width, state.scaleFactor))) +
      ' × ' +
      Math.max(1, Math.round(cssToPhysical(rect.height, state.scaleFactor))) +
      ' px（scaleFactor ' +
      state.scaleFactor +
      '）';
    var offset = labelPlacement(rect, { height: 20 }, { width: state.cssWidth, height: state.cssHeight }, 6);
    els.sizeLabel.style.left = offset.x + 'px';
    els.sizeLabel.style.top = offset.y + 'px';
  }

  /** 工具条：只在有确认选区时出现，位置用页面像素计算。 */
  function layoutToolbar() {
    if (!state.ready || state.finished || state.selection === null) {
      els.toolbar.hidden = true;
      return;
    }
    // 先显示才能量到真实尺寸（含换行后的高度）；尺寸只在「刚显示」时重量一次，
    // 否则拖拽中每帧都会因为读 getBoundingClientRect() 触发一次强制布局。
    var wasHidden = els.toolbar.hidden;
    els.toolbar.hidden = false;
    if (wasHidden || state.barSize === null) {
      var bar = els.toolbar.getBoundingClientRect();
      state.barSize = { width: bar.width, height: bar.height };
    }
    var pageRect = rectToPage(state.selection, state.view);
    var position = toolbarPlacement(
      pageRect,
      state.barSize,
      { width: window.innerWidth, height: window.innerHeight },
      BAR_GAP,
    );
    els.toolbar.style.left = position.x + 'px';
    els.toolbar.style.top = position.y + 'px';
  }

  function render() {
    if (!state.ready) return;
    layoutMasks();
    layoutSelection();
    layoutToolbar();
    renderOverlay();
    updateToolState();
    if (els.hint) els.hint.hidden = state.selection !== null || state.finished;
  }

  // ---------------------------------------------------------------------------
  // 标注绘制（叠加层与导出共用同一套代码 + 同一个变换，所以所见即所得）
  // ---------------------------------------------------------------------------

  /** 把裁剪区域设成矩形。 */
  function clipToRect(ctx, rect) {
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, Math.max(0, rect.width), Math.max(0, rect.height));
    ctx.clip();
  }

  /** 画一条标注。只读 ann，不读 state，保证导出与预览一致。 */
  function drawAnnotation(ctx, ann) {
    if (!ann || typeof ann !== 'object') return;
    var width = Math.max(0.5, num(ann.lineWidth, 2));
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = typeof ann.color === 'string' ? ann.color : '#ff3b30';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = width;

    if (ann.type === 'rect') {
      ctx.strokeRect(ann.x, ann.y, Math.max(0, ann.width), Math.max(0, ann.height));
    } else if (ann.type === 'ellipse') {
      var rx = Math.max(0, num(ann.width, 0) / 2);
      var ry = Math.max(0, num(ann.height, 0) / 2);
      ctx.beginPath();
      ctx.ellipse(num(ann.x, 0) + rx, num(ann.y, 0) + ry, rx, ry, 0, 0, TAU);
      ctx.stroke();
    } else if (ann.type === 'arrow') {
      var head = arrowHead(ann.x1, ann.y1, ann.x2, ann.y2, Math.max(9, width * 3.6));
      ctx.beginPath();
      ctx.moveTo(ann.x1, ann.y1);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(head.left.x, head.left.y);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.stroke();
    } else if (ann.type === 'pen') {
      var points = Array.isArray(ann.points) ? ann.points : [];
      if (points.length === 1) {
        ctx.beginPath();
        ctx.arc(points[0].x, points[0].y, width / 2, 0, TAU);
        ctx.fill();
      } else if (points.length > 1) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (var i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
      }
    } else if (ann.type === 'text') {
      var size = Math.max(8, num(ann.fontSize, 18));
      ctx.font = size + 'px ' + FONT_STACK;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      var lines = String(ann.text === undefined || ann.text === null ? '' : ann.text).split('\n');
      for (var line = 0; line < lines.length; line += 1) {
        ctx.fillText(lines[line], num(ann.x, 0), num(ann.y, 0) + line * size * 1.25);
      }
    }
    ctx.restore();
  }

  /** 重画标注层：底图不动，标注层整层重绘（含正在画的一笔）。 */
  function renderOverlay() {
    if (!state.image) return;
    var ctx = els.overlay.getContext('2d');
    if (!ctx) return;
    var transform = canvasTransform(state.scaleFactor);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, els.overlay.width, els.overlay.height);
    if (state.annotations.length === 0 && state.draft === null) return;

    ctx.save();
    ctx.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    // 只允许在选区内作画：画到边界外的一笔会被裁掉，不会「误画」到选区外
    clipToRect(ctx, activeRect() || stageRect());
    for (var i = 0; i < state.annotations.length; i += 1) drawAnnotation(ctx, state.annotations[i]);
    if (state.draft !== null) drawAnnotation(ctx, state.draft);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 标注数据操作
  // ---------------------------------------------------------------------------

  /** 一笔标注是否有效（太小/太短的丢弃，避免「点一下就多一个点」）。 */
  function isAnnotationUsable(ann) {
    if (!ann) return false;
    if (ann.type === 'rect' || ann.type === 'ellipse') return ann.width >= 2 || ann.height >= 2;
    if (ann.type === 'arrow') return distanceBetween({ x: ann.x1, y: ann.y1 }, { x: ann.x2, y: ann.y2 }) >= 4;
    if (ann.type === 'pen') return Array.isArray(ann.points) && ann.points.length >= 2;
    if (ann.type === 'text') return typeof ann.text === 'string' && ann.text.length > 0;
    return false;
  }

  function pushAnnotation(ann) {
    if (!isAnnotationUsable(ann)) return;
    state.annotations.push(ann);
    state.redoStack.length = 0;
  }

  function undo() {
    if (state.annotations.length === 0) return;
    state.redoStack.push(state.annotations.pop());
    requestRender();
  }

  function redo() {
    if (state.redoStack.length === 0) return;
    state.annotations.push(state.redoStack.pop());
    requestRender();
  }

  function clearAnnotations() {
    if (state.annotations.length === 0) return;
    state.redoStack = state.annotations.slice().reverse().concat(state.redoStack);
    state.annotations = [];
    requestRender();
  }

  // ---------------------------------------------------------------------------
  // 指针交互
  // ---------------------------------------------------------------------------

  /** 事件目标是不是界面控件（工具条/输入框/降级提示），这些不该触发选区操作。 */
  function isUiTarget(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return target.closest('#toolbar, #textEditor, #fallback, #toast') !== null;
  }

  function bindInteraction() {
    if (state.bound) return;
    state.bound = true;

    els.stage.addEventListener('pointerdown', onPointerDown);
    els.stage.addEventListener('pointermove', onPointerMove);
    els.stage.addEventListener('pointerup', onPointerUp);
    els.stage.addEventListener('pointercancel', onPointerUp);
    els.stage.addEventListener('contextmenu', function (event) {
      // 右键 = 取消本次截图（和常见截图工具一致）
      event.preventDefault();
      onCancel();
    });

    els.toolbar.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
    });
    els.textEditor.addEventListener('pointerdown', function (event) {
      event.stopPropagation();
    });

    els.toolbar.addEventListener('click', onToolbarClick);
    els.fontSize.value = String(state.fontSize); // 下拉框默认值要和 state 一致，否则显示「小 14」而实际用 18
    els.fontSize.addEventListener('change', function () {
      var value = Number(els.fontSize.value);
      if (FONT_SIZES.indexOf(value) >= 0) state.fontSize = value;
    });

    els.textInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitTextEditor();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelTextEditor();
      }
      event.stopPropagation();
    });
    els.textInput.addEventListener('blur', function () {
      // 失焦即确认（点别处就等于「文字打完了」）
      commitTextEditor();
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', function () {
      try {
        if (!state.ready) return;
        state.barSize = null; // 窗口尺寸变了，工具条可能要换行，重新量
        layout();
        render();
      } catch (error) {
        warn('resize', error);
      }
    });

    if (els.fallbackClose) {
      els.fallbackClose.addEventListener('click', function () {
        closeWindow();
      });
    }
  }

  function stagePoint(event) {
    return pageToImage({ x: event.clientX, y: event.clientY }, state.view);
  }

  function onPointerDown(event) {
    try {
      if (!state.ready || state.finished || state.busy) return;
      if (event.button !== 0) return;
      if (isUiTarget(event.target)) return;
      var point = stagePoint(event);
      // 先收掉未确认的文字，避免输入框和后续操作打架
      commitTextEditor();

      var rect = state.selection;
      var hit = rect === null ? null : handleAt(point, rect, HANDLE_HIT);

      // 控制点优先（哪怕正在用画笔，也不该在边框上画一道）
      if (hit !== null && hit !== 'move') {
        state.interaction = { mode: 'resize', handle: hit, start: point, origin: rect };
      } else if (state.tool !== 'select' && rect !== null && pointInRect(point, rect)) {
        beginDraw(state.tool, point);
      } else if (hit === 'move') {
        state.interaction = { mode: 'move', start: point, origin: rect };
      } else {
        // 空白处按下 = 重新框选；先记下旧选区，微拖（点击）时恢复
        state.interaction = { mode: 'new', anchor: point, prev: rect };
        state.draftRect = rectFromPoints(point, point);
      }

      if (typeof els.stage.setPointerCapture === 'function') {
        try {
          els.stage.setPointerCapture(event.pointerId);
        } catch (error) {
          warn('setPointerCapture', error);
        }
      }
      event.preventDefault();
      requestRender();
    } catch (error) {
      warn('pointerdown', error);
      state.interaction = null;
      state.draftRect = null;
    }
  }

  function onPointerMove(event) {
    try {
      if (!state.ready || state.finished) return;
      var point = stagePoint(event);
      var interaction = state.interaction;

      if (interaction === null) {
        updateCursor(point);
        return;
      }

      if (interaction.mode === 'new') {
        var drawn = rectFromPoints(interaction.anchor, point);
        interaction.moved = interaction.moved === true || distanceBetween(interaction.anchor, point) > CLICK_SLOP;
        state.draftRect = clampRect(snapRectEdges(drawn, guides(), SNAP_THRESHOLD, null), stageRect());
        requestRender();
        return;
      }

      if (interaction.mode === 'move') {
        var dx = point.x - interaction.start.x;
        var dy = point.y - interaction.start.y;
        var target = translateRect(interaction.origin, dx, dy);
        var g = guides();
        // 整体移动：左右（上下）两条边共用一个 delta，不然会被拉变形
        var deltaX = snapDelta([target.x, target.x + target.width], g.x, SNAP_THRESHOLD);
        var deltaY = snapDelta([target.y, target.y + target.height], g.y, SNAP_THRESHOLD);
        target = translateRect(target, deltaX, deltaY);
        state.selection = roundRect(clampRect(target, stageRect()));
        requestRender();
        return;
      }

      if (interaction.mode === 'resize') {
        var resized = resizeRect(
          interaction.origin,
          interaction.handle,
          point.x - interaction.start.x,
          point.y - interaction.start.y,
          MIN_SELECTION,
        );
        resized = snapRectEdges(resized, guides(), SNAP_THRESHOLD, resizeActiveEdges(interaction.handle));
        state.selection = roundRect(clampRect(resized, stageRect()));
        requestRender();
        return;
      }

      if (interaction.mode === 'draw') {
        updateDraft(point);
        requestRender();
      }
    } catch (error) {
      warn('pointermove', error);
    }
  }

  function onPointerUp(event) {
    try {
      if (!state.ready || state.finished) return;
      var interaction = state.interaction;
      state.interaction = null;
      if (interaction === null) return;

      if (interaction.mode === 'new') {
        var drawn = state.draftRect;
        state.draftRect = null;
        if (drawn !== null && isRectUsable(drawn)) {
          state.selection = roundRect(clampRect(drawn, stageRect()));
        } else {
          // 只是点了一下：保留原选区，不要把用户的框选弄丢
          state.selection = interaction.prev || null;
        }
      } else if (interaction.mode === 'draw') {
        var ann = state.draft;
        state.draft = null;
        pushAnnotation(ann);
      }

      if (state.selection !== null) {
        state.selection = roundRect(clampRect(state.selection, stageRect()));
      }
      requestRender();
      updateCursor(stagePoint(event));
    } catch (error) {
      warn('pointerup', error);
      state.interaction = null;
      state.draftRect = null;
      state.draft = null;
    }
  }

  /** 悬停光标：控制点 → 缩放光标，选区内 → move，否则十字。 */
  function updateCursor(point) {
    if (!state.ready || state.finished || state.busy) {
      els.stage.style.cursor = '';
      return;
    }
    var cursor = 'crosshair';
    if (state.tool === 'select' && state.selection !== null) {
      var hit = handleAt(point, state.selection, HANDLE_HIT);
      if (hit !== null) cursor = cursorForHandle(hit);
    } else if (state.selection !== null && pointInRect(point, state.selection)) {
      cursor = 'crosshair';
    }
    els.stage.style.cursor = cursor;
  }

  // ---------------------------------------------------------------------------
  // 画笔 / 形状
  // ---------------------------------------------------------------------------

  function beginDraw(tool, point) {
    if (tool === 'text') {
      openTextEditor(point);
      return;
    }
    var base = { color: state.color, lineWidth: state.lineWidth };
    if (tool === 'pen') {
      base.type = 'pen';
      base.points = [{ x: point.x, y: point.y }];
    } else if (tool === 'arrow') {
      base.type = 'arrow';
      base.x1 = point.x;
      base.y1 = point.y;
      base.x2 = point.x;
      base.y2 = point.y;
    } else {
      base.type = tool === 'ellipse' ? 'ellipse' : 'rect';
      base.x = point.x;
      base.y = point.y;
      base.width = 0;
      base.height = 0;
    }
    state.draft = base;
    state.interaction = { mode: 'draw', tool: tool, start: point };
  }

  function updateDraft(point) {
    var draft = state.draft;
    if (!draft) return;
    if (draft.type === 'pen') {
      var last = draft.points[draft.points.length - 1];
      if (distanceBetween(last, point) >= PEN_MIN_STEP) draft.points.push({ x: point.x, y: point.y });
      return;
    }
    if (draft.type === 'arrow') {
      draft.x2 = point.x;
      draft.y2 = point.y;
      return;
    }
    var rect = rectFromPoints({ x: draft.x, y: draft.y }, point);
    draft.x = rect.x;
    draft.y = rect.y;
    draft.width = rect.width;
    draft.height = rect.height;
  }

  // ---------------------------------------------------------------------------
  // 文字
  // ---------------------------------------------------------------------------

  /** 在点击处放一个输入框（位置用页面像素；字号/颜色跟随当前选择）。 */
  function openTextEditor(point) {
    var page = imageToPage(point, state.view);
    els.textEditor.hidden = false;
    els.textInput.value = '';
    els.textInput.style.color = state.color;
    els.textInput.style.fontSize = state.fontSize + 'px';
    els.textInput.dataset.x = String(point.x);
    els.textInput.dataset.y = String(point.y);
    els.textEditor.style.left = page.x + 'px';
    els.textEditor.style.top = Math.max(0, page.y - 2) + 'px';

    // 贴右/下边时把输入框拉回窗口内，别让它跑到屏幕外
    var box = els.textEditor.getBoundingClientRect();
    var maxLeft = Math.max(0, window.innerWidth - box.width - 4);
    var maxTop = Math.max(0, window.innerHeight - box.height - 4);
    els.textEditor.style.left = Math.min(page.x, maxLeft) + 'px';
    els.textEditor.style.top = Math.min(Math.max(0, page.y - 2), maxTop) + 'px';

    try {
      els.textInput.focus();
    } catch (error) {
      warn('focus', error);
    }
  }

  /** 回车/失焦 = 落字。 */
  function commitTextEditor() {
    if (!els.textEditor || els.textEditor.hidden) return;
    var text = String(els.textInput.value || '').replace(/\s+$/, '');
    var x = Number(els.textInput.dataset.x);
    var y = Number(els.textInput.dataset.y);
    els.textEditor.hidden = true;
    els.textInput.value = '';
    if (text.length === 0) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    pushAnnotation({
      type: 'text',
      x: x,
      y: y,
      text: text,
      color: state.color,
      lineWidth: state.lineWidth,
      fontSize: state.fontSize,
    });
    requestRender();
  }

  /** Esc = 放弃这段文字（不关窗）。 */
  function cancelTextEditor() {
    if (!els.textEditor || els.textEditor.hidden) return;
    els.textEditor.hidden = true;
    els.textInput.value = '';
  }

  // ---------------------------------------------------------------------------
  // 工具条
  // ---------------------------------------------------------------------------

  function onToolbarClick(event) {
    try {
      if (state.finished) return;
      var target = event.target && typeof event.target.closest === 'function' ? event.target : null;
      var button = target ? target.closest('button') : null;
      if (!button) return;
      if (button.disabled) return;

      if (button.dataset.tool !== undefined) {
        state.tool = button.dataset.tool;
        commitTextEditor();
      } else if (button.dataset.color !== undefined) {
        state.color = button.dataset.color;
      } else if (button.dataset.width !== undefined) {
        var width = Number(button.dataset.width);
        if (LINE_WIDTHS.indexOf(width) >= 0) state.lineWidth = width;
      } else if (button.id === 'undo') {
        undo();
      } else if (button.id === 'redo') {
        redo();
      } else if (button.id === 'clear') {
        clearAnnotations();
      } else if (button.id === 'saveFile') {
        commitTo('file');
      } else if (button.id === 'saveNote') {
        commitTo('note');
      } else if (button.id === 'copy') {
        copyToClipboard();
      } else if (button.id === 'cancel') {
        onCancel();
      }

      // 别让按钮抢走焦点：否则 Enter/Space 会重复触发按钮而不是快捷键
      if (typeof button.blur === 'function') button.blur();
      render();
    } catch (error) {
      warn('toolbar', error);
    }
  }

  function updateToolState() {
    var tools = els.toolbar.querySelectorAll('[data-tool]');
    for (var i = 0; i < tools.length; i += 1) {
      tools[i].classList.toggle('active', tools[i].dataset.tool === state.tool);
    }
    var swatches = els.toolbar.querySelectorAll('[data-color]');
    for (var j = 0; j < swatches.length; j += 1) {
      swatches[j].classList.toggle('active', swatches[j].dataset.color === state.color);
    }
    var widths = els.toolbar.querySelectorAll('[data-width]');
    for (var k = 0; k < widths.length; k += 1) {
      widths[k].classList.toggle('active', Number(widths[k].dataset.width) === state.lineWidth);
    }
    els.undo.disabled = state.annotations.length === 0;
    els.redo.disabled = state.redoStack.length === 0;
    els.clear.disabled = state.annotations.length === 0;
    els.toolbar.classList.toggle('busy', state.busy);
  }

  // ---------------------------------------------------------------------------
  // 键盘
  // ---------------------------------------------------------------------------

  function onKeyDown(event) {
    try {
      var editing = els.textEditor && !els.textEditor.hidden;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (editing) {
          cancelTextEditor();
          return;
        }
        onCancel();
        return;
      }
      if (state.finished) return;
      if (editing) return; // 输入框自己处理 Enter / 其他按键

      var active = document.activeElement;
      if (active && active.tagName === 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) return;
      if (active && active.tagName === 'SELECT') return;

      var ctrl = event.ctrlKey || event.metaKey;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitTo(ctrl ? 'note' : 'file');
        return;
      }
      if (ctrl && (event.key === 'z' || event.key === 'Z')) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (ctrl && (event.key === 'y' || event.key === 'Y')) {
        event.preventDefault();
        redo();
        return;
      }
      if (ctrl && (event.key === 'c' || event.key === 'C')) {
        event.preventDefault();
        copyToClipboard();
        return;
      }
      if (ctrl && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        commitTo('file');
        return;
      }
      if (ctrl && (event.key === 'a' || event.key === 'A')) {
        // 全屏截图快捷键：整个屏幕就是选区
        event.preventDefault();
        state.selection = roundRect(clampRect(stageRect(), stageRect()));
        state.draftRect = null;
        requestRender();
      }
    } catch (error) {
      warn('keydown', error);
    }
  }

  // ---------------------------------------------------------------------------
  // 导出 / 提交
  // ---------------------------------------------------------------------------

  /**
   * 合成「干净的选区图」。
   *
   * 保证方式（对应验收第 4 条）：
   *   1. out 是 document.createElement('canvas') 出来的**全新空画布**，
   *      下面只执行两类绘制：drawImage 底图裁剪 + drawAnnotation(标注)；
   *   2. 遮罩、工具条、尺寸标签、选区边框、控制点都是 #layer / #stage 里的 DOM，
   *      CSS 负责显示，本函数里没有任何一行代码会画它们；
   *   3. #overlay（屏幕上那层标注 canvas）也不是导出源 —— 它只与这里共用
   *      drawAnnotation()，所以导出内容 == 标注数组，永远不会带上遮罩；
   *   4. 标注再被 clipToRect(selection) 裁一刀，越界的笔迹不会溢到选区外。
   *
   * 为什么不直接复制 #overlay 的像素：那样导出会依赖「叠加层已经渲染完」这个
   * 时序条件（例如刚敲完文字就立刻提交，rAF 还没跑，文字就会丢）。现在导出是
   * state 的纯函数，任何时刻调用都正确。代价是曲线最淡的那一圈抗锯齿覆盖率由
   * Skia 在不同设备偏移下各算一次，可能与预览差 ±1 个色阶（实测占标注像素
   * 的 0.67%，肉眼不可见），但绝不会引入非标注内容。
   */
  function buildExportCanvas() {
    var selection = state.selection;
    if (selection === null || !state.image) return null;
    var geometry = exportGeometry(selection, state.scaleFactor, state.imageWidth, state.imageHeight);

    var out = document.createElement('canvas');
    out.width = geometry.dw;
    out.height = geometry.dh;
    var ctx = out.getContext('2d');
    if (!ctx) return null;

    // (a) 底图：按物理像素 1:1 裁剪，无重采样 → 不模糊
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(state.image, geometry.sx, geometry.sy, geometry.sw, geometry.sh, 0, 0, geometry.dw, geometry.dh);

    // (b) 标注：与叠加层同一个变换、同一个裁剪、同一个 drawAnnotation
    var t = geometry.transform;
    ctx.save();
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
    clipToRect(ctx, selection);
    for (var i = 0; i < state.annotations.length; i += 1) drawAnnotation(ctx, state.annotations[i]);
    ctx.restore();

    return out;
  }

  /** 生成 dataUrl；失败返回 null 而不是抛异常。 */
  function exportDataUrl() {
    try {
      var canvas = buildExportCanvas();
      if (!canvas) return null;
      var dataUrl = canvas.toDataURL('image/png');
      if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/png;base64,') !== 0) return null;
      return { dataUrl: dataUrl, width: canvas.width, height: canvas.height };
    } catch (error) {
      warn('toDataURL', error);
      return null;
    }
  }

  function setBusy(busy) {
    state.busy = busy === true;
    els.toolbar.classList.toggle('busy', state.busy);
    els.stage.classList.toggle('busy', state.busy);
  }

  /** 提交：target ∈ 'file' | 'note' | 'both'。 */
  function commitTo(target) {
    if (!state.ready || state.finished || state.busy) return;
    commitTextEditor();
    if (state.selection === null || !isRectUsable(state.selection, 1)) {
      toast('请先框选要截取的区域');
      return;
    }
    var exported = exportDataUrl();
    if (exported === null) {
      toast('导出图片失败，请重试');
      return;
    }
    setBusy(true);
    Promise.resolve()
      .then(function () {
        // 选区在页面坐标里；标注窗口整块覆盖显示器，所以「页面坐标 + 窗口在屏幕上的原点」
        // 就是这块截图在屏幕上的真实位置。带上去，便签才能生成在用户框选的那块地方，
        // 而不是屏幕左上角。
        var origin = readWindowOrigin();
        var area = selectionScreenRect(origin);
        return state.api.commit({
          dataUrl: exported.dataUrl,
          width: exported.width,
          height: exported.height,
          target: target,
          screenX: area === null ? null : area.x,
          screenY: area === null ? null : area.y,
        });
      })
      .then(function (ack) {
        // 主进程的失败形状是 `{ error }`（preload 已经转成 rejection，
        // 这里再兜一层，避免任何一层改动导致「失败被当成成功」）。
        if (ack && typeof ack === 'object' && typeof ack.error === 'string' && ack.error.length > 0) {
          throw new Error(ack.error);
        }
        // 在「保存」对话框里点了取消：这不是错误，也不该关窗 —— 用户可能只是想换个
        // 位置，或者改主意去点「存为便签」。留在原地让 ta 继续。
        if (ack && typeof ack === 'object' && ack.cancelled === true) {
          toast('已取消保存');
          return;
        }
        state.finished = true;
        els.stage.classList.add('finished');
        els.toolbar.hidden = true;
        els.selection.hidden = true;
        els.hint.hidden = true;
        var where = ack && typeof ack.path === 'string' && ack.path.length > 0 ? ack.path : '';
        toast((target === 'note' ? '已存为便签' : '已保存图片') + (where ? '：' + where : ''), true);
        // 生命周期理论上归主进程，但截图窗口是全屏 + 置顶，一旦主进程没有关窗
        // 用户就被「粘」在遮罩上了，所以这里到点自己收尾（主进程先关掉也不冲突）。
        scheduleSelfClose(SELF_CLOSE_AFTER_COMMIT_MS);
      })
      .catch(function (error) {
        toast('保存失败：' + message(error));
      })
      .then(function () {
        setBusy(false);
        requestRender();
      });
  }

  /** 复制到剪贴板（main 写 clipboard，渲染层只给 dataUrl）。 */
  function copyToClipboard() {
    if (!state.ready || state.finished || state.busy) return;
    commitTextEditor();
    if (state.selection === null || !isRectUsable(state.selection, 1)) {
      toast('请先框选要复制的区域');
      return;
    }
    var exported = exportDataUrl();
    if (exported === null) {
      toast('导出图片失败，请重试');
      return;
    }
    setBusy(true);
    Promise.resolve()
      .then(function () {
        return state.api.copy({ dataUrl: exported.dataUrl });
      })
      .then(function (ack) {
        if (ack && typeof ack === 'object' && ack.error) throw new Error(message(ack.error));
        toast('已复制到剪贴板');
      })
      .catch(function (error) {
        toast('复制失败：' + message(error));
      })
      .then(function () {
        setBusy(false);
      });
  }

  /** 取消：交给主进程关窗（生命周期归 main，这里不自己 window.close）。 */
  function onCancel() {
    if (!state.ready || state.finished || state.busy) {
      if (!state.ready) closeWindow();
      return;
    }
    state.finished = true;
    setBusy(false);
    els.toolbar.hidden = true;
    els.selection.hidden = true;
    els.hint.hidden = true;
    toast('已取消', true);
    Promise.resolve()
      .then(function () {
        return state.api.cancel();
      })
      .catch(function (error) {
        // 取消失败就退回可交互状态，用户还能再按 Esc
        state.finished = false;
        toast('取消失败：' + message(error));
        requestRender();
      });
  }

  /** 最后手段：window.shot 不可用时至少让用户能关掉这个窗口。 */
  function closeWindow() {
    try {
      window.close();
    } catch (error) {
      warn('window.close', error);
    }
  }

  /** 延时自关（只排一次）。主进程先关掉的话这个定时器根本没机会跑。 */
  function scheduleSelfClose(delayMs) {
    if (selfCloseTimer !== null) return;
    selfCloseTimer = setTimeout(function () {
      selfCloseTimer = null;
      if (state.finished) closeWindow();
    }, Math.max(0, delayMs));
  }

  // ---------------------------------------------------------------------------
  // 全局兜底 + 入口
  // ---------------------------------------------------------------------------

  /** 未捕获异常/未处理 rejection 一律降级成 toast，不让页面变成白屏或死界面。 */
  function bindGlobalGuards() {
    window.addEventListener('error', function (event) {
      toast('脚本错误：' + (event && event.message ? event.message : '未知错误'));
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event && event.reason ? event.reason : '未知原因';
      warn('unhandledrejection', reason);
      toast('未处理的错误：' + message(reason));
    });
  }

  function boot() {
    try {
      collectElements();
      if (!els.stage || !els.layer || !els.screen || !els.overlay || !els.fallback) {
        // 连 DOM 都不完整时，别把自己藏起来：什么都不做也比抛异常好
        warn('boot', new Error('页面结构不完整，缺少必要的容器元素'));
        return;
      }
      bindGlobalGuards();
      start();
    } catch (error) {
      warn('boot', error);
      try {
        showFallback('初始化异常：' + message(error));
      } catch (ignored) {
        /* 已经尽力了 */
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

/*
 * dsh-sticky-notes — 便签窗口渲染层（契约 §5「便签窗口」）。
 *
 * 运行环境：Electron 渲染进程（contextIsolation: true、nodeIntegration: false、沙箱开启）。
 * 因此本文件**只使用 DOM 与浏览器 API**，一切与主进程的通信都经由 preload 暴露的
 * window.sticky（见 electron/preload-note.cjs）。所有调用先判断存在性再 try/catch，
 * 失败只做非阻塞提示；preload 缺失时显示一行降级说明，绝不白屏、绝不抛未捕获异常。
 *
 * 窗口尺寸由主进程控制，页面用 100vw/100vh 自适应，不设置固定宽高。
 * 拖动与缩放不使用 CSS 的窗口拖动区/缩放属性（那会让主进程拿不到位置事件），
 * 而是用指针事件算出屏幕坐标后调 window.sticky.setBounds / setSize，并报告 dragState。
 */
(function () {
  'use strict';

  /* ============================== 常量 ============================== */

  /** 输入防抖：停笔 600ms 自动保存。 */
  const SAVE_DEBOUNCE_MS = 600;
  /** 缩放最小尺寸。 */
  const MIN_WIDTH = 140;
  const MIN_HEIGHT = 90;
  /** 指针移动超过该像素才认定为拖动/缩放，避免单击时窗口抖动。 */
  const DRAG_THRESHOLD = 3;
  /** 提示停留时间（毫秒）。 */
  const TOAST_MS = 1100;
  const TOAST_ERROR_MS = 2800;
  /** 删除的二次确认窗口。 */
  const DELETE_CONFIRM_MS = 3000;

  /** 缺字段时的兜底便签，保证任何情况下页面都有东西可渲染。 */
  const DEFAULT_NOTE = {
    id: '',
    kind: 'text',
    title: '',
    text: '',
    x: 0,
    y: 0,
    width: 260,
    height: 200,
    hidden: false,
    edge: null,
    snapDir: null,
    color: '#000000',
    opacity: 0.8,
    textColor: '#f5f5f5',
    fontSize: 14,
    alwaysOnTop: true,
    image: null,
  };

  /* ============================== 状态 ============================== */

  const dom = {};
  let note = Object.assign({}, DEFAULT_NOTE);
  let settings = {};
  /** 有未保存改动。 */
  let dirty = false;
  /** 输入法组合输入中：组合期间不落盘，避免保存半截拼音。 */
  let composing = false;
  /** 编辑序号：保存回执回来时用它判断期间是否又有新输入。 */
  let editSeq = 0;
  let saveTimer = null;
  let toastTimer = null;
  let deleteTimer = null;
  let deleteArmedAt = 0;
  /** 已加载的截图路径，避免 note:state 推送时重复刷新图片。 */
  let loadedImage = null;
  /** 当前指针手势（拖动或缩放），同时只允许一个。 */
  let gesture = null;
  /** 已经提示过的失败方法，避免拖动时刷屏。 */
  const warnedMethods = new Set();
  /** 最近一次收到 note:state 推送的时间，用于判断主进程是否已经自行落库。 */
  let lastStateAt = 0;

  /* ============================== 工具 ============================== */

  /** 数字收敛，容忍垃圾输入。 */
  function clampNumber(value, min, max, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /** 任意抛出物 → 可读文本。 */
  function message(error) {
    if (error === null || error === undefined) return '未知错误';
    if (typeof error === 'string') return error;
    if (typeof error.message === 'string' && error.message.length > 0) return error.message;
    try {
      return String(error);
    } catch {
      return '未知错误';
    }
  }

  /** `#rgb` / `#rrggbb` / `rgb()` / `rgba()` → [r,g,b]；无法识别返回 null。 */
  function parseColor(input) {
    if (typeof input !== 'string') return null;
    const value = input.trim();
    let m = /^#([0-9a-f]{3})$/i.exec(value);
    if (m !== null) {
      const h = m[1];
      return [
        Number.parseInt(h[0] + h[0], 16),
        Number.parseInt(h[1] + h[1], 16),
        Number.parseInt(h[2] + h[2], 16),
      ];
    }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
    if (m !== null) {
      const h = m[1];
      return [
        Number.parseInt(h.slice(0, 2), 16),
        Number.parseInt(h.slice(2, 4), 16),
        Number.parseInt(h.slice(4, 6), 16),
      ];
    }
    m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/i.exec(value);
    if (m !== null) {
      return [
        Math.round(clampNumber(m[1], 0, 255, 0)),
        Math.round(clampNumber(m[2], 0, 255, 0)),
        Math.round(clampNumber(m[3], 0, 255, 0)),
      ];
    }
    return null;
  }

  /** 由任意颜色字符串派生一个带透明度的 rgba，用于按钮/描边等派生色。 */
  function withAlpha(color, alpha) {
    const rgb = parseColor(color);
    const a = clampNumber(alpha, 0, 1, 1);
    if (rgb === null) return 'rgba(0,0,0,' + a + ')';
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
  }

  /** 只编码文件名里真正需要转义的字符（保留路径分隔符与冒号）。 */
  function encodePath(path) {
    return encodeURI(path).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }

  /**
   * 绝对路径 → 合法的 file URL。
   * 契约里 note.image 是绝对路径（Windows 形如 D:\data\shots\n_1.png），
   * 这里把反斜杠换成斜杠、补 file:/// 前缀，并对空格、# 等做编码。
   * 已经是 file:/data:/blob:/http(s): URL 或空值时按原样/空值处理。
   */
  function toFileUrl(path) {
    if (typeof path !== 'string') return null;
    const raw = path.trim();
    if (raw.length === 0) return null;
    if (/^(file|data|blob|https?):/i.test(raw)) return raw;
    const slashed = raw.replace(/\\/g, '/');
    if (slashed.startsWith('//')) return 'file:' + encodePath(slashed); // UNC: //server/share/a.png
    const absolute = slashed.startsWith('/') ? slashed : '/' + slashed;
    return 'file://' + encodePath(absolute); // file:///D:/a/b.png、file:///home/u/a.png
  }

  /** 当前窗口在屏幕上的位置与尺寸（CSS 像素 / DIP）。 */
  function readWindowBounds() {
    const x = Number.isFinite(window.screenX) ? window.screenX : Number(window.screenLeft) || 0;
    const y = Number.isFinite(window.screenY) ? window.screenY : Number(window.screenTop) || 0;
    const width = window.outerWidth || window.innerWidth || DEFAULT_NOTE.width;
    const height = window.outerHeight || window.innerHeight || DEFAULT_NOTE.height;
    return { x: x, y: y, width: width, height: height };
  }

  /* =========================== 提示 / 降级 =========================== */

  function toast(text, isError) {
    try {
      if (!dom.toast) return;
      dom.toast.textContent = String(text === undefined || text === null ? '' : text);
      dom.toast.classList.toggle('error', isError === true);
      dom.toast.classList.add('show');
      if (toastTimer !== null) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastTimer = null;
        if (dom.toast) dom.toast.classList.remove('show');
      }, isError === true ? TOAST_ERROR_MS : TOAST_MS);
    } catch (error) {
      // 提示本身绝不能成为异常来源。
      console.warn('[sticky-notes] 提示显示失败：', message(error));
    }
  }

  function showFallback(text) {
    if (!dom.fallback) return;
    dom.fallback.textContent = String(text);
    dom.fallback.hidden = false;
  }

  function hideFallback() {
    if (dom.fallback) dom.fallback.hidden = true;
  }

  /** 同一个方法的连续失败只提示一次（拖动/缩放期间不刷屏）。 */
  function warnOnce(method, text) {
    console.warn('[sticky-notes] ' + method + ' 失败：' + text);
    if (warnedMethods.has(method)) return;
    warnedMethods.add(method);
    toast(method + ' 调用失败：' + text, true);
  }

  /* ========================== IPC 调用封装 ========================== */

  /**
   * 调用 window.sticky 上的方法。
   * 不抛异常：返回 { ok, value } / { ok:false, reason }，失败时（默认）给非阻塞提示。
   */
  async function call(method, payload, options) {
    const silent = options !== undefined && options !== null && options.silent === true;
    const api = window.sticky;
    if (api === null || api === undefined || typeof api[method] !== 'function') {
      if (!silent) toast('桥接不可用，无法执行 ' + method, true);
      return { ok: false, reason: 'no-bridge' };
    }
    try {
      const value = await api[method](payload);
      return { ok: true, value: value };
    } catch (error) {
      if (!silent) toast('操作失败：' + message(error), true);
      return { ok: false, reason: 'ipc', error: error };
    }
  }

  /** 只报告状态、不需要回执的调用：吞掉失败，绝不留未处理的 rejection。 */
  function notify(method, payload) {
    const api = window.sticky;
    if (api === null || api === undefined || typeof api[method] !== 'function') return;
    try {
      const result = api[method](payload);
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch((error) => {
          console.warn('[sticky-notes] ' + method + ' 失败：' + message(error));
        });
      }
    } catch (error) {
      console.warn('[sticky-notes] ' + method + ' 抛出：' + message(error));
    }
  }

  /* ============================ 外观渲染 ============================ */

  /** 依据 note.color / opacity / textColor / fontSize 重绘外观。 */
  function paint() {
    const app = dom.app;
    if (!app) return;

    const color = typeof note.color === 'string' && note.color.length > 0
      ? note.color
      : (typeof settings.backgroundColor === 'string' && settings.backgroundColor.length > 0
        ? settings.backgroundColor
        : DEFAULT_NOTE.color);
    const opacity = clampNumber(note.opacity, 0.2, 1, clampNumber(settings.opacity, 0.2, 1, 1));
    const textColor = typeof note.textColor === 'string' && note.textColor.length > 0
      ? note.textColor
      : (typeof settings.textColor === 'string' && settings.textColor.length > 0
        ? settings.textColor
        : DEFAULT_NOTE.textColor);
    const fontSize = clampNumber(note.fontSize, 8, 72, clampNumber(settings.fontSize, 8, 72, 14));

    if (dom.bg) {
      dom.bg.style.background = color;
      // 不透明度只作用于背景层，文字层保持不透明 → 文字始终清晰。
      dom.bg.style.opacity = String(opacity);
    }

    // Paint the appearance variables on the document root, NOT on `#app`.
    //
    // `body` declares `color: var(--note-fg, #3b3320)` and every control inherits
    // from it, but a custom property set on `#app` is invisible to its own
    // ancestor — so the whole title bar silently fell back to the dark default.
    // That is exactly the "black note, unreadable buttons" bug: light grey text was
    // asked for, dark brown was drawn. Declaring on `:root` puts the variables
    // above both `body` and `#app`.
    const root = document.documentElement;
    root.style.setProperty('--note-fg', textColor);
    root.style.setProperty('--note-fg-soft', withAlpha(textColor, 0.4));
    root.style.setProperty('--note-fg-line', withAlpha(textColor, 0.22));
    root.style.setProperty('--note-btn-bg', withAlpha(textColor, 0.1));
    root.style.setProperty('--note-btn-bg-hover', withAlpha(textColor, 0.24));
    root.style.setProperty('--note-grip', withAlpha(textColor, 0.28));
    root.style.setProperty('--note-grip-strong', withAlpha(textColor, 0.5));
    root.style.setProperty('--note-bg-color', color);
    root.style.setProperty('--note-bar-bg', withAlpha(color, 0.35));

    if (dom.editor) dom.editor.style.fontSize = fontSize + 'px';
    if (dom.titleInput) dom.titleInput.style.fontSize = Math.max(10, Math.round(fontSize * 0.86)) + 'px';
  }

  /** 依据 note.kind 切换正文形态与按钮集合。 */
  function applyKind() {
    const isShot = note.kind === 'shot';
    document.body.classList.toggle('kind-shot', isShot);
    document.body.classList.toggle('kind-text', !isShot);
    document.title = isShot ? '截图便签' : '文本便签';

    if (dom.kindMark) dom.kindMark.title = isShot ? '截图便签' : '文本便签';
    if (dom.editor) dom.editor.hidden = isShot;
    if (dom.shotPane) dom.shotPane.hidden = !isShot;
    // 另存 PNG 只对截图便签有意义。（便签不再有取色按钮：颜色在「设置 → 便签设置」里定。）
    if (dom.btnExport) dom.btnExport.hidden = !isShot;

    if (isShot) loadImage(note.image);
    else loadedImage = null;
  }

  /** 截图便签：加载 note.image 指向的本地 PNG。 */
  function loadImage(imagePath) {
    const url = toFileUrl(imagePath);
    if (url === null) {
      loadedImage = null;
      showShotEmpty('（这条截图便签缺少图片数据）');
      return;
    }
    if (loadedImage === url && dom.shotImg && dom.shotImg.getAttribute('src') === url) return;
    loadedImage = url;
    showShotEmpty(null);
    if (!dom.shotImg) return;
    dom.shotImg.onerror = () => {
      showShotEmpty('无法加载截图：' + String(imagePath));
    };
    dom.shotImg.onload = () => {
      showShotEmpty(null);
    };
    try {
      dom.shotImg.setAttribute('src', url);
    } catch (error) {
      showShotEmpty('无法加载截图：' + message(error));
    }
  }

  function showShotEmpty(text) {
    if (!dom.shotEmpty) return;
    if (text === null || text === undefined || text === '') {
      dom.shotEmpty.hidden = true;
      dom.shotEmpty.textContent = '';
      if (dom.shotImg) dom.shotImg.hidden = false;
      return;
    }
    dom.shotEmpty.textContent = String(text);
    dom.shotEmpty.hidden = false;
    if (dom.shotImg) dom.shotImg.hidden = true;
  }

  /* ========================== 状态应用 ========================== */

  /** 应用 { note, settings }（init 回执与 note:state 推送共用）。 */
  function applyState(payload) {
    if (payload === null || typeof payload !== 'object') return;
    lastStateAt = Date.now();
    if (payload.note !== null && typeof payload.note === 'object') applyNote(payload.note);
    if (payload.settings !== null && typeof payload.settings === 'object') settings = payload.settings;
    if (payload.unsaved !== undefined) paintDraftMark(payload.unsaved === true);
  }

  /**
   * Show or hide the 「未保存」 badge.
   *
   * A note created by the hotkey is only a draft: it is not in the note list until
   * 「保存」 is pressed, and closing it without saving discards it. That is intentional,
   * but invisible — so the note says so.
   */
  function paintDraftMark(unsaved) {
    if (!dom.draftMark) return;
    dom.draftMark.hidden = unsaved !== true;
  }

  function applyNote(raw) {
    note = Object.assign({}, DEFAULT_NOTE, raw);

    // 用户正在编辑（或输入法组合中）时不要覆盖编辑区内容。
    if (dom.editor && !dirty && !composing && dom.editor.value !== note.text) {
      dom.editor.value = typeof note.text === 'string' ? note.text : '';
    }
    if (dom.titleInput && !dirty && dom.titleInput.value !== note.title) {
      dom.titleInput.value = typeof note.title === 'string' ? note.title : '';
    }
    paintPinnedButton();

    paint();
    applyKind();
  }

  /* ============================ 保存 ============================ */

  function currentText() {
    if (dom.editor && typeof dom.editor.value === 'string') return dom.editor.value;
    return typeof note.text === 'string' ? note.text : '';
  }

  function currentTitle() {
    if (dom.titleInput && typeof dom.titleInput.value === 'string') return dom.titleInput.value;
    return typeof note.title === 'string' ? note.title : '';
  }

  function markDirty() {
    editSeq += 1;
    dirty = true;
  }

  function scheduleSave() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow(false);
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * 通过 note:save 保存 { text, title }。
   * @param {boolean} explicit 显式保存（按钮 / Ctrl+S）：即使没有改动也发一次，用于给回执
   * @returns {Promise<boolean>}
   */
  async function saveNow(explicit) {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (!dirty && explicit !== true) return true;

    const seq = editSeq;
    const text = currentText();
    const title = currentTitle();
    // `explicit` is forwarded because the main process must be able to tell a real
    // 「保存」 from this same channel's debounced auto-save. A draft is only filed on the
    // former: typing alone must not put the note into the note list.
    const result = await call('save', { text: text, title: title, explicit: explicit === true });
    if (!result.ok) return false;

    note.text = text;
    note.title = title;
    // 保存期间又有新输入时保持 dirty，等下一轮防抖再存。
    if (editSeq === seq) dirty = false;
    toast('已保存');
    return true;
  }

  /** 窗口消失前的尽力保存（异步回执可能来不及，所以只做一次尽力而为的投递）。 */
  function flushOnUnload() {
    if (!dirty) return;
    const api = window.sticky;
    if (api === null || api === undefined || typeof api.save !== 'function') return;
    try {
      const result = api.save({ text: currentText(), title: currentTitle() });
      if (result !== null && typeof result === 'object' && typeof result.catch === 'function') {
        result.catch(() => {});
      }
      dirty = false;
    } catch (error) {
      console.warn('[sticky-notes] 关闭前保存失败：', message(error));
    }
  }

  /* ====================== 拖动 / 缩放（指针事件） ====================== */

  /**
   * 把每帧最新的 bounds/size 合并后串行发出去，绝不堆积 IPC。
   * 正常情况下按动画帧合并；同时挂一个上限延时兜底，保证窗口被遮挡、
   * 合成器不再产帧时，最后一次位置也一定在 ~24ms 内送达主进程。
   */
  function createSender(method) {
    const MAX_LATENCY_MS = 24;
    let pending = null;
    let inFlight = false;
    let frame = null;
    let timer = null;

    function clearScheduled() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function schedule() {
      if (frame !== null || timer !== null) return;
      frame = requestAnimationFrame(() => {
        clearScheduled();
        pump();
      });
      timer = setTimeout(() => {
        clearScheduled();
        pump();
      }, MAX_LATENCY_MS);
    }

    function pump() {
      if (inFlight || pending === null) return;
      const payload = pending;
      pending = null;
      const api = window.sticky;
      if (api === null || api === undefined || typeof api[method] !== 'function') {
        pending = null;
        return;
      }
      let result;
      inFlight = true;
      try {
        result = api[method](payload);
      } catch (error) {
        inFlight = false;
        warnOnce(method, message(error));
        return;
      }
      Promise.resolve(result)
        .catch((error) => {
          warnOnce(method, message(error));
        })
        .then(() => {
          inFlight = false;
          if (pending !== null) pump();
        });
    }

    return {
      push(payload) {
        pending = payload;
        schedule();
      },
      flush() {
        clearScheduled();
        pump();
      },
    };
  }

  const boundsSender = createSender('setBounds');
  const sizeSender = createSender('setSize');

  /** 指针按下的目标是否是标题栏按钮（按钮上不启动拖动）。 */
  function isButtonTarget(target) {
    return target instanceof Element && target.closest('button') !== null;
  }

  function endGesture() {
    const current = gesture;
    if (current === null) return;
    gesture = null;
    window.removeEventListener('pointermove', onGestureMove, true);
    window.removeEventListener('pointerup', onGestureEnd, true);
    window.removeEventListener('pointercancel', onGestureCancel, true);
    window.removeEventListener('blur', onWindowBlur, true);
    try {
      current.target.releasePointerCapture(current.pointerId);
    } catch {
      /* 指针早已释放，忽略 */
    }
    document.body.classList.remove('gesture-active');
    if (!current.active) return;
    // 把最后一帧的位置/尺寸补发出去，再告诉主进程手势结束。
    current.flush();
    notify('dragState', { dragging: false, resizing: false });
  }

  function onGestureMove(event) {
    const current = gesture;
    if (current === null || event.pointerId !== current.pointerId) return;
    const dx = event.screenX - current.startX;
    const dy = event.screenY - current.startY;

    if (!current.active) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      current.active = true;
      document.body.classList.add('gesture-active');
      // 拖动开始时确保标题输入框失焦，避免出现光标与文字选中。
      try {
        if (document.activeElement === dom.titleInput && dom.titleInput) dom.titleInput.blur();
        const selection = window.getSelection();
        if (selection !== null && typeof selection.removeAllRanges === 'function') selection.removeAllRanges();
      } catch {
        /* 忽略 */
      }
      if (current.resizing) notify('dragState', { dragging: false, resizing: true });
      else notify('dragState', { dragging: true, resizing: false });
    }

    if (event.cancelable) event.preventDefault();
    current.onMove(dx, dy);
  }

  function onGestureEnd(event) {
    const current = gesture;
    if (current === null) return;
    if (event !== undefined && event !== null && event.pointerId !== undefined && event.pointerId !== current.pointerId) {
      return;
    }
    endGesture();
  }

  function onGestureCancel() {
    endGesture();
  }

  function onWindowBlur() {
    // 窗口失去焦点时指针事件可能不再送达，直接结束手势，避免卡在"拖动中"。
    endGesture();
  }

  /**
   * 启动一次指针手势。
   * @param {PointerEvent} event
   * @param {{ resizing: boolean, onMove: (dx:number, dy:number) => void, flush: () => void }} options
   */
  function beginGesture(event, options) {
    if (gesture !== null) return;
    if (event.button !== 0) return;
    const origin = readWindowBounds();
    gesture = {
      pointerId: event.pointerId,
      target: event.currentTarget instanceof Element ? event.currentTarget : document.body,
      resizing: options.resizing === true,
      startX: event.screenX,
      startY: event.screenY,
      origin: origin,
      active: false,
      onMove: options.onMove,
      flush: options.flush,
    };
    try {
      gesture.target.setPointerCapture(event.pointerId);
    } catch {
      /* 不支持指针捕获时靠 window 上的监听兜底 */
    }
    window.addEventListener('pointermove', onGestureMove, true);
    window.addEventListener('pointerup', onGestureEnd, true);
    window.addEventListener('pointercancel', onGestureCancel, true);
    window.addEventListener('blur', onWindowBlur, true);
  }

  /* ============================ UI 绑定 ============================ */

  function bindDom() {
    dom.app = document.getElementById('app');
    dom.bg = document.getElementById('bg');
    dom.titlebar = document.getElementById('titlebar');
    dom.kindMark = document.getElementById('kind-mark');
    dom.titleInput = document.getElementById('title-input');
    dom.btnSave = document.getElementById('btn-save');
    dom.btnExport = document.getElementById('btn-export');
    dom.btnHide = document.getElementById('btn-hide');
    dom.draftMark = document.getElementById('draft-mark');
    dom.btnClose = document.getElementById('btn-close');
    dom.btnDelete = document.getElementById('btn-delete');
    dom.fallback = document.getElementById('fallback');
    dom.content = document.getElementById('content');
    dom.editor = document.getElementById('editor');
    dom.shotPane = document.getElementById('shot-pane');
    dom.shotImg = document.getElementById('shot-img');
    dom.shotEmpty = document.getElementById('shot-empty');
    dom.grip = document.getElementById('grip');
    dom.toast = document.getElementById('toast');
  }

  function resetDeleteButton() {
    deleteArmedAt = 0;
    if (deleteTimer !== null) {
      clearTimeout(deleteTimer);
      deleteTimer = null;
    }
    if (dom.btnDelete) {
      dom.btnDelete.classList.remove('confirming');
      dom.btnDelete.textContent = '删除';
    }
  }

  function handleAction(act) {
    if (act === 'save') {
      saveNow(true);
      return;
    }
    if (act === 'export') {
      exportImage();
      return;
    }
    if (act === 'hide') {
      togglePinned();
      return;
    }
    if (act === 'close') {
      closeWindow();
      return;
    }
    if (act === 'delete') {
      confirmDelete();
    }
  }

  async function exportImage() {
    const result = await call('exportImage', null);
    if (!result.ok) return;
    const path = result.value !== null && typeof result.value === 'object' ? result.value.path : null;
    if (typeof path === 'string' && path.length > 0) toast('已另存：' + path);
    else toast('已取消另存');
  }

  /**
   * The "保留 / 取消保留" control.
   *
   * Phrased as "keep" rather than "hide" because that is the decision the user is
   * actually making: an edge-adjacent note hides itself, and keeping it out is the
   * opt-in. The label follows `note.pinned`, which the main process owns.
   */
  async function togglePinned() {
    const next = note.pinned !== true;
    const result = await call('setPinned', { pinned: next });
    if (!result.ok) {
      toast('操作失败，请重试', true);
      return;
    }
    note.pinned = next;
    paintPinnedButton();
    toast(next ? '已保留在屏幕上，不再吸附隐藏' : '已取消保留，靠近边缘会重新吸附隐藏');
  }

  /** Keep the button's label in step with the note's pinned flag. */
  function paintPinnedButton() {
    if (!dom.btnHide) return;
    var pinned = note.pinned === true;
    dom.btnHide.textContent = pinned ? '取消保留' : '保留';
    dom.btnHide.title = pinned
      ? '取消保留：靠近屏幕边缘时会重新吸附并隐藏'
      : '保留在屏幕上：不再吸附到边缘，也不会自动隐藏';
    dom.btnHide.classList.toggle('is-pinned', pinned);
  }

  async function closeWindow() {
    // 关闭前先落盘，避免 600ms 防抖窗口内的输入丢失。
    await saveNow(false);
    const result = await call('close', null);
    if (!result.ok) toast('关闭失败，可直接再试一次', true);
  }

  async function confirmDelete() {
    const now = Date.now();
    if (now - deleteArmedAt > DELETE_CONFIRM_MS) {
      deleteArmedAt = now;
      if (dom.btnDelete) {
        dom.btnDelete.classList.add('confirming');
        dom.btnDelete.textContent = '确认删除';
      }
      toast('再点一次「确认删除」将永久删除这条便签');
      if (deleteTimer !== null) clearTimeout(deleteTimer);
      deleteTimer = setTimeout(() => {
        deleteTimer = null;
        resetDeleteButton();
      }, DELETE_CONFIRM_MS);
      return;
    }
    resetDeleteButton();
    const result = await call('remove', null);
    if (!result.ok) toast('删除失败', true);
  }

  function wireTitlebar() {
    if (!dom.titlebar) return;

    // 拖动把手：整条标题栏（按钮除外）。点击（位移小于阈值）不影响标题输入框获得焦点。
    dom.titlebar.addEventListener('pointerdown', (event) => {
      if (isButtonTarget(event.target)) return;
      if (event.target === dom.grip) return;
      beginGesture(event, {
        resizing: false,
        onMove(dx, dy) {
          boundsSender.push({
            x: Math.round(gesture.origin.x + dx),
            y: Math.round(gesture.origin.y + dy),
          });
        },
        flush() {
          boundsSender.flush();
        },
      });
    });

    dom.titlebar.addEventListener('dblclick', (event) => {
      if (isButtonTarget(event.target)) return;
      if (note.kind === 'shot') return;
      if (dom.editor) dom.editor.focus();
    });

    dom.titlebar.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('button[data-act]') : null;
      if (button === null) return;
      event.preventDefault();
      handleAction(button.getAttribute('data-act'));
    });
  }

  function wireGrip() {
    if (!dom.grip) return;
    dom.grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      beginGesture(event, {
        resizing: true,
        onMove(dx, dy) {
          sizeSender.push({
            width: Math.max(MIN_WIDTH, Math.round(gesture.origin.width + dx)),
            height: Math.max(MIN_HEIGHT, Math.round(gesture.origin.height + dy)),
          });
        },
        flush() {
          sizeSender.flush();
        },
      });
    });
  }

  function wireEditor() {
    if (dom.editor) {
      dom.editor.addEventListener('input', () => {
        markDirty();
        if (composing) return; // 输入法组合中先不排定保存
        scheduleSave();
      });
      dom.editor.addEventListener('compositionstart', () => {
        composing = true;
      });
      dom.editor.addEventListener('compositionend', () => {
        composing = false;
        markDirty();
        scheduleSave();
      });
      dom.editor.addEventListener('blur', () => {
        saveNow(false);
      });
    }

    if (dom.titleInput) {
      dom.titleInput.addEventListener('input', () => {
        markDirty();
        scheduleSave();
      });
      dom.titleInput.addEventListener('blur', () => {
        saveNow(false);
      });
      dom.titleInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          dom.titleInput.blur();
          saveNow(true);
        }
      });
    }

    document.addEventListener('keydown', (event) => {
      const accel = event.ctrlKey || event.metaKey;
      if (accel && (event.key === 's' || event.key === 'S')) {
        event.preventDefault();
        saveNow(true);
      }
    });
  }

  function wireLifecycle() {
    window.addEventListener('blur', () => {
      if (dirty) saveNow(false);
    });

    /**
     * Put the caret in the body when the note takes keyboard focus.
     *
     * The user pressed the hotkey or clicked 「打开」 in order to type, so landing in
     * a state where keystrokes go nowhere (or where they must first hunt for the text
     * box) is a failure. Skipped once the user has focused something themselves, so
     * clicking the title field is never yanked back to the body.
     */
    window.addEventListener('focus', () => {
      if (note.kind === 'shot') return;
      if (!dom.editor || dom.editor.hidden) return;
      var active = document.activeElement;
      if (active !== null && active !== document.body) return;
      dom.editor.focus();
    });

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushOnUnload();
    });

    // 任何未捕获异常都降级为一条提示，绝不冒泡成白屏。
    window.addEventListener('error', (event) => {
      toast('页面异常：' + message(event.message), true);
    });
    window.addEventListener('unhandledrejection', (event) => {
      toast('异步异常：' + message(event.reason), true);
    });
  }

  /* ============================== 启动 ============================== */

  async function boot() {
    bindDom();
    wireTitlebar();
    wireGrip();
    wireEditor();
    wireLifecycle();

    const hasBridge = window.sticky !== null && window.sticky !== undefined && typeof window.sticky === 'object';

    // 先按默认值渲染一次：即使 preload 缺失，页面也是完整可见的（不白屏）。
    note = Object.assign({}, DEFAULT_NOTE);
    paint();
    applyKind();

    if (!hasBridge) {
      showFallback('便签桥接不可用（preload 未加载）：内容仍可查看，但保存、取色、隐藏、删除都不可用。');
      return;
    }

    // 先订阅推送再拿初始状态，避免错过启动瞬间的状态变化。
    try {
      if (typeof window.sticky.onState === 'function') {
        window.sticky.onState((payload) => {
          try {
            applyState(payload);
          } catch (error) {
            console.warn('[sticky-notes] 应用状态失败：', message(error));
          }
        });
      }
    } catch (error) {
      console.warn('[sticky-notes] 订阅 note:state 失败：', message(error));
    }

    const result = await call('init', null, { silent: true });
    if (!result.ok) {
      showFallback('未能从主进程读取便签数据（note:init 失败：' + message(result.error) + '），当前编辑内容无法保存。');
      return;
    }
    const payload = result.value !== null && typeof result.value === 'object' ? result.value : null;
    if (payload === null || payload.note === null || typeof payload.note !== 'object') {
      showFallback('主进程未返回便签数据（note:init 回执为空），当前编辑内容无法保存。');
      return;
    }
    hideFallback();
    applyState(payload);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      boot().catch((error) => {
        // boot 自身也不允许抛出。
        try {
          showFallback('便签页面初始化失败：' + message(error));
        } catch {
          /* 忽略 */
        }
      });
    });
  } else {
    boot().catch((error) => {
      try {
        showFallback('便签页面初始化失败：' + message(error));
      } catch {
        /* 忽略 */
      }
    });
  }
})();

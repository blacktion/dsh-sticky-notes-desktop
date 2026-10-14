/**
 * dsh-sticky-notes — 截图选区 / 标注窗口 preload。
 *
 * CONTRACT.md 第 5 节「截图选区/标注窗口」把通道名冻结成下面 4 条，
 * 本文件是渲染层唯一能碰到 ipcRenderer 的地方：
 *
 *   shot:init    renderer→main  null                                   → { dataUrl, width, height, scaleFactor, mode }
 *   shot:commit  renderer→main  { dataUrl, width, height, target }     → { path, width, height }
 *   shot:cancel  renderer→main  null                                   → { ok: true }
 *   shot:copy    renderer→main  { dataUrl }                            → { ok: true }
 *
 * `target` ∈ 'file' | 'note' | 'both'，`dataUrl` 一律是 `data:image/png;base64,...`。
 *
 * 运行环境是 `contextIsolation: true` + `nodeIntegration: false` + `--enable-sandbox`
 * 的渲染进程，因此这里：
 *   - 只用 CommonJS（沙箱 preload 不支持 ESM）；
 *   - 只 `require('electron')`，不碰 fs/path/child_process；
 *   - 暴露出去的对象是**冻结的普通对象**，只含 4 个方法，没有 ipcRenderer 泄漏；
 *   - 任何一处失败都不会抛到渲染层之外（渲染层 shot.js 还会再兜一层 try/catch）。
 *
 * 页面侧对应 `window.shot`，见 electron/shot.js 的 `detectApi()`。
 */
'use strict';

/** 冻结的通道名表：改名即违反契约。 */
const CHANNELS = Object.freeze({
  INIT: 'shot:init',
  COMMIT: 'shot:commit',
  CANCEL: 'shot:cancel',
  COPY: 'shot:copy',
});

/** `shot:commit` 允许的 target。 */
const TARGETS = Object.freeze(['file', 'note', 'both']);

/** `data:image/png;base64,` 前缀长度。 */
const PNG_PREFIX = 'data:image/png;base64,';

/**
 * 沙箱 preload 里 `require('electron')` 一定成功，但万一宿主环境异常
 * （例如 preload 被别的东西加载），也不能让渲染进程直接白屏：
 * 这里降级为「什么都不暴露」，页面会走自己的降级提示分支。
 */
let ipcRenderer = null;
let contextBridge = null;
try {
  // eslint-disable-next-line global-require
  const electron = require('electron');
  ipcRenderer = electron && electron.ipcRenderer ? electron.ipcRenderer : null;
  contextBridge = electron && electron.contextBridge ? electron.contextBridge : null;
} catch (error) {
  ipcRenderer = null;
  contextBridge = null;
  // 不用 console.error：某些宿主会把 error 级别当异常上报。
  console.warn('[sticky-notes/shot] preload 无法加载 electron 模块：', error && error.message);
}

/** 数字归一化：正数才接受，否则用兜底值。 */
function positiveInt(value, fallback) {
  const rounded = Math.round(Number(value));
  return Number.isFinite(rounded) && rounded > 0 ? rounded : fallback;
}

/** scaleFactor 归一化：必须是 > 0 的有限数，否则按 1 处理。 */
function normalizeScaleFactor(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** 是否是契约要求的 PNG dataUrl。 */
function isPngDataUrl(value) {
  return typeof value === 'string' && value.length > PNG_PREFIX.length && value.startsWith(PNG_PREFIX);
}

/**
 * 有限数字，否则 null。
 *
 * 用于「截图来自哪里」这类可选坐标：页面拿不到时给 null，让主进程自己决定，
 * 而不是把 NaN 传下去变成非法窗口坐标。
 */
function finiteOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * 调用主进程，并把「没有 ipcRenderer」这种情况变成一个可捕获的 rejection，
 * 而不是同步异常 —— 渲染层的 await 才能统一处理。
 */
function invoke(channel, payload) {
  if (ipcRenderer === null || typeof ipcRenderer.invoke !== 'function') {
    return Promise.reject(new Error('IPC 不可用：preload 未能初始化 ipcRenderer'));
  }
  try {
    return Promise.resolve(ipcRenderer.invoke(channel, payload));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * `window.shot.init()` → 主进程回执归一化。
 * 契约形状：`{ dataUrl, width, height, scaleFactor, mode }`。
 * 主进程给的字段缺失时补成安全默认值，页面再决定是否降级。
 */
async function init() {
  const raw = await invoke(CHANNELS.INIT, null);
  const source = raw && typeof raw === 'object' ? raw : {};
  // 主进程的失败形状是 `{ error }`（不是 throw），这里翻译成 rejection，
  // 页面就能把「为什么拿不到截图」直接显示在降级提示里。
  if (typeof source.error === 'string' && source.error.length > 0 && typeof source.dataUrl !== 'string') {
    throw new Error(source.error);
  }
  return {
    dataUrl: typeof source.dataUrl === 'string' ? source.dataUrl : '',
    width: positiveInt(source.width, 0),
    height: positiveInt(source.height, 0),
    scaleFactor: normalizeScaleFactor(source.scaleFactor),
    mode: typeof source.mode === 'string' && source.mode.length > 0 ? source.mode : 'shot',
  };
}

/**
 * `window.shot.commit({ dataUrl, width, height, target })`
 * → `{ path, width, height }`。
 *
 * 载荷非法时**同步拒绝**（返回 rejected Promise），因为把一张空图交给主进程
 * 只会让用户看到一个莫名其妙的空文件。页面会 toast 报错。
 */
async function commit(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!isPngDataUrl(source.dataUrl)) {
    throw new Error('commit 需要 { dataUrl } 且必须是 data:image/png;base64,...');
  }
  const target = TARGETS.indexOf(source.target) >= 0 ? source.target : 'file';
  const result = await invoke(CHANNELS.COMMIT, {
    dataUrl: source.dataUrl,
    width: positiveInt(source.width, 0),
    height: positiveInt(source.height, 0),
    target,
    // Where the capture came from, so 「存为便签」 puts the note where the user actually
    // selected instead of at the top-left corner of the screen. Forwarded explicitly —
    // this object is rebuilt field by field, so anything not listed here is dropped.
    screenX: finiteOrNull(source.screenX),
    screenY: finiteOrNull(source.screenY),
  });
  const ack = result && typeof result === 'object' ? result : {};
  // `shot:commit` 出错时回执是 `{ error }`（例如「图像数据无效」「写入 PNG 失败」），
  // 统一转成 rejection，页面只处理一种失败形态。
  if (typeof ack.error === 'string' && ack.error.length > 0 && typeof ack.path !== 'string') {
    throw new Error(ack.error);
  }
  return {
    path: typeof ack.path === 'string' ? ack.path : null,
    width: positiveInt(ack.width, positiveInt(source.width, 0)),
    height: positiveInt(ack.height, positiveInt(source.height, 0)),
    // Forwarded, not rebuilt away: 「保存」 asks for a location and the user can cancel,
    // which is neither success nor failure. Dropping this made a cancelled save look like
    // a successful one, closing the window and losing the annotation.
    cancelled: ack.cancelled === true,
  };
}

/** `window.shot.cancel()` → `{ ok: true }`。 */
async function cancel() {
  const result = await invoke(CHANNELS.CANCEL, null);
  const ack = result && typeof result === 'object' ? result : {};
  return { ok: ack.ok !== false };
}

/** `window.shot.copy({ dataUrl })` → `{ ok: true }`。 */
async function copy(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  if (!isPngDataUrl(source.dataUrl)) {
    throw new Error('copy 需要 { dataUrl } 且必须是 data:image/png;base64,...');
  }
  const result = await invoke(CHANNELS.COPY, { dataUrl: source.dataUrl });
  const ack = result && typeof result === 'object' ? result : {};
  // 剪贴板失败同样是 `{ ok: false, error }` 而不是 throw。
  if (ack.ok === false) {
    throw new Error(typeof ack.error === 'string' && ack.error.length > 0 ? ack.error : '剪贴板写入失败');
  }
  return { ok: true };
}

/** 暴露给页面的 API —— 只有契约里的 4 个方法，别的都不给。 */
const shotApi = Object.freeze({
  init,
  commit,
  cancel,
  copy,
});

if (contextBridge !== null && typeof contextBridge.exposeInMainWorld === 'function') {
  try {
    contextBridge.exposeInMainWorld('shot', shotApi);
  } catch (error) {
    console.warn('[sticky-notes/shot] exposeInMainWorld 失败：', error && error.message);
  }
} else {
  console.warn('[sticky-notes/shot] contextBridge 不可用，window.shot 未暴露（页面会显示降级提示）');
}

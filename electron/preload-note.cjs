/**
 * dsh-sticky-notes — 便签窗口 preload。
 *
 * 契约：便签窗口的 IPC 通道名已冻结，本文件不做任何改名。这些名字是 preload、主进程
 * （`main.mjs`）与渲染页面三方共用的字符串，改一处而漏一处就会静默失联。
 *
 * 运行环境：Electron 渲染进程，contextIsolation: true / nodeIntegration: false /
 * 已开启 --enable-sandbox。所以这里只做两件事：
 *
 *   1. require('electron') 取 contextBridge + ipcRenderer（沙箱 preload 允许）；
 *   2. 把**全部**通道包装成 window.sticky 一个对象暴露给页面。
 *
 * 主进程侧的对应要求（供 main.cjs 对齐）：
 *
 *   - 请求/回执型通道用 `ipcMain.handle(通道, (event, payload) => result)` 注册，
 *     本文件用 `ipcRenderer.invoke(通道, payload)` 调用；
 *   - 推送通道 `note:state` 用 `event.sender.send('note:state', { note, settings })`
 *     或 `win.webContents.send('note:state', { note, settings })` 发送。
 *
 * 兜底：若某通道没有 handle 注册（报 "No handler registered"），会再尝试
 * `ipcRenderer.send(通道, payload)` 并等待主进程在**同一通道**回执一次，
 * 兼容主机侧 `ipcMain.on(ch, (e, p) => e.sender.send(ch, result))` 的写法。
 * 这只是兼容路径，不改变任何通道名与载荷形状。
 *
 * 约定：所有方法都返回 Promise；失败时 reject 一个带通道名的人类可读 Error，
 * 由渲染层 try/catch 后做非阻塞提示（渲染层绝不因此白屏或抛未捕获异常）。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** 便签窗口通道表。`note:pickColor` 已随「取色」按钮一并移除。 */
const CH = Object.freeze({
  init: 'note:init',
  save: 'note:save',
  update: 'note:update',
  close: 'note:close',
  remove: 'note:delete',
  hide: 'note:hide',
  setPinned: 'note:setPinned',
  exportImage: 'note:exportImage',
  commitText: 'note:commitText',
  setBounds: 'note:setBounds',
  setSize: 'note:setSize',
  dragState: 'note:dragState',
  state: 'note:state',
});

/** 兼容兜底时等待主进程回执的上限。 */
const REPLY_TIMEOUT_MS = 2000;

/** 主进程没注册 handle 时 Electron 报出的错误特征。 */
const NO_HANDLER_RE = /no handler registered/i;

/* ------------------------------------------------------------------ 工具 */

/** 把任意抛出物转成可读文本。 */
function describe(error) {
  if (error === null || error === undefined) return '';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message.length > 0) return error.message;
  try {
    return String(error);
  } catch {
    return '';
  }
}

/** 统一的错误包装：带上通道名，方便渲染层直接展示。 */
function channelError(channel, error) {
  return new Error(`[${channel}] ${describe(error) || '未知错误'}`);
}

/** 有限数字校验：不合法就抛错（绝不把垃圾值当坐标发给主进程）。 */
function requireFinite(value, label, channel) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`[${channel}] ${label} 必须是有限数字`);
  return Math.round(n);
}

/** 浅拷贝补丁对象，丢掉 undefined（避免把 undefined 当"清空"语义带过去）。 */
function cleanPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const out = {};
  for (const key of Object.keys(patch)) {
    if (patch[key] !== undefined) out[key] = patch[key];
  }
  return out;
}

/* -------------------------------------------------------------- IPC 调用 */

/**
 * 兼容兜底：send + 同通道等待一次回执。
 * @returns {Promise<unknown>}
 */
function requestViaSend(channel, payload) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      ipcRenderer.removeListener(channel, onReply);
    };

    function onReply(_event, reply) {
      if (done) return;
      done = true;
      cleanup();
      resolve(reply);
    }

    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('等待主进程回执超时'));
    }, REPLY_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    ipcRenderer.on(channel, onReply);
    try {
      ipcRenderer.send(channel, payload);
    } catch (error) {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    }
  });
}

/**
 * 契约里的「请求 → 回执」调用：优先 invoke，缺 handle 时退化为 send + 同通道回执。
 * @param {string} channel
 * @param {unknown} payload  契约规定载荷；无载荷的通道传 null
 * @returns {Promise<unknown>}
 */
function request(channel, payload) {
  return ipcRenderer.invoke(channel, payload).catch((error) => {
    if (!NO_HANDLER_RE.test(describe(error))) throw channelError(channel, error);
    // 主进程可能用了 ipcMain.on + 同通道回执：再试一次。
    return requestViaSend(channel, payload).catch(() => {
      throw channelError(channel, error);
    });
  });
}

/* ------------------------------------------------------- window.sticky API */

/**
 * 便签窗口 API（契约 §5 逐条对应）。
 * 方法名 = 契约语义名；通道名固定，见上方 CH。
 */
const sticky = {
  /* note:init → { note, settings } */
  init() {
    return request(CH.init, null);
  },

  /* note:save → { ok:true }；载荷 { text, title, explicit } */
  save(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    return request(CH.save, {
      text: typeof input.text === 'string' ? input.text : '',
      title: typeof input.title === 'string' ? input.title : '',
      // Forwarded, not rebuilt away. The main process needs this to tell a real
      // 「保存」 from the debounced auto-save, which shares this channel; dropping it
      // here would make every save look like an auto-save, so a draft would never be
      // filed and the note would never reach the list.
      explicit: input.explicit === true,
    });
  },

  /* note:update → { ok:true }；载荷 Partial<Note> */
  update(patch) {
    return request(CH.update, cleanPatch(patch));
  },

  /* note:close → { ok:true }（关窗，保留数据） */
  close() {
    return request(CH.close, null);
  },

  /* note:delete → { ok:true }（关窗并删数据） */
  remove() {
    return request(CH.remove, null);
  },

  /* note:hide → { ok:true }；载荷 { hidden }（程序化隐藏/恢复） */
  hide(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    return request(CH.hide, { hidden: input.hidden === true });
  },

  /* note:setPinned → { ok:true, pinned }；载荷 { pinned }（「保留」按钮） */
  setPinned(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    return request(CH.setPinned, { pinned: input.pinned === true });
  },

  /* note:exportImage → { path: string|null }（截图便签另存 PNG） */
  exportImage() {
    return request(CH.exportImage, null);
  },

  /* note:commitText → 防抖自动保存的轻量文本提交；载荷 { text } */
  commitText(payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {};
    return request(CH.commitText, { text: typeof input.text === 'string' ? input.text : '' });
  },

  /* note:setBounds → 载荷 { x, y }（拖动时由渲染层计算屏幕坐标） */
  setBounds(bounds) {
    const input = bounds !== null && typeof bounds === 'object' ? bounds : {};
    return request(CH.setBounds, {
      x: requireFinite(input.x, 'x', CH.setBounds),
      y: requireFinite(input.y, 'y', CH.setBounds),
    });
  },

  /* note:setSize → 载荷 { width, height }（右下角握把缩放） */
  setSize(size) {
    const input = size !== null && typeof size === 'object' ? size : {};
    const width = requireFinite(input.width, 'width', CH.setSize);
    const height = requireFinite(input.height, 'height', CH.setSize);
    if (width < 1 || height < 1) throw new Error(`[${CH.setSize}] width/height 必须为正数`);
    return request(CH.setSize, { width, height });
  },

  /* note:dragState → 载荷 { dragging, resizing }（主进程据此暂停吸附/隐藏） */
  dragState(state) {
    const input = state !== null && typeof state === 'object' ? state : {};
    return request(CH.dragState, {
      dragging: input.dragging === true,
      resizing: input.resizing === true,
    });
  },

  /**
   * 订阅主进程推送的 note:state。
   * @param {(state: { note?: object, settings?: object }) => void} callback
   * @returns {() => void} 取消订阅（可重复调用，安全）
   */
  onState(callback) {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => {
      try {
        callback(payload !== null && typeof payload === 'object' ? payload : {});
      } catch (error) {
        // 订阅者的异常不能污染 preload / 主进程通信。
        console.warn('[sticky-notes] note:state 回调异常：', describe(error));
      }
    };
    ipcRenderer.on(CH.state, listener);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        ipcRenderer.removeListener(CH.state, listener);
      } catch {
        /* 忽略：窗口已在销毁 */
      }
    };
  },
};

/* --------------------------------------------------------------- 暴露 */

try {
  contextBridge.exposeInMainWorld('sticky', sticky);
} catch (error) {
  console.warn('[sticky-notes] contextBridge 暴露 window.sticky 失败：', describe(error));
  // 最后兜底：仅当 contextIsolation 未开启时才可能生效（不属于契约配置）。
  try {
    window.sticky = sticky;
  } catch (inner) {
    console.warn('[sticky-notes] 直接挂载 window.sticky 也失败：', describe(inner));
  }
}

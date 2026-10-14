/**
 * Preload for the hotkey popup.
 *
 * Exposes exactly two things to the page: the rows to draw, and one way to answer.
 * The renderer never decides anything about the session — it reports the user's
 * click and the main process settles the request.
 *
 * Plain CommonJS, no imports: a sandboxed preload may only `require('electron')`.
 */
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Describe a failure without assuming the value is an Error.
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (error === null || error === undefined) return '未知错误';
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** The rows the main process will accept. Mirrors `ITEMS` in popup.mjs. */
const ITEMS = Object.freeze([
  Object.freeze({ id: 'new-note', label: '新建便签', glyph: '▤' }),
  Object.freeze({ id: 'shot', label: '截图', glyph: '▣' }),
]);

const api = {
  /**
   * Rows to render, with the ids the main process understands.
   * @returns {Promise<Array<{id: string, label: string, glyph: string}>|null>}
   */
  async items() {
    try {
      const reply = await ipcRenderer.invoke('popup:items', null);
      if (reply !== null && typeof reply === 'object' && Array.isArray(reply.items)) return reply.items;
    } catch (error) {
      console.warn('[sticky-notes] 读取弹窗菜单项失败：', describe(error));
    }
    // Fall back to the local copy so a broken round trip does not produce a blank
    // popup the user cannot act on.
    return ITEMS.map((item) => ({ ...item }));
  },

  /**
   * Report the chosen row. Resolves once the main process has taken it, which also
   * means the window is about to disappear.
   * @param {string} id
   */
  async choose(id) {
    try {
      await ipcRenderer.invoke('popup:choose', { id: String(id) });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },

  /** Dismiss without choosing (`Escape`). */
  async dismiss() {
    try {
      await ipcRenderer.invoke('popup:dismiss', null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
};

try {
  contextBridge.exposeInMainWorld('popup', api);
} catch (error) {
  console.warn('[sticky-notes] contextBridge 暴露 window.popup 失败：', describe(error));
}

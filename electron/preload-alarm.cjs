/**
 * dsh-sticky-notes — preload for the 便签闹钟 popup.
 *
 * Two methods and nothing else: read what to show, and close. The page cannot reach the
 * file system, and it never decides anything about the alarm's schedule.
 *
 * Plain CommonJS, sandboxed: only `require('electron')` is available.
 */
const { contextBridge, ipcRenderer } = require('electron');

/** Describe a failure without assuming it is an Error. */
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

const api = {
  /**
   * What this alarm should display.
   * @returns {Promise<{alarm?: object, error?: string}>}
   */
  async init() {
    try {
      const reply = await ipcRenderer.invoke('alarm:init', null);
      return reply !== null && typeof reply === 'object' ? reply : { error: '主进程未返回闹钟数据' };
    } catch (error) {
      return { error: describe(error) };
    }
  },

  /**
   * Dismiss this alarm. Resolves once the main process has taken it, which also means the
   * window is about to disappear.
   */
  async close() {
    try {
      await ipcRenderer.invoke('alarm:close', null);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: describe(error) };
    }
  },
};

try {
  contextBridge.exposeInMainWorld('alarm', api);
} catch (error) {
  console.warn('[sticky-notes/alarm] exposeInMainWorld 失败：', describe(error));
}

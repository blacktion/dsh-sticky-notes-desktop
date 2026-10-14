/**
 * dsh-sticky-notes — the 便签闹钟 popup.
 *
 * One always-on-top window per firing alarm. It floats above everything, says what it has to
 * say (text or an image), and disappears when the user closes it — that is the whole
 * contract. Unlike a note it is not persisted, not draggable-into-an-edge, and never hides
 * itself: an alarm that quietly slid off screen would be worse than no alarm at all.
 *
 * Several alarms firing at once get several windows, so dismissing one does not dismiss
 * another. Re-firing the same alarm replaces its window instead of stacking a second one.
 *
 * @module dsh-sticky-notes/electron/alarm-windows
 */
import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Window size bounds (px). The window is sized to the content, within these. */
const MIN_WIDTH = 280;
const MAX_WIDTH = 620;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 620;

/** The id a preview of an *unsaved* alarm is shown under. */
export const DRAFT_ALARM_ID = '__draft__';

/**
 * A finite number, or null — never a coerced zero.
 *
 * `Number(null)` and `Number('')` are both `0`, so the obvious-looking null guard
 * `Number.isFinite(Number(value))` silently accepts "absent" as the coordinate 0. Every
 * optional number here has to go through this instead.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export class AlarmWindows {
  #emit;
  #logger;
  /** @type {Map<string, {window: BrowserWindow, alarm: object}>} alarm id → window */
  #windows = new Map();

  /**
   * @param {object} options
   * @param {(event: string, data: object) => void} options.emit
   * @param {(message: string) => void} [options.logger]
   */
  constructor(options) {
    this.#emit = options.emit;
    this.#logger = options.logger ?? (() => {});
  }

  /** Ids of alarms currently on screen. */
  openIds() {
    return [...this.#windows.keys()];
  }

  /**
   * Where one alarm's popup currently is, or null when it is not open.
   *
   * Exists so a caller can name a *specific* alarm's window. Matching on the window title does
   * not work — the page's own `<title>` overrides `setTitle`, so every popup is titled 便签闹钟
   * and "the first match" is whichever alarm happens to be first.
   *
   * @param {string} id
   */
  boundsFor(id) {
    const entry = this.#windows.get(String(id));
    if (entry === undefined || entry.window.isDestroyed()) return null;
    try {
      return entry.window.getBounds();
    } catch {
      return null;
    }
  }

  /** The live window for an alarm, or null. Used by the test hook that drives a move. */
  windowFor(id) {
    const entry = this.#windows.get(String(id));
    if (entry === undefined || entry.window.isDestroyed()) return null;
    return entry.window;
  }

  /**
   * Show an alarm popup, replacing any window already open for that alarm.
   *
   * @param {object} alarm
   * @returns {{ok: boolean, id?: string, error?: string}}
   */
  show(alarm) {
    const id = typeof alarm?.id === 'string' && alarm.id.length > 0 ? alarm.id : null;
    if (id === null) return { ok: false, error: '闹钟缺少 id' };

    this.close(id);

    // Sized to the content: a one-line reminder should not open a billboard, and a
    // screenshot should not be squeezed into a postage stamp.
    const text = typeof alarm.text === 'string' ? alarm.text : '';
    const hasImage = alarm.kind === 'image' && typeof alarm.image === 'string' && alarm.image.length > 0;
    const lines = Math.min(12, Math.max(1, text.split('\n').length));
    const width = hasImage ? 460 : Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, 300 + Math.min(240, text.length * 3)));
    const height = hasImage ? 520 : Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, 150 + lines * 26));

    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    // A stored position wins; otherwise dead centre of the work area. The user sets the stored
    // position by dragging the popup during 试响.
    //
    // `finiteOrNull`, not `Number.isFinite(Number(x))`: **`Number(null)` is 0**, so that check
    // reports "no position stored" as the perfectly finite position (0,0) and parks every alarm
    // in the top-left corner instead of centring it. The bug is invisible in the code — the
    // expression looks like a null guard and is not one.
    const storedX = finiteOrNull(alarm.x);
    const storedY = finiteOrNull(alarm.y);
    const stored = storedX === null || storedY === null ? null : { x: storedX, y: storedY };
    // Centred on the *work area*, not the full display, so a taskbar does not push the alarm
    // visibly off-centre.
    const centre = {
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
    };
    // Clamped into the work area: an alarm saved on a screen that is now gone (undocked, or a
    // resolution change) must still appear somewhere reachable, not off-screen where it
    // cannot be closed.
    const x =
      stored === null
        ? centre.x
        : Math.min(Math.max(stored.x, area.x), Math.max(area.x, area.x + area.width - width));
    const y =
      stored === null
        ? centre.y
        : Math.min(Math.max(stored.y, area.y), Math.max(area.y, area.y + area.height - height));

    let window;
    try {
      window = new BrowserWindow({
        x,
        y,
        width,
        height,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        frame: false,
        transparent: true,
        hasShadow: true,
        resizable: true,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // Above the notes: an alarm must be the most visible thing on screen.
        alwaysOnTop: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: join(HERE, 'preload-alarm.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      return { ok: false, error: `无法创建闹钟窗口：${error instanceof Error ? error.message : String(error)}` };
    }

    this.#windows.set(id, { window, alarm: { ...alarm } });

    window.loadFile(join(HERE, 'alarm.html')).catch((error) => {
      this.#logger(`闹钟页面加载失败：${String(error)}`);
    });

    window.once('ready-to-show', () => {
      try {
        // `screen-saver` is the highest level; an alarm that loses a z-order fight is a
        // missed alarm. `show()` (not `showInactive`) because the alarm is *meant* to take
        // attention — that is what the user asked for when they set it.
        window.setAlwaysOnTop(true, 'screen-saver');
        window.show();
        window.focus();
      } catch (error) {
        this.#logger(`显示闹钟失败：${String(error)}`);
      }
    });

    /**
     * Report where the user dragged the popup, so 试响 can double as a position picker.
     *
     * This is the whole mechanism behind "drag it where you want it": the window is the alarm,
     * so its own position IS the setting. Throttled because a drag emits continuously and the
     * consumer only cares about where it came to rest.
     */
    let moveTimer = null;
    window.on('move', () => {
      if (window.isDestroyed()) return;
      if (moveTimer !== null) clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        moveTimer = null;
        if (window.isDestroyed()) return;
        try {
          const bounds = window.getBounds();
          this.#emit('alarm.moved', { id, x: bounds.x, y: bounds.y });
        } catch {
          /* ignore */
        }
      }, 250);
    });

    window.on('closed', () => {
      if (moveTimer !== null) clearTimeout(moveTimer);
      moveTimer = null;
      const entry = this.#windows.get(id);
      if (entry !== undefined && entry.window === window) this.#windows.delete(id);
      this.#emit('alarm.closed', { id });
    });

    return { ok: true, id };
  }

  /** Close one alarm's window. Returns true when there was one. */
  close(id) {
    const entry = this.#windows.get(String(id));
    if (entry === undefined) return false;
    this.#windows.delete(String(id));
    try {
      if (!entry.window.isDestroyed()) entry.window.destroy();
    } catch {
      /* ignore */
    }
    return true;
  }

  /** Close every alarm window. */
  closeAll() {
    for (const id of [...this.#windows.keys()]) this.close(id);
  }

  /**
   * The payload the alarm page renders.
   * @param {number} webContentsId
   */
  payloadFor(webContentsId) {
    for (const entry of this.#windows.values()) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === webContentsId) {
        return {
          alarm: {
            id: entry.alarm.id,
            label: typeof entry.alarm.label === 'string' ? entry.alarm.label : '',
            kind: entry.alarm.kind === 'image' ? 'image' : 'text',
            text: typeof entry.alarm.text === 'string' ? entry.alarm.text : '',
            // A `file://` URL: the page is sandboxed and cannot read arbitrary paths, and
            // the image may live anywhere the user picked.
            imageUrl: toFileUrl(entry.alarm.image),
          },
        };
      }
    }
    return { error: '闹钟窗口不存在' };
  }
}

/**
 * Turn a local path into a `file://` URL the sandboxed page can load.
 *
 * `pathToFileURL` rather than string surgery. A hand-built URL has to get several details
 * right at once — the third slash, not encoding the drive colon, encoding spaces but not
 * separators — and getting any of them wrong yields a URL Chromium resolves relative to the
 * document, i.e. an image that silently never loads.
 *
 * @param {unknown} path
 * @returns {string|null}
 */
function toFileUrl(path) {
  if (typeof path !== 'string') return null;
  const raw = path.trim();
  if (raw.length === 0) return null;
  if (/^(file|data|blob|https?):/i.test(raw)) return raw;
  try {
    return pathToFileURL(raw).href;
  } catch {
    return null;
  }
}

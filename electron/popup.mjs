/**
 * dsh-sticky-notes — the pointer-anchored "new note / screenshot" popup.
 *
 * An **owned HTML window**, not a native `Menu`.
 *
 * The native menu was the obvious choice (free shadow, keyboard navigation, OS
 * dismissal) and it was a mistake in practice: `Menu.popup`'s dismissal callback
 * does not reliably fire on Windows, and its outside-click behaviour is not ours to
 * control. The user-visible result was the worst possible one — the menu stayed on
 * screen when they clicked elsewhere, and because the pending state was only
 * cleared by that same callback, every later hotkey press was answered with
 * `busy`, i.e. the shortcut appeared dead.
 *
 * Owning the surface means the dismissal rules are ours and testable:
 *
 *   - clicking either row answers the request,
 *   - `Escape` dismisses it,
 *   - a frame-with-options that ends without an answer dismisses it — the
 *     cancellation path that used to be missing,
 *   - and moving the pointer away from the popup closes it, which is what a user
 *     means by "I clicked outside": the click lands on the window underneath while
 *     the popup gets out of the way first.
 *
 * @module dsh-sticky-notes/electron/popup
 */
import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Menu entries, in display order. Mirrored by `popup.html`. */
const ITEMS = [
  { id: 'new-note', label: '新建便签' },
  { id: 'shot', label: '截图' },
];

/** Popup dimensions, in px. Kept in sync with the stylesheet and the page. */
export const POPUP_WIDTH = 168;
export const POPUP_HEIGHT = 88;

/** How often to check whether the pointer has left the popup (ms). */
const POINTER_POLL_MS = 50;

/**
 * How long the pointer must stay outside before the popup dismisses itself (ms).
 *
 * A couple of frames, not zero: the popup appears under the pointer, and a
 * one-frame excursion from mouse jitter or a pointer warp must not close it.
 */
const OUTSIDE_GRACE_MS = 120;

/** Safety net so a popup nobody answers can never linger forever (ms). */
const SESSION_TIMEOUT_MS = 30_000;

export class PopupController {
  #emit;
  #logger;
  #window = null;
  #open = false;
  /** Set while a popup is on screen: the caller's settle function. */
  #settle = null;
  #pollTimer = null;
  #timeoutTimer = null;
  #outsideSince = null;

  /**
   * @param {object} options
   * @param {(event: string, data: object) => void} options.emit
   * @param {() => {x:number, y:number}} [options.getCursor] pointer source; the
   *        real one is `screen.getCursorScreenPoint`, injectable so the
   *        pointer-away dismissal can be exercised without a human
   * @param {(message: string) => void} [options.logger]
   */
  constructor(options) {
    this.#emit = options.emit;
    this.#logger = options.logger ?? (() => {});
    this.#getCursor = options.getCursor ?? (() => screen.getCursorScreenPoint());
  }

  #getCursor;

  /** True while a popup is on screen. */
  get isOpen() {
    return this.#open;
  }

  /** The live popup window, so `main.mjs` can route its IPC messages. */
  get window() {
    return this.#window;
  }

  /**
   * Show the popup at a point and report the chosen item.
   *
   * @param {{x:number, y:number}} point
   * @param {(choice: string|null) => void} done  receives `'new-note'`, `'shot'`,
   *        or `null` when the popup was dismissed
   */
  show(point, done) {
    this.close();

    let settled = false;
    const finish = (choice) => {
      if (settled) return;
      settled = true;
      this.#settle = null;
      this.#teardown();
      try {
        done(choice);
      } catch (error) {
        this.#logger(`弹窗回调失败：${String(error)}`);
      }
    };
    this.#settle = finish;

    const target = screen.getDisplayNearestPoint(point);
    const area = target.workArea;
    // Keep the whole popup on screen: the pointer is often at an edge, and a popup
    // half off-screen would be unclickable.
    const x = Math.round(Math.min(Math.max(point.x, area.x), area.x + area.width - POPUP_WIDTH));
    const y = Math.round(Math.min(Math.max(point.y, area.y), area.y + area.height - POPUP_HEIGHT));

    let window;
    try {
      window = new BrowserWindow({
        x,
        y,
        width: POPUP_WIDTH,
        height: POPUP_HEIGHT,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        // Not focusable: the popup must never take focus from whatever the user is
        // typing in when they press the hotkey. Dismissal is detected by polling the
        // pointer instead of by losing focus.
        focusable: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: join(HERE, 'preload-popup.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      this.#emit('helper.error', {
        message: `无法创建弹窗：${error instanceof Error ? error.message : String(error)}`,
      });
      finish(null);
      return;
    }

    this.#window = window;
    this.#open = true;
    this.#outsideSince = null;

    window.loadFile(join(HERE, 'popup.html')).catch((error) => {
      this.#emit('helper.error', { message: `弹窗页面加载失败：${String(error)}` });
      finish(null);
    });

    window.once('ready-to-show', () => {
      try {
        window.setAlwaysOnTop(true, 'screen-saver');
        // `showInactive` for the same reason `focusable` is false.
        window.showInactive();
        this.#startWatching();
      } catch (error) {
        this.#emit('helper.error', { message: `显示弹窗失败：${String(error)}` });
        finish(null);
      }
    });

    // A popup the user closes by any other means must still answer the caller.
    window.on('closed', () => {
      if (this.#window === window) this.#window = null;
      finish(null);
    });
  }

  /**
   * Answer the popup from the renderer (a row was clicked) or from `main.mjs`.
   * @param {string|null} choice
   */
  answer(choice) {
    const settle = this.#settle;
    if (settle === null) return;
    const valid = choice === 'new-note' || choice === 'shot' ? choice : null;
    settle(valid);
  }

  // ------------------------------------------------------------- watching ==

  #startWatching() {
    this.#stopWatching();
    this.#pollTimer = setInterval(() => this.#pollPointer(), POINTER_POLL_MS);
    this.#timeoutTimer = setTimeout(() => {
      this.#logger('弹窗超时未响应，自动关闭');
      this.answer(null);
    }, SESSION_TIMEOUT_MS);
  }

  #stopWatching() {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#timeoutTimer !== null) {
      clearTimeout(this.#timeoutTimer);
      this.#timeoutTimer = null;
    }
    this.#outsideSince = null;
  }

  /**
   * Dismiss the popup once the pointer has left it.
   *
   * This is how "clicking outside" is handled: the popup gets out of the way the
   * moment the pointer leaves, so the click lands where the user aimed it and no
   * menu is left behind.
   */
  #pollPointer() {
    const window = this.#window;
    if (this.#settle === null || window === null || window.isDestroyed()) return;

    let cursor;
    let bounds;
    try {
      cursor = this.#getCursor();
      bounds = window.getBounds();
    } catch {
      return;
    }

    const inside =
      cursor.x >= bounds.x &&
      cursor.x < bounds.x + bounds.width &&
      cursor.y >= bounds.y &&
      cursor.y < bounds.y + bounds.height;

    if (inside) {
      this.#outsideSince = null;
      return;
    }

    const now = Date.now();
    if (this.#outsideSince === null) {
      this.#outsideSince = now;
      return;
    }
    if (now - this.#outsideSince >= OUTSIDE_GRACE_MS) {
      this.answer(null);
    }
  }

  /** Destroy the popup window. Idempotent. */
  #teardown() {
    this.#stopWatching();
    this.#open = false;
    const window = this.#window;
    this.#window = null;
    if (window === null) return;
    try {
      if (!window.isDestroyed()) window.destroy();
    } catch {
      /* ignore */
    }
  }

  /** Dismiss an open popup, if any. */
  close() {
    const settle = this.#settle;
    this.#settle = null;
    this.#teardown();
    if (typeof settle === 'function') {
      try {
        settle(null);
      } catch {
        /* ignore */
      }
    }
  }
}

/** The menu rows, exported so the page and the tests cannot drift apart. */
export const POPUP_ITEMS = ITEMS;

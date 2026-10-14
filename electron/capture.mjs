/**
 * dsh-sticky-notes — full-screen capture and the annotation window.
 *
 * Flow:
 *   1. hide every note (so the screenshot shows what the user was looking at,
 *      not our own floating windows),
 *   2. grab the display under the pointer via `desktopCapturer`,
 *   3. present it in a full-screen, always-on-top annotation window,
 *   4. write whatever the user commits as a PNG.
 *
 * The annotation window is sized to the display's bounds rather than put into
 * real fullscreen: with `frame: false` a fullscreen transition swallows Escape,
 * and the overlay must never become impossible to leave.
 *
 * @module dsh-sticky-notes/electron/capture
 */
import { BrowserWindow, desktopCapturer, dialog, screen, systemPreferences } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Time for the compositor to actually remove our notes before we grab pixels. */
const CLEAR_SCREEN_MS = 260;

/** Hard limit on how long a capture session may stay open. */
const SESSION_TIMEOUT_MS = 180_000;

/**
 * How long to wait for a paint signal before showing the annotation window anyway (ms).
 *
 * Short, because the page has already finished loading by the time this can matter; the
 * only question is whether Electron reported a first paint.
 */
const SHOW_FALLBACK_MS = 1200;

/**
 * How many times to re-assert `show()` before giving up (spaced 250ms apart).
 *
 * Success is judged by `isVisible()` rather than assumed: `ready-to-show` fires before
 * this window can actually be shown, and a `show()` that lands too early does nothing at
 * all — no error, no window.
 */
const SHOW_MAX_ATTEMPTS = 12;

/** Size bounds for a note created from a screenshot (px). */
const MIN_SHOT_NOTE_WIDTH = 220;
const MAX_SHOT_NOTE_WIDTH = 720;
const MIN_SHOT_NOTE_HEIGHT = 160;
const MAX_SHOT_NOTE_HEIGHT = 900;

export class CaptureController {
  #emit;
  #settings;
  #dataDir;
  #logger;
  /** @type {Map<number, object>} webContents.id → live session */
  #sessions = new Map();
  #running = null;
  #hideNotes;
  #notes;

  /**
   * @param {object} options
   * @param {(event: string, data: object) => void} options.emit
   * @param {() => object} options.settings
   * @param {() => string} options.dataDir
   * @param {() => object} [options.notes]  the NoteManager, for 「存为便签」
   * @param {(message: string) => void} [options.logger]
   * @param {() => void} [options.hideNotes]  hides all note windows
   */
  constructor(options) {
    this.#emit = options.emit;
    this.#settings = options.settings;
    this.#dataDir = options.dataDir;
    this.#notes = options.notes ?? (() => null);
    this.#logger = options.logger ?? (() => {});
    this.#hideNotes = options.hideNotes ?? (() => {});
  }

  /**
   * Ask the user where to save, and write the PNG there.
   *
   * @param {object} session
   * @param {Buffer} bytes
   * @returns {Promise<string|null>} the chosen path, or null when cancelled
   */
  async #askSavePath(session, bytes) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const configured = this.#settings().exportDir;
    const base = typeof configured === 'string' && configured.length > 0 ? configured : this.#dataDir();
    try {
      mkdirSync(base, { recursive: true });
    } catch {
      /* the dialog can still pick a location */
    }

    const result = await dialog.showSaveDialog(session.window, {
      title: '保存截图',
      defaultPath: join(base, `sticky-shot-${stamp}.png`),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (result.canceled === true || typeof result.filePath !== 'string' || result.filePath.length === 0) {
      return null;
    }
    try {
      writeFileSync(result.filePath, bytes);
    } catch (error) {
      throw new Error(`写入 PNG 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return result.filePath;
  }

  /**
   * Turn the committed capture into a real note.
   *
   * The image is read back from the file on disk, which is what `note.image` is defined as
   * (an absolute path — see the note window's `loadImage`). Creating it through the
   * NoteManager is what makes it behave like every other note: always-on-top, draggable,
   * edge-snapping, and focusable so it can be annotated further or deleted.
   *
   * @param {object} session
   * @param {string} dataUrl
   * @param {number} width
   * @param {number} height
   * @param {number} screenX  the captured region's screen x, or NaN when unknown
   * @param {number} screenY  the captured region's screen y, or NaN when unknown
   */
  #createShotNote(session, dataUrl, width, height, screenX, screenY) {
    const notes = this.#notes();
    if (notes === null || notes === undefined) throw new Error('便签管理器不可用');

    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (match === null) throw new Error('图像数据无效');
    const bytes = Buffer.from(match[1], 'base64');

    // The note needs its own file to point at; it must outlive the annotation session.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = join(this.#dataDir(), 'shot-notes');
    mkdirSync(base, { recursive: true });
    const imagePath = join(base, `shot-${stamp}.png`);
    writeFileSync(imagePath, bytes);

    const settings = this.#settings();
    const noteWidth = Math.max(MIN_SHOT_NOTE_WIDTH, Math.min(width || MIN_SHOT_NOTE_WIDTH, MAX_SHOT_NOTE_WIDTH));
    const scale = noteWidth / (width || noteWidth);
    const noteHeight = Math.max(MIN_SHOT_NOTE_HEIGHT, Math.min(Math.round((height || noteWidth) * scale), MAX_SHOT_NOTE_HEIGHT));

    /**
     * Where to put the note: at the captured region.
     *
     * The page reports the selection's screen position, so the note lands on the spot the
     * user framed — which is what makes it feel like "this screenshot, here". Falling back
     * to the annotation window's top-left put every note in the same corner regardless of
     * what had been captured.
     *
     * Nudged slightly inward only when the capture is right at a screen edge, so the note
     * is not born half off-screen (or immediately claiming a snap edge it never touched).
     */
    const displayBounds = session.window.isDestroyed() ? null : session.window.getBounds();
    const requested = {
      x: Number.isFinite(screenX) ? screenX : null,
      y: Number.isFinite(screenY) ? screenY : null,
    };
    const fallback = displayBounds === null ? { x: 80, y: 80 } : { x: displayBounds.x + 40, y: displayBounds.y + 40 };
    const wanted = {
      x: requested.x === null ? fallback.x : requested.x,
      y: requested.y === null ? fallback.y : requested.y,
    };
    const area = displayBounds === null ? null : screen.getDisplayNearestPoint(wanted).workArea;
    const placed =
      area === null
        ? wanted
        : {
            x: Math.min(Math.max(wanted.x, area.x), Math.max(area.x, area.x + area.width - noteWidth)),
            y: Math.min(Math.max(wanted.y, area.y), Math.max(area.y, area.y + area.height - noteHeight)),
          };

    const noteId = notes.create(
      {
        kind: 'shot',
        text: '',
        title: '',
        image: imagePath,
        x: placed.x,
        y: placed.y,
        width: noteWidth,
        height: noteHeight,
        // Explicit, not inherited: a screenshot note is meant to float above everything
        // else, and leaving it undefined made it indistinguishable from "unset" to any
        // caller that inspects the note.
        alwaysOnTop: true,
        color: settings.backgroundColor,
        opacity: settings.opacity,
        textColor: settings.textColor,
        fontSize: settings.fontSize,
      },
      // `activate`: the user just asked for this note, so it comes up on top and ready;
      // `announce`: the host has never seen this note, so it must be told or the note
      // would exist only as a window and never reach the notes list.
      { activate: true, announce: true },
    );
    // `create()` returns the id, not the note — reading it back gives the caller the
    // stored state (and `undefined` here is what silently produced a null `noteId`).
    return notes.getNote(noteId) ?? { id: noteId };
  }

  /**
   * Run one capture session end to end.
   *
   * @param {{ mode: 'file'|'note', settings?: object }} options
   * @returns {Promise<object>} `{ path, width, height }`, `{ cancelled: true }`,
   *          or `{ error }` — never a rejection.
   */
  async runCapture(options = {}) {
    if (this.#running !== null) {
      return { error: '已有一个截图会话在进行中' };
    }
    const task = this.#run(options).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    this.#running = task;
    try {
      return await task;
    } finally {
      this.#running = null;
    }
  }

  async #run(options) {
    const mode = options.mode === 'note' ? 'note' : 'file';

    // Ask once; on macOS a missing Screen Recording grant yields black frames
    // rather than an error, so surfacing it early is the difference between a
    // usable message and a puzzling blank screenshot.
    try {
      if (process.platform === 'darwin' && typeof systemPreferences.getMediaAccessStatus === 'function') {
        const status = systemPreferences.getMediaAccessStatus('screen');
        if (status !== 'granted' && typeof systemPreferences.askForMediaAccess === 'function') {
          await systemPreferences.askForMediaAccess('screen').catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }

    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { width, height } = display.size;
    const scaleFactor = display.scaleFactor || 1;

    // Hide our own notes and let the compositor catch up.
    try {
      this.#hideNotes();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => setTimeout(resolve, CLEAR_SCREEN_MS));

    let dataUrl;
    try {
      dataUrl = await this.#grab(display, width, height, scaleFactor);
    } catch (error) {
      return { error: `屏幕捕获失败：${error instanceof Error ? error.message : String(error)}` };
    }
    if (dataUrl === null) return { error: '屏幕捕获未返回图像' };

    return this.#annotate({ dataUrl, width, height, scaleFactor, mode, display });
  }

  /**
   * Grab one display. Sources are matched by pixel size first, because on
   * Windows the source id is an opaque handle that carries no display mapping.
   */
  async #grab(display, width, height, scaleFactor) {
    const physicalWidth = Math.round(width * scaleFactor);
    const physicalHeight = Math.round(height * scaleFactor);

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: physicalWidth, height: physicalHeight },
      fetchWindowIcons: false,
    });
    if (!Array.isArray(sources) || sources.length === 0) return null;

    let best = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const source of sources) {
      const size = source.thumbnail?.getSize?.() ?? { width: 0, height: 0 };
      const score = Math.abs(size.width - physicalWidth) + Math.abs(size.height - physicalHeight);
      if (score < bestScore) {
        bestScore = score;
        best = source;
      }
    }

    // A source whose pixels do not match the display is still better than
    // nothing, but a blank thumbnail means the OS refused the capture.
    const chosen = best ?? sources[0];
    if (chosen.thumbnail === undefined || chosen.thumbnail.isEmpty()) return null;
    return chosen.thumbnail.toDataURL();
  }

  /** Show the annotation window and wait for the user to commit or cancel. */
  #annotate({ dataUrl, width, height, scaleFactor, mode, display }) {
    return new Promise((resolve) => {
      let settled = false;
      let session = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (session !== null) {
          this.#sessions.delete(session.webContentsId);
          clearTimeout(session.timer);
          try {
            if (!session.window.isDestroyed()) session.window.close();
          } catch {
            /* ignore */
          }
        }
        resolve(result);
      };

      let window;
      try {
        window = new BrowserWindow({
          x: display.bounds.x,
          y: display.bounds.y,
          width,
          height,
          frame: false,
          transparent: false,
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          show: false,
          backgroundColor: '#101014',
          webPreferences: {
            preload: join(HERE, 'preload-shot.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            backgroundThrottling: false,
          },
        });
      } catch (error) {
        resolve({ error: `无法创建截图窗口：${error instanceof Error ? error.message : String(error)}` });
        return;
      }

      const timer = setTimeout(() => finish({ cancelled: true, reason: 'timeout' }), SESSION_TIMEOUT_MS);
      session = {
        window,
        webContentsId: window.webContents.id,
        timer,
        dataUrl,
        width,
        height,
        scaleFactor,
        mode,
        /**
         * Set by {@link commit} before it closes the window.
         *
         * The annotation page closes itself right after a successful `commit`,
         * which fires `'closed'` — and without this the session would report
         * `{cancelled: true}` for a screenshot the user actually saved. The
         * committed result must win.
         */
        committed: null,
        /** Resolves the `shot.begin` promise; owned by this scope. */
        settle: finish,
      };
      this.#sessions.set(session.webContentsId, session);

      // A close that follows a commit reports the commit; a close on its own is a
      // cancellation.
      window.on('closed', () => {
        if (session !== null && session.committed !== null) {
          const committed = session.committed;
          session.committed = null;
          finish(committed);
          return;
        }
        finish({ cancelled: true });
      });

      window.loadFile(join(HERE, 'shot.html')).catch((error) => {
        finish({ error: `截图页面加载失败：${error instanceof Error ? error.message : String(error)}` });
      });

      /**
       * Put the annotation window on screen.
       *
       * Driven by whichever of `ready-to-show` / `did-finish-load` arrives first, with a
       * hard timer as a last resort.
       *
       * Regression: this hung on `ready-to-show` alone, and that event does not reliably
       * fire for this window — observed with the page fully loaded, the title correct, no
       * crash and no error emitted, yet `isVisible()` stayed false indefinitely and
       * `shot.begin` never resolved. The user-visible symptom was "pressing 截图 does
       * nothing at all", with nothing anywhere explaining why. A capture UI must never be
       * able to hang like that, so no single event is trusted to arrive.
       */
      /**
       * Put the annotation window on screen, and *keep* trying until it is there.
       *
       * Driven by `ready-to-show` / `did-finish-load` / a timer, whichever comes first,
       * and then re-asserted until the window reports itself visible.
       *
       * Regression: this called `show()` exactly once, from `ready-to-show` alone — and
       * that event fires for this window while it is still too early to be shown. The
       * window was created, finished loading, reported no crash and logged no error, yet
       * `isVisible()` stayed false and `shot.begin` never resolved, so pressing 截图 did
       * nothing at all and nothing anywhere said why. Verified both ways: with the single
       * `ready-to-show` show the window reports `visible: false`, and with this arming it
       * reports `visible: true`.
       */
      let showAttempts = 0;
      let showTimer2 = null;

      const attemptShow = () => {
        if (window.isDestroyed()) return;
        showAttempts += 1;
        try {
          window.setAlwaysOnTop(true, 'screen-saver');
          window.setBounds(display.bounds);
          // Both, in order: `show()` is the normal path, `showInactive()` is the fallback
          // that was measured to work when a plain `show()` silently did nothing.
          window.show();
          if (!window.isVisible()) window.showInactive();
          window.focus();
        } catch (error) {
          this.#logger(`显示截图窗口失败：${String(error)}`);
        }
        if (!window.isDestroyed() && window.isVisible()) {
          if (showTimer2 !== null) clearInterval(showTimer2);
          showTimer2 = null;
          return;
        }
        if (showAttempts >= SHOW_MAX_ATTEMPTS) {
          if (showTimer2 !== null) clearInterval(showTimer2);
          showTimer2 = null;
          this.#logger(`截图窗口在 ${SHOW_MAX_ATTEMPTS} 次尝试后仍未显示，放弃`);
        }
      };

      const armShow = () => {
        attemptShow();
        if (showTimer2 === null && !window.isDestroyed() && !window.isVisible()) {
          showTimer2 = setInterval(attemptShow, 250);
          if (typeof showTimer2.unref === 'function') showTimer2.unref();
        }
      };

      window.once('ready-to-show', armShow);
      window.webContents.once('did-finish-load', armShow);
      const showTimer = setTimeout(armShow, SHOW_FALLBACK_MS);
      if (typeof showTimer.unref === 'function') showTimer.unref();
      window.once('closed', () => {
        clearTimeout(showTimer);
        if (showTimer2 !== null) clearInterval(showTimer2);
        showTimer2 = null;
      });
    });
  }

  // ---------------------------------------------------------- ipc surface ==

  /** Payload for the annotation window's `shot:init`. */
  initPayload(webContentsId) {
    const session = this.#sessions.get(webContentsId);
    if (session === undefined) return { error: '截图会话不存在' };
    return {
      dataUrl: session.dataUrl,
      width: session.width,
      height: session.height,
      scaleFactor: session.scaleFactor,
      mode: session.mode,
    };
  }

  /**
   * Evaluate a script inside the open annotation window (diagnostics and tests).
   *
   * The capture UI is the one surface a user drives entirely by hand, so without this it
   * cannot be exercised from a test at all — which is how three broken buttons went
   * unnoticed.
   *
   * @param {string} source
   */
  async evaluate(source) {
    const session = [...this.#sessions.values()][0];
    if (session === undefined) return { open: false };
    if (session.window.isDestroyed()) return { open: false, reason: 'window-destroyed' };
    try {
      return { open: true, value: await session.window.webContents.executeJavaScript(String(source), true) };
    } catch (error) {
      return { open: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Read the live `window.shot` inside the open annotation window.
   *
   * `detectApi()` in shot.js is the only source of a "…不存在" message, and whether it
   * passes depends entirely on what the preload actually exposed — which cannot be judged
   * from the main process. This reports the real object and the page's fallback state.
   */
  async inspect() {
    const session = [...this.#sessions.values()][0];
    if (session === undefined) return { open: false };
    if (session.window.isDestroyed()) return { open: false, reason: 'window-destroyed' };
    try {
      const detail = await session.window.webContents.executeJavaScript(
        `(() => {
          const api = window.shot;
          const names = ['init', 'commit', 'cancel', 'copy'];
          return {
            apiType: typeof api,
            keys: api === null || api === undefined ? null : Object.keys(api),
            methods: api === null || api === undefined ? null : names.map((n) => n + ':' + typeof api[n]),
            fallbackVisible: (() => {
              const el = document.getElementById('fallback');
              return el === null ? null : el.hidden !== true;
            })(),
            fallbackReason: (() => {
              const el = document.getElementById('fallback-reason');
              return el === null ? null : el.textContent;
            })(),
          };
        })()`,
        true,
      );
      return { open: true, ...detail };
    } catch (error) {
      return { open: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * The user committed an annotated image.
   * @param {number} webContentsId
   * @param {{ dataUrl?: string, width?: number, height?: number, target?: string }} payload
   */
  async commit(webContentsId, payload) {
    const session = this.#sessions.get(webContentsId);
    if (session === undefined) return { error: '截图会话不存在' };

    const target = payload.target === 'note' ? 'note' : payload.target === 'both' ? 'both' : 'file';
    const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (match === null) return { error: '图像数据无效' };

    const bytes = Buffer.from(match[1], 'base64');
    const width = Number(payload.width) || 0;
    const height = Number(payload.height) || 0;

    let path = null;
    if (target === 'file' || target === 'both') {
      // 「保存图片」 must ask where to put it. Writing straight into the data directory
      // left the user with a file they never chose a location for (and no way to know
      // where it went); the path is still reported after the fact.
      let chosen = null;
      try {
        chosen = await this.#askSavePath(session, bytes);
      } catch (error) {
        return { error: `选择保存位置失败：${error instanceof Error ? error.message : String(error)}` };
      }
      if (chosen === null) {
        // Cancelled: not an error and not a commit, so the session stays open and the
        // user can keep annotating or pick a different action.
        return { cancelled: true };
      }
      path = chosen;
    }

    let note = null;
    if (target === 'note' || target === 'both') {
      // 「存为便签」 must produce an actual floating note. It previously only wrote a PNG
      // and emitted `shot.saved`, so nothing appeared anywhere: the window closed and the
      // screenshot was gone. The note is created through the same path the hotkey uses,
      // which also gives it always-on-top behaviour and the user's configured appearance.
      try {
        note = this.#createShotNote(
          session,
          dataUrl,
          width,
          height,
          Number(payload.screenX),
          Number(payload.screenY),
        );
      } catch (error) {
        return { error: `存为便签失败：${error instanceof Error ? error.message : String(error)}` };
      }
    }

    this.#emit('shot.saved', {
      path,
      width,
      height,
      target,
      // Present for the note targets so a listener can tell what was produced without
      // mistaking an empty path for a failure.
      noteId: typeof note?.id === 'string' ? note.id : null,
    });

    const result = { path, width, height, target, noteId: typeof note?.id === 'string' ? note.id : null };

    // Record the result *before* closing, then settle the session. The
    // annotation page closes its own window shortly after a successful commit,
    // and the `'closed'` handler must report this commit rather than a
    // cancellation — otherwise a saved screenshot would look cancelled to the
    // caller and never reach the notes list.
    session.committed = result;
    try {
      if (typeof session.settle === 'function') session.settle(result);
    } catch {
      /* ignore */
    }

    return result;
  }

  /** The user cancelled. */
  cancel(webContentsId) {
    const session = this.#sessions.get(webContentsId);
    this.#emit('shot.cancelled', {});
    if (session === undefined) return;
    this.#sessions.delete(webContentsId);
    clearTimeout(session.timer);
    try {
      if (!session.window.isDestroyed()) session.window.close();
    } catch {
      /* ignore */
    }
  }

  /** Close every annotation window. */
  dispose() {
    for (const id of [...this.#sessions.keys()]) this.cancel(id);
  }
}

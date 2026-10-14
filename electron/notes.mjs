/**
 * dsh-sticky-notes — always-on-top note windows, with edge snapping and
 * hover-to-reveal auto-hide.
 *
 * One `BrowserWindow` per note. Notes are `frame: false` + `transparent: true`
 * so they read as paper rather than as another app window.
 *
 * Position tracking: rather than trusting the renderer's pointer maths, the
 * manager watches each window's real bounds. `move`/`resize` fire continuously,
 * so a short settle timer marks the end of a drag, and only then do we snap,
 * persist, and schedule the auto-hide. That keeps a drag from being interrupted
 * halfway by the note deciding it belongs against the edge.
 *
 * Hover reveal: there is no "global pointer" event in Electron, so a single
 * interval polls `screen.getCursorScreenPoint()` while at least one note is
 * hidden. A hidden note is a click-through sliver
 * (`setIgnoreMouseEvents(true)`) pinned to the edge, so the pointer can reach
 * the edge without the sliver swallowing the click.
 *
 * @module dsh-sticky-notes/electron/notes
 */
import { BrowserWindow, screen } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  displayFor,
  hiddenBounds,
  snapToEdge,
  clampX,
  clampY,
  constrainSize,
  revealZone,
  pointInRect,
  placeNear,
  revealedBounds,
  HIDE_MODE_OFFSCREEN,
  HIDE_MODE_TAB,
  MIN_NOTE_WIDTH,
  MIN_NOTE_HEIGHT,
} from '../lib/host/geometry.js';

/** Directory holding the helper's own HTML/CSS/preload assets. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** How often to poll the pointer while something is hidden (ms). */
const POINTER_POLL_MS = 90;

/** Fallback auto-hide delay when the setting is missing or unusable (ms). */
const DEFAULT_AUTO_HIDE_MS = 250;

/**
 * How long after the last typed edit a note still counts as "being worked in" (ms).
 *
 * Only *typing* feeds this. A drag must NOT: the renderer sends a bounds update every
 * animation frame while dragging, so counting those as activity kept a note "engaged"
 * for the whole window below and it refused to hide — which is exactly what the user saw
 * after dragging a note to the edge (while a note reopened from the list, never dragged,
 * hid correctly).
 *
 * Comfortably longer than the auto-hide delay, so pausing mid-sentence does not make the
 * note slide away, and short enough that a note the user has moved on from hides itself.
 */
const TYPING_ACTIVE_MS = 2500;

/** Idle time after a move/resize before we treat the gesture as finished. */
const GESTURE_SETTLE_MS = 220;

/** Minimum gap between two persisted position events for one note (ms). */
const POSITION_EMIT_MS = 250;

export class NoteManager {
  #settings;
  #emit;
  #logger;
  /** @type {Map<string, object>} live note windows and their state */
  #notes = new Map();
  #pollTimer = null;

  /**
   * @param {object} options
   * @param {object} options.settings
   * @param {(event: string, data: object) => void} options.emit
   * @param {(message: string) => void} [options.logger]
   */
  constructor(options) {
    this.#settings = options.settings;
    this.#emit = options.emit;
    this.#logger = options.logger ?? (() => {});
  }

  /**
   * The configured hide mode, normalised.
   *
   * Read live rather than cached so a settings change takes effect on the next
   * hide without recreating any window.
   *
   * @returns {'offscreen'|'tab'}
   */
  #hideMode() {
    return this.#settings.hideMode === HIDE_MODE_TAB ? HIDE_MODE_TAB : HIDE_MODE_OFFSCREEN;
  }

  // ------------------------------------------------------------ public api ==

  /** Ids of currently open note windows. */
  listIds() {
    return [...this.#notes.keys()];
  }

  /** The renderer's `webContents.id` → note id, for IPC routing. */
  idForWebContents(webContentsId) {
    for (const [id, entry] of this.#notes) {
      if (!entry.window.isDestroyed() && entry.window.webContents.id === webContentsId) return id;
    }
    return null;
  }

  /** One note's current state, or null. */
  getNote(id) {
    const entry = this.#notes.get(id);
    return entry === undefined ? null : { ...entry.note };
  }

  /**
   * The live window for a note, for diagnostics. `null` when there is none.
   * @param {string} id
   */
  windowFor(id) {
    const state = this.#notes.get(id);
    if (state === undefined || state.window === null || state.window.isDestroyed()) return null;
    return state.window;
  }

  /**
   * Explain what `#commitGesture` would decide right now, for diagnostics.
   *
   * Recomputes the same snap decision without side effects, so "why does this note never
   * snap" can be answered instead of inferred.
   *
   * @param {string} id
   */
  explainGesture(id) {
    const state = this.#notes.get(id);
    if (state === undefined) return { reason: 'no-such-note' };
    if (state.window === null || state.window.isDestroyed()) return { reason: 'window-gone' };
    if (state.note.hidden) return { reason: 'already-hidden' };
    let bounds;
    try {
      bounds = state.window.getBounds();
    } catch (error) {
      return { reason: 'getBounds-failed', error: String(error) };
    }
    const displays = screen.getAllDisplays();
    const workArea = displayFor(displays, bounds).workArea;
    const snapDistance = this.#settings.snapDistance;
    const snapped = snapToEdge(bounds, workArea, snapDistance);
    return {
      reason: state.note.pinned === true ? 'pinned' : 'computed',
      bounds,
      workArea,
      snapDistance,
      snappedEdge: snapped.edge,
      distance: snapped.distance,
      settling: state.settling !== null,
      internal: state.internal,
      moveTicks: state.moveTicks ?? 0,
      moveTicksIgnored: state.moveTicksIgnored ?? 0,
    };
  }

  /** Live gesture flags for a note, for diagnostics. */
  gestureOf(id) {
    const state = this.#notes.get(id);
    return state === undefined ? null : { ...state.gesture };
  }

  /** Whether a note currently counts as being typed in, for diagnostics. */
  isTyping(id) {
    const state = this.#notes.get(id);
    return state === undefined ? null : this.#userEngaged(state);
  }

  /** Whether a note is still a draft (not yet in the host store). */
  isUnsaved(id) {
    return this.#notes.get(id)?.unsaved === true;
  }

  /**
   * Give up keyboard focus for a note.
   *
   * A focused note is deliberately never auto-hidden (`#scheduleAutoHide`), because
   * hiding the window the user is typing in would be hostile. Anything that wants the
   * note to go back to normal edge behaviour has to say that the user is done with it —
   * this is that statement.
   *
   * @param {string} id
   */
  blur(id) {
    const state = this.#notes.get(id);
    if (state === undefined || state.window.isDestroyed()) return { ok: false };
    const attempt = () => {
      if (state.window.isDestroyed()) return;
      try {
        if (state.window.isFocused()) state.window.blur();
      } catch {
        /* ignore */
      }
    };
    // Retried for the same reason the focus grab is, and it cancels a pending focus so
    // the two cannot fight — see `#scheduleFocusAction`.
    this.#scheduleFocusAction(state, attempt, () => {});
    // Re-arm the auto-hide: the note only skips it while the user is working in it.
    if (state.note.edge !== null && state.note.pinned !== true && state.note.hidden !== true) {
      this.#scheduleAutoHide(state);
    }
    return { ok: true };
  }

  /**
   * A note's real window bounds, or null when the window is gone.
   *
   * The note's recorded `x/y/width/height` are the *restored* geometry, which is
   * deliberately not the tab's geometry while hidden — so anything that needs to
   * know where the window physically is must ask here.
   */
  boundsOf(id) {
    const entry = this.#notes.get(id);
    if (entry === undefined || entry.window.isDestroyed()) return null;
    try {
      return entry.window.getBounds();
    } catch {
      return null;
    }
  }

  /**
   * Create a text note near a point and return its state.
   *
   * This is the hotkey path — press the accelerator, pick "新建便签", get a note
   * under the pointer — so it must apply the user's saved appearance rather than
   * hard-coded defaults, and it must place the note fully on screen even when the
   * pointer sits in a corner.
   *
   * @param {{x:number, y:number}} point  pointer position, screen coordinates
   * @returns {object} the created note
   */
  createTextNote(point) {
    const anchor = { x: Number(point?.x) || 0, y: Number(point?.y) || 0 };
    const displays = screen.getAllDisplays();
    const workArea = displayFor(displays, { x: anchor.x, y: anchor.y, width: 260, height: 200 }).workArea;
    const size = constrainSize(260, 200);
    const spot = placeNear(anchor, size.width, size.height, workArea);

    const note = {
      id: `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: 'text',
      text: '',
      title: '',
      x: spot.x,
      y: spot.y,
      width: size.width,
      height: size.height,
      color: this.#settings.backgroundColor,
      opacity: this.#settings.opacity,
      textColor: this.#settings.textColor,
      fontSize: this.#settings.fontSize,
    };

    this.create(note, { activate: true, draft: true });
    return this.getNote(note.id) ?? note;
  }

  /**
   * File a draft: tell the host this note now exists.
   *
   * A note created by the hotkey lives only in the helper until the user presses
   * 「保存」. That is deliberate — a draft the user abandons must leave nothing behind —
   * but it means the host has never seen the id, so every later patch (including the
   * save's own `note.updated`) would be dropped and the note would never reach the
   * sidebar list. This is where that announcement happens, exactly once.
   *
   * Idempotent: calling it again on an already-filed note does nothing.
   *
   * @param {string} id
   * @returns {{ok: boolean, created?: boolean}}
   */
  commitDraft(id) {
    const state = this.#notes.get(id);
    if (state === undefined) return { ok: false };
    if (state.unsaved !== true) return { ok: true, created: false };
    state.unsaved = false;
    this.#emit('note.created', { note: { ...state.note } });
    this.#sendState(state);
    return { ok: true, created: true };
  }

  /**
   * Create (or revive) a note window. Returns the note id.
   *
   * @param {object} note
   * @param {{activate?: boolean, announce?: boolean}} [options] `announce` tells the
   *        host about a note it does not know yet (see below). It defaults to
   *        `activate`, because a note the user just asked for is exactly the case the
   *        host cannot know about — except when restoring, which passes both `false`.
   */
  create(note, options = {}) {
    const id = String(note?.id ?? `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    const existing = this.#notes.get(id);
    if (existing !== undefined) {
      // Already open: surface it instead of stacking a second window.
      this.focus(id);
      return id;
    }

    /**
     * Whether this window may take keyboard focus.
     *
     * `true` only for a note the user just asked for (hotkey, panel button): they are
     * about to type into it, so it must be able to receive keystrokes and should come
     * up ready to edit. Notes restored from storage on startup pass `false`, so a
     * restart does not yank focus out of whatever the user was doing.
     */
    const activate = options.activate === true;

    /**
     * Whether this note is still a draft, i.e. not yet in the host store.
     *
     * A hotkey-created note is a draft by default: it is deliberately not stored until
     * the user presses 「保存」, so abandoning it leaves nothing behind. It is marked so
     * the window can say so, and so `commitDraft` knows the announcement is still owed.
     */
    const draft = options.draft === true;

    /**
     * Whether to tell the host "this note now exists".
     *
     * Regression: the hotkey builds its note *here*, in the helper, so the host store
     * had never seen the id, and every later patch — including 「保存」 — was dropped.
     * The note has to be announced eventually.
     *
     * "Eventually" is the whole point: a **draft must not be announced on creation**.
     * The default used to be `activate`, which was wrong precisely for the hotkey case —
     * it announced the note the moment it appeared, so a draft showed up in the note list
     * before the user had saved anything, defeating the draft rule. Announcement is now
     * driven by `draft` instead: a draft is announced by `commitDraft` when 「保存」 is
     * pressed, and a note that arrives already persisted (the panel path, which the host
     * created itself) is announced right away.
     */
    const announce = options.announce === undefined ? !draft : options.announce === true;

    const displays = screen.getAllDisplays();
    const workArea = displayFor(displays, {
      x: Number(note.x) || 0,
      y: Number(note.y) || 0,
      width: Number(note.width) || 260,
      height: Number(note.height) || 200,
    }).workArea;

    const size = constrainSize(note.width ?? 260, note.height ?? 200);
    const wantsHidden = note.hidden === true && (note.edge === 'left' || note.edge === 'right' || note.edge === 'top' || note.edge === 'bottom');

    // A hidden note must start already hidden: creating it at full size and then
    // hiding would flash a full window at the user on every restart.
    const initial = wantsHidden
      ? hiddenBounds(
          { x: note.x, y: note.y, width: size.width, height: size.height, edge: note.edge },
          workArea,
          this.#hideMode(),
        )
      : {
          x: clampX(Number(note.x) || 0, size.width, workArea),
          y: clampY(Number(note.y) || 0, size.height, workArea),
          width: size.width,
          height: size.height,
        };

    const state = {
      id,
      note: {
        ...note,
        id,
        x: Number(note.x) || 0,
        y: Number(note.y) || 0,
        width: size.width,
        height: size.height,
        hidden: wantsHidden,
        // Defaulted here, not left to the caller's payload: the note manager reads
        // this flag on every gesture and every pointer poll, so it must always be a
        // real boolean rather than `undefined`.
        pinned: note.pinned === true,
        edge: wantsHidden ? note.edge : null,
      },
      /** Bounds the note returns to when revealed. */
      home: { x: Number(note.x) || 0, y: Number(note.y) || 0, width: size.width, height: size.height },
      window: null,
      settling: null,
      hideTimer: null,
      revealTimer: null,
      gesture: { dragging: false, resizing: false },
      lastEmitAt: 0,
      /** Set while we are moving the window ourselves, to ignore self-induced moves. */
      internal: false,
      /** True while this note is not yet in the host store (see `commitDraft`). */
      unsaved: draft,
      /**
       * Pending deferred focus/blur attempts.
       *
       * Focus and blur are both retried on a short timer because a window that has just
       * been asked to show is not focusable yet. The two must be able to cancel each
       * other: the panel's 「打开」 focuses a note that `create` had scheduled to blur, and
       * with both timers live the blur landed *after* the focus, so the note ended up
       * unfocused holding no caret — and the auto-hide suppression it relies on was gone.
       */
      focusTimers: [],
      /**
       * When the user last *typed* in this note (ms epoch).
       *
       * The auto-hide must not fire while the user is writing, but window focus is the wrong
       * signal for that: `show()` gives a freshly mapped always-on-top window focus on
       * Windows, so a note that was merely *displayed* looked "engaged" and never hid again.
       * Only typing counts here — drags are covered by the gesture flags, and counting them
       * kept a note from hiding after being dragged to an edge.
       */
      typingAt: 0,
    };

    let window;
    try {
      window = new BrowserWindow({
        x: initial.x,
        y: initial.y,
        width: initial.width,
        height: initial.height,
        minWidth: MIN_NOTE_WIDTH,
        minHeight: MIN_NOTE_HEIGHT,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: wantsHidden ? false : true,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: note.alwaysOnTop !== false,
        // Focusable, because a note is something the user types into.
        //
        // Regression: this was `focusable: false` to stop notes from stealing focus
        // from the user's editor. That is the right instinct for a note *restored* on
        // startup, but it also made typing impossible — a non-focusable window cannot
        // receive keyboard focus at all, so pressing the hotkey, creating a note and
        // clicking into it still left both the title and the body inert. Focus is now
        // controlled per case by `activate` (see `create`), which is what the original
        // intent actually needed.
        focusable: true,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: {
          preload: join(HERE, 'preload-note.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
    } catch (error) {
      this.#logger(`创建便签窗口失败：${String(error)}`);
      return id;
    }

    state.window = window;
    this.#notes.set(id, state);
    this.#attachWindowHandlers(state);

    // Announced as soon as the note exists, so the host can list it and so any later
    // patch (a save, a move) has a note to land on. Sending it here rather than in
    // `ready-to-show` matters: the host must know about the note even if the window
    // fails to appear.
    if (announce) this.#emit('note.created', { note: { ...state.note } });

    window.loadFile(join(HERE, 'note.html')).catch((error) => {
      this.#logger(`便签页面加载失败：${String(error)}`);
    });

    window.once('ready-to-show', () => {
      try {
        if (state.note.hidden) {
          this.#applyHidden(state, true);
        } else {
          // A brand-new note never moves, so no `move` event will ever fire and
          // `#commitGesture` would not run — leaving a note created against a
          // screen edge unsnapped and never auto-hiding. Settle it once, here, so
          // creation and drag-then-release follow exactly the same path.
          // Deferred one tick because `getBounds()` can still report the
          // pre-layout rectangle inside `ready-to-show`.
          setTimeout(() => {
            if (!state.window.isDestroyed()) this.#commitGesture(state);
          }, 120);
        }
        window.showInactive();
        if (state.note.alwaysOnTop !== false) window.setAlwaysOnTop(true, 'floating');
        this.#startPointerPolling();
        if (activate) {
          // Deferred, and attempted twice: `focus()` immediately after `showInactive()`
          // races the window actually being mapped, and a focus call that loses that
          // race is silently dropped — which is indistinguishable from the "cannot type"
          // bug this is here to fix. `focus()` on an already-focused window is a no-op,
          // so retrying is safe.
          const grabFocus = () => {
            if (state.window.isDestroyed()) return;
            try {
              state.window.focus();
              state.window.webContents.focus();
            } catch {
              /* ignore */
            }
          };
          this.#scheduleFocusAction(state, grabFocus, () => {});
        } else {
          /**
           * Hand focus back if the window took it anyway.
           *
           * `showInactive()` is a request, not a guarantee — on Windows a newly mapped
           * always-on-top window can still end up focused. That mattered twice over: it
           * pulled focus out of whatever the user was doing on every restore, and it
           * silently disabled the auto-hide, because a note the user is working in is
           * deliberately never hidden (see `#scheduleAutoHide`).
           */
          const releaseFocus = () => {
            if (state.window.isDestroyed()) return;
            try {
              if (state.window.isFocused()) state.window.blur();
            } catch {
              /* ignore */
            }
          };
          this.#scheduleFocusAction(state, releaseFocus, () => {});
        }
      } catch (error) {
        this.#logger(`显示便签失败：${String(error)}`);
      }
    });

    window.on('closed', () => {
      this.#clearTimers(state);
      this.#notes.delete(id);
      this.#stopPointerPollingIfIdle();
    });

    return id;
  }

  /**
   * Make the live windows match `wanted` exactly.
   *
   * Called on helper startup so a DSH restart restores every note — including
   * notes that were snapped and hidden — straight into the state they were left
   * in, without the user having to reopen them.
   *
   * @param {object[]} wanted
   * @param {object} settings
   */
  reconcile(wanted, settings) {
    this.applySettings(settings);
    const desired = new Map();
    for (const note of wanted) {
      if (note !== null && typeof note === 'object' && typeof note.id === 'string') desired.set(note.id, note);
    }

    // Drop windows whose note no longer exists (deleted while we were down).
    for (const id of [...this.#notes.keys()]) {
      if (!desired.has(id)) this.closeWindow(id);
    }

    for (const [id, note] of desired) {
      const entry = this.#notes.get(id);
      if (entry === undefined) {
        // `activate: false`: restoring notes must not pull focus away from whatever
        // the user is doing. They are still focusable, so clicking one and typing
        // works — only the automatic focus grab is suppressed.
        // `announce: false`: these notes came *from* the host, so telling it about
        // them would be a pointless round trip and could resurrect one it just deleted.
        this.create(note, { activate: false, announce: false });
        continue;
      }
      // Existing window: refresh content and re-apply position/hidden state.
      this.applyPatch(id, note, { silent: true });
    }
    this.#startPointerPolling();
  }

  /** Push new settings into every live note (appearance + timing). */
  applySettings(settings) {
    this.#settings = { ...this.#settings, ...settings };
    for (const state of this.#notes.values()) {
      try {
        if (!state.window.isDestroyed() && state.note.alwaysOnTop !== false) {
          state.window.setAlwaysOnTop(true, 'floating');
        }
      } catch {
        /* ignore */
      }
      this.#sendState(state);
    }
  }

  /**
   * Apply a patch coming from outside (host/store) to a live window.
   * @param {string} id
   * @param {object} patch
   * @param {{ silent?: boolean }} [options]
   */
  applyPatch(id, patch, options = {}) {
    const state = this.#notes.get(id);
    if (state === undefined) return;
    const next = { ...state.note };

    for (const key of ['title', 'text', 'kind', 'image', 'color', 'opacity', 'textColor', 'fontSize', 'alwaysOnTop']) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }

    const sizeChanged = patch.width !== undefined || patch.height !== undefined;
    if (sizeChanged) {
      const size = constrainSize(patch.width ?? next.width, patch.height ?? next.height);
      next.width = size.width;
      next.height = size.height;
    }

    const positionChanged = patch.x !== undefined || patch.y !== undefined;
    if (positionChanged) {
      next.x = Number(patch.x) || next.x;
      next.y = Number(patch.y) || next.y;
    }

    const hiddenChanged = patch.hidden !== undefined && patch.hidden !== next.hidden;

    state.note = next;
    state.home = { x: next.x, y: next.y, width: next.width, height: next.height };

    if (!state.window.isDestroyed()) {
      try {
        if (sizeChanged && !next.hidden) {
          this.#internal(state, () => state.window.setBounds({ width: next.width, height: next.height }));
        }
        if (positionChanged && !next.hidden) {
          this.#internal(state, () => state.window.setBounds({ x: next.x, y: next.y }));
        }
        if (hiddenChanged) this.#applyHidden(state, next.hidden);
        if (patch.alwaysOnTop !== undefined) {
          state.window.setAlwaysOnTop(next.alwaysOnTop !== false, 'floating');
        }
      } catch (error) {
        this.#logger(`应用便签更新失败：${String(error)}`);
      }
    }

    if (options.silent !== true) this.#sendState(state);
  }

  /** Patch from the note window itself, emitting a store event. */
  patchFromRenderer(id, patch) {
    const state = this.#notes.get(id);
    if (state === undefined) return { ok: false };

    // Typing in the note postpones its auto-hide. See TYPING_ACTIVE_MS.
    this.#touchTyping(state);

    const next = { ...state.note };
    if (typeof patch.text === 'string') next.text = patch.text;
    if (typeof patch.title === 'string') next.title = patch.title;
    if (typeof patch.color === 'string') next.color = patch.color;
    if (patch.opacity !== undefined) next.opacity = Math.min(1, Math.max(0.2, Number(patch.opacity) || 1));
    if (patch.fontSize !== undefined) next.fontSize = Number(patch.fontSize) || next.fontSize;
    state.note = next;

    this.#emit('note.updated', { id, patch: { text: next.text, title: next.title, color: next.color, opacity: next.opacity, fontSize: next.fontSize } });
    this.#sendState(state);
    return { ok: true };
  }

  /** Live bounds from a renderer drag. */
  setBoundsFromRenderer(id, bounds) {
    const state = this.#notes.get(id);
    if (state === undefined || state.window.isDestroyed()) return { ok: false };
    const displays = screen.getAllDisplays();
    const workArea = displayFor(displays, state.note).workArea;

    const x = clampX(Number(bounds.x) || 0, state.note.width, workArea);
    const y = clampY(Number(bounds.y) || 0, state.note.height, workArea);

    // Deliberately NOT run through `#internal`.
    //
    // This is the renderer's own drag path, and `#internal` exists to ignore bounds
    // changes *we* made — the ones that must not feed back into gesture bookkeeping. It
    // suppresses move events for 60ms, and the renderer reports its position every
    // animation frame, so routing this through it meant **every** move of a drag was
    // discarded: `#commitGesture` never ran, the note never acquired an edge, and a note
    // dragged to the screen edge simply sat there instead of snapping and hiding. Notes
    // saved and reopened only *appeared* to work because reconciling their position
    // commits a gesture once via a different route.
    //
    // Letting the move events through is what makes a drag end in a committed gesture.
    state.window.setBounds({ x, y });
    state.note.x = x;
    state.note.y = y;
    state.home.x = x;
    state.home.y = y;
    return { ok: true };
  }

  /** Live size from a renderer resize. */
  setSizeFromRenderer(id, size) {
    const state = this.#notes.get(id);
    if (state === undefined || state.window.isDestroyed()) return { ok: false };
    const next = constrainSize(Number(size.width) || state.note.width, Number(size.height) || state.note.height);
    // Not routed through `#internal`, for the same reason as `setBoundsFromRenderer`: a
    // resize must be able to settle into a committed gesture, and `#internal` would
    // discard every frame of it.
    state.window.setBounds({ width: next.width, height: next.height });
    state.note.width = next.width;
    state.note.height = next.height;
    state.home.width = next.width;
    state.home.height = next.height;
    return { ok: true };
  }

  /** The renderer reports drag/resize start and end. */
  setInteractionState(id, payload) {
    const state = this.#notes.get(id);
    if (state === undefined) return { ok: false };
    state.gesture = { dragging: payload.dragging === true, resizing: payload.resizing === true };
    if (state.gesture.dragging || state.gesture.resizing) {
      this.#clearTimers(state);
      // A note being handled must be fully visible and interactive.
      if (state.note.hidden) this.#applyHidden(state, false);
    } else {
      this.#scheduleSettle(state);
    }
    return { ok: true };
  }

  /** Force hidden/shown. */
  setHidden(id, hidden, edge) {
    const state = this.#notes.get(id);
    if (state === undefined) return { ok: false };
    if (typeof edge === 'string' && edge.length > 0) state.note.edge = edge;
    this.#applyHidden(state, hidden === true);
    return { ok: true, hidden: state.note.hidden };
  }

  /** Bring a note back on screen and to the front. */
  focus(id) {
    const state = this.#notes.get(id);
    if (state === undefined || state.window.isDestroyed()) return;
    this.#applyHidden(state, false);
    try {
      // Never touch `skipTaskbar` here: a note is a desktop ornament, and
      // showing it in the taskbar would be a visible, wrong side effect of
      // merely clicking "打开" in the sidebar.
      if (state.note.alwaysOnTop !== false) state.window.setAlwaysOnTop(true, 'floating');
      if (state.note.pinned !== true && state.note.edge !== null) this.#scheduleAutoHide(state);
      // Raise the note without forcing keyboard focus onto it.
      //
      // Forcing focus here was a trap: the auto-hide is suppressed while the user is
      // working in a note, so a note that had been focused *by us* could never hide
      // again — it stayed on screen for the rest of the session, and `blur()` did not
      // reliably hand focus back. Nothing is lost by not grabbing it: the user opened
      // this note to look at it, and `create(..., { activate: true })` is what puts the
      // caret in when they deliberately created a new one.
      this.#scheduleFocusAction(state, () => {
        if (state.window.isDestroyed()) return;
        try {
          state.window.show();
        } catch {
          /* ignore */
        }
      }, () => {});
      state.window.show();
    } catch {
      /* ignore */
    }
  }

  /** Close the window but keep the note in the store. */
  closeWindow(id) {
    const state = this.#notes.get(id);
    if (state === undefined) return;
    this.#clearTimers(state);
    try {
      if (!state.window.isDestroyed()) state.window.close();
    } catch {
      /* ignore */
    }
    this.#notes.delete(id);
    this.#stopPointerPollingIfIdle();
  }

  /** Close the window and tell the host to delete the note. */
  remove(id) {
    this.closeWindow(id);
    this.#emit('note.closed', { id, deleted: true });
  }

  /** Tear down every window. */
  dispose() {
    this.#stopPointerPolling();
    for (const id of [...this.#notes.keys()]) this.closeWindow(id);
  }

  /**
   * Hide every visible note window and remember which ones we hid, so a
   * screenshot does not contain our own floating windows. They stay hidden:
   * the user asked for a screenshot, and the sliver at the edge is still there
   * to hover when they want a note back.
   */
  hideAllForCapture() {
    for (const state of this.#notes.values()) {
      if (state.window.isDestroyed() || state.note.hidden) continue;
      // A note that is not against an edge has no sliver to collapse into, so
      // park it behind the capture rather than leaving it in the frame.
      if (state.note.edge === null || state.note.edge === undefined) continue;
      this.#applyHidden(state, true);
    }
  }

  // ----------------------------------------------------------- internals ==

  /** Run a bounds change we caused ourselves, suppressing move bookkeeping. */
  #internal(state, operation) {
    state.internal = true;
    try {
      operation();
    } catch (error) {
      this.#logger(`设置便签边界失败：${String(error)}`);
    }
    // Cleared on the next tick: 'move'/'resize' fire asynchronously.
    setTimeout(() => {
      state.internal = false;
    }, 60);
  }

  #attachWindowHandlers(state) {
    const onGestureTick = () => {
      // Counted before the `internal` filter: "no move events at all" and "all moves
      // filtered as self-induced" are different bugs with the same symptom.
      state.moveTicks = (state.moveTicks ?? 0) + 1;
      if (state.internal) {
        state.moveTicksIgnored = (state.moveTicksIgnored ?? 0) + 1;
        return;
      }
      this.#scheduleSettle(state);
    };
    state.window.on('move', onGestureTick);
    state.window.on('resize', onGestureTick);
  }

  /** A move/resize happened; wait for it to stop, then commit the result. */
  #scheduleSettle(state) {
    if (state.settling !== null) clearTimeout(state.settling);
    state.settling = setTimeout(() => {
      state.settling = null;
      this.#commitGesture(state);
    }, GESTURE_SETTLE_MS);
  }

  /**
   * The drag/resize finished: record the new geometry, snap to an edge when
   * close enough, persist, and (unless the pointer is on the note) schedule the
   * auto-hide.
   */
  #commitGesture(state) {
    if (state.window.isDestroyed()) return;

    let bounds;
    try {
      bounds = state.window.getBounds();
    } catch {
      return;
    }

    // A hidden note's sliver is not the note's real geometry.
    if (state.note.hidden) return;

    const displays = screen.getAllDisplays();
    const display = displayFor(displays, bounds);
    const workArea = display.workArea;

    // A pinned note is exempt from edge behaviour entirely: it stays exactly where
    // the user put it, and nothing hides it. That is what "保留" means, and it is
    // also what stops the auto-hide from re-arming every time the note is nudged.
    if (state.note.pinned === true) {
      const size = constrainSize(bounds.width, bounds.height);
      const x = clampX(bounds.x, size.width, workArea);
      const y = clampY(bounds.y, size.height, workArea);
      if (x !== bounds.x || y !== bounds.y) {
        this.#internal(state, () => state.window.setBounds({ x, y }));
      }
      state.note = { ...state.note, x, y, width: size.width, height: size.height, edge: null };
      state.home = { x, y, width: size.width, height: size.height };
      this.#emitPosition(state, true);
      return;
    }

    const snapped = snapToEdge(bounds, workArea, this.#settings.snapDistance);

    let finalX = bounds.x;
    let finalY = bounds.y;
    let edge = null;

    if (snapped.edge !== null) {
      edge = snapped.edge;
      finalX = snapped.x;
      finalY = snapped.y;
      this.#internal(state, () => state.window.setBounds({ x: finalX, y: finalY }));
    } else if (finalX !== snapped.x || finalY !== snapped.y) {
      // Not snapping, but the note drifted off the work area — pull it back so
      // it can never become unreachable.
      finalX = snapped.x;
      finalY = snapped.y;
      this.#internal(state, () => state.window.setBounds({ x: finalX, y: finalY }));
    }

    const size = constrainSize(bounds.width, bounds.height);
    state.note = { ...state.note, x: finalX, y: finalY, width: size.width, height: size.height, edge };
    state.home = { x: finalX, y: finalY, width: size.width, height: size.height };

    this.#emitPosition(state, true);

    if (edge !== null && !state.gesture.dragging && !state.gesture.resizing) {
      this.#scheduleAutoHide(state);
    }
  }

  /**
   * Show or clear the "keep this note out" flag.
   *
   * Un-pinning deliberately does *not* hide the note immediately: the user is
   * usually still looking at it, and hiding it under their cursor is hostile. It
   * goes back to normal edge behaviour instead, which re-arms the auto-hide.
   *
   * @param {string} id
   * @param {boolean} pinned
   */
  setPinned(id, pinned) {
    const state = this.#notes.get(id);
    if (state === undefined) return { ok: false, error: '便签不存在' };
    const next = pinned === true;
    state.note = { ...state.note, pinned: next };

    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }

    if (next) {
      // Keeping a note out has to *show* it: it may well be hidden at the edge
      // when the user asks, and leaving it collapsed would look like the button
      // did nothing. `#applyHidden` also drops the edge, so it cannot re-hide.
      if (state.note.hidden) {
        state.note = { ...state.note, edge: null };
        this.#applyHidden(state, false);
      } else if (state.note.edge !== null) {
        // Visible but snapped: clear the edge so the auto-hide cannot re-arm.
        state.note = { ...state.note, edge: null };
      }
    }

    this.#emit('note.pinned', { id, pinned: next });
    this.#sendState(state);

    if (!next) {
      // Back to normal: if it is sitting at an edge, let it snap and hide again.
      if (!state.window.isDestroyed()) this.#commitGesture(state);
    }
    return { ok: true, pinned: next };
  }

  /**
   * Note that the user is *typing* in a note.
   *
   * Only text edits feed this. Dragging is handled by the gesture flags instead
   * (`state.gesture.dragging` / `resizing`), because a drag reports its position on every
   * animation frame — treating those as "activity" would keep the note engaged for as
   * long as the timer below and stop it hiding after being dragged to an edge.
   *
   * @param {object} state
   */
  #touchTyping(state) {
    state.typingAt = Date.now();
  }

  /** True while the user counts as "typing in" this note. */
  #userEngaged(state) {
    if (state.typingAt === 0) return false;
    return Date.now() - state.typingAt < TYPING_ACTIVE_MS;
  }

  /** Persist a position, throttled but always flushed on gesture end. */
  #emitPosition(state, force) {
    const now = Date.now();
    if (!force && now - state.lastEmitAt < POSITION_EMIT_MS) return;
    state.lastEmitAt = now;
    this.#emit('note.moved', {
      id: state.id,
      x: state.note.x,
      y: state.note.y,
      width: state.note.width,
      height: state.note.height,
      edge: state.note.edge,
      hidden: state.note.hidden,
    });
  }

  /**
   * Hide the note at its edge after the configured idle delay.
   *
   * The check inside the timer is not just a guard: when the pointer is still on the
   * note it must *retry*, not give up. Giving up left the note visible until some
   * later pointer poll happened to re-arm the hide — and after a reveal that poll was
   * often no longer running, so the note never went away again.
   */
  #scheduleAutoHide(state) {
    if (state.note.pinned === true) return;
    if (state.hideTimer !== null) clearTimeout(state.hideTimer);
    const delay = Number(this.#settings.autoHideDelayMs);
    const wait = Number.isFinite(delay) ? Math.max(0, delay) : DEFAULT_AUTO_HIDE_MS;
    state.hideTimer = setTimeout(() => {
      state.hideTimer = null;
      if (state.window.isDestroyed() || state.note.hidden) return;
      if (state.note.edge === null || state.note.pinned === true) return;
      if (state.gesture.dragging || state.gesture.resizing) {
        this.#scheduleAutoHide(state);
        return;
      }
      // Never hide a note the pointer is over, nor one the user is typing in. Both
      // cases retry rather than abandon the hide: giving up left the note on screen
      // until some later pointer poll happened to re-arm it. The focus check matters
      // because notes are focusable — without it, typing would be interrupted by the
      // note sliding off the screen mid-sentence.
      let cursor;
      let bounds;
      let engaged = false;
      try {
        cursor = screen.getCursorScreenPoint();
        bounds = state.window.getBounds();
        // "Engaged" means the user is working in this note, judged by what they actually
        // did (see `typingAt`) — NOT by window focus, which a freshly shown
        // always-on-top window gets for free and which would keep the note on screen
        // forever.
        engaged = this.#userEngaged(state);
      } catch {
        return;
      }
      if (engaged || pointInRect(cursor, bounds)) {
        this.#scheduleAutoHide(state);
        return;
      }
      this.#applyHidden(state, true);
    }, wait);
  }

  /**
   * Move a note into or out of its hidden sliver.
   * @param {object} state
   * @param {boolean} hidden
   */
  #applyHidden(state, hidden) {
    if (state.window.isDestroyed()) return;
    const displays = screen.getAllDisplays();
    const workArea = displayFor(displays, state.home).workArea;

    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }

    try {
      if (hidden) {
        if (state.note.edge === null) {
          // No edge to hide against; nothing sensible to do.
          return;
        }
        const hiddenRect = hiddenBounds({ ...state.home, edge: state.note.edge }, workArea, this.#hideMode());
        this.#internal(state, () => {
          // The window carries `minWidth: 140 / minHeight: 90`. In `tab` mode that
          // would silently clamp the tab back to 140px — the note would never
          // collapse — so the minimum size and the resizable flag are lifted
          // *before* the bounds change, in this order. `offscreen` mode keeps the
          // note's own size, but lifting the constraints is still correct: the
          // window is being positioned by us, not by the user.
          state.window.setMinimumSize(1, 1);
          state.window.setResizable(false);
          state.window.setBounds(hiddenRect);
          // Click-through: the tab must not intercept clicks meant for the
          // window underneath it.
          state.window.setIgnoreMouseEvents(true, { forward: true });
        });
      } else {
        const shown = revealedBounds(state.home);
        this.#internal(state, () => {
          state.window.setIgnoreMouseEvents(false);
          // Restore the interactive constraints before growing back, so the
          // revealed note is resizable again and cannot be dragged smaller than
          // the documented minimum.
          state.window.setMinimumSize(MIN_NOTE_WIDTH, MIN_NOTE_HEIGHT);
          state.window.setResizable(true);
          state.window.setBounds(shown);
          if (state.note.alwaysOnTop !== false) state.window.setAlwaysOnTop(true, 'floating');
        });
      }
    } catch (error) {
      this.#logger(`切换便签隐藏状态失败：${String(error)}`);
      return;
    }

    state.note.hidden = hidden;
    this.#emit('note.hidden', { id: state.id, hidden, edge: state.note.edge });
    this.#sendState(state);

    if (hidden) this.#startPointerPolling();
    else this.#stopPointerPollingIfIdle();
  }

  #sendState(state) {
    try {
      if (state.window.isDestroyed()) return;
      state.window.webContents.send('note:state', {
        note: { ...state.note },
        settings: this.#settings,
        // Drives the 「未保存」 badge. `state.note` deliberately does not carry it —
        // a draft is a session concept, not part of the stored note.
        unsaved: state.unsaved === true,
      });
    } catch {
      /* ignore */
    }
  }

  /**
   * Schedule a deferred focus/blur attempt, cancelling the opposite intent first.
   *
   * `release` is called to undo the other direction: focusing cancels a pending blur,
   * and blurring cancels a pending focus. Without this the two deferred timers can both
   * be live and the later one silently wins, which is how a note that was just opened
   * ended up without focus — and therefore refused to auto-hide.
   *
   * @param {object} state
   * @param {() => void} action
   * @param {() => void} release
   */
  #scheduleFocusAction(state, action, release) {
    release();
    const attempt = () => {
      if (state.window === null || state.window.isDestroyed()) return;
      action();
    };
    const timers = [setTimeout(attempt, 60), setTimeout(attempt, 260)];
    state.focusTimers = timers;
  }

  /** Drop any pending focus/blur attempts for a note. */
  #clearFocusTimers(state) {
    for (const timer of state.focusTimers ?? []) clearTimeout(timer);
    state.focusTimers = [];
  }

  #clearTimers(state) {
    this.#clearFocusTimers(state);
    if (state.settling !== null) {
      clearTimeout(state.settling);
      state.settling = null;
    }
    if (state.hideTimer !== null) {
      clearTimeout(state.hideTimer);
      state.hideTimer = null;
    }
    if (state.revealTimer !== null) {
      clearTimeout(state.revealTimer);
      state.revealTimer = null;
    }
  }

  // -------------------------------------------------------- pointer poll ==

  #startPointerPolling() {
    if (this.#pollTimer !== null) return;
    this.#pollTimer = setInterval(() => this.#pollPointer(), POINTER_POLL_MS);
  }

  /**
   * Stop watching the pointer only when nothing needs watching.
   *
   * Regression: this used to stop as soon as no note was hidden. Revealing a note
   * makes it *not* hidden, so the moment the pointer brought a note back the poll
   * died — and since the poll is what re-arms the auto-hide once the pointer leaves,
   * the revealed note then stayed on screen forever. A visible note that still has an
   * edge and is not pinned is exactly the case that needs the poll, so it counts.
   */
  #stopPointerPollingIfIdle() {
    let needed = false;
    for (const state of this.#notes.values()) {
      if (state.note.hidden || (state.note.edge !== null && state.note.pinned !== true)) {
        needed = true;
        break;
      }
    }
    if (!needed) this.#stopPointerPolling();
  }

  #stopPointerPolling() {
    if (this.#pollTimer === null) return;
    clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }

  /**
   * Reveal hidden notes whose edge strip the pointer has entered, and re-hide
   * revealed ones once the pointer leaves.
   *
   * Runs only while something is hidden, so an idle helper costs nothing.
   */
  #pollPointer() {
    let cursor;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch {
      return;
    }

    const displays = screen.getAllDisplays();
    const revealDelay = Number(this.#settings.revealDelayMs);

    for (const state of this.#notes.values()) {
      if (state.window.isDestroyed()) continue;

      // Resolved once per note, for both branches below: the hidden branch needs it
      // to place the reveal zone, the visible branch to tell whether the pointer is
      // still in that zone.
      const workArea = displayFor(displays, state.home).workArea;

      if (state.note.hidden) {
        const zone = revealZone({ ...state.home, edge: state.note.edge }, workArea, undefined, this.#hideMode());
        if (zone !== null && pointInRect(cursor, zone)) {
          if (state.revealTimer === null) {
            // A short delay keeps a pointer merely passing the edge from
            // flinging every note open.
            state.revealTimer = setTimeout(() => {
              state.revealTimer = null;
              if (state.window.isDestroyed() || !state.note.hidden) return;
              this.#applyHidden(state, false);
            }, Number.isFinite(revealDelay) ? Math.max(0, revealDelay) : 120);
          }
        } else if (state.revealTimer !== null) {
          clearTimeout(state.revealTimer);
          state.revealTimer = null;
        }
        continue;
      }

      // Visible note: start the auto-hide countdown only after the pointer has
      // been away for a moment, and cancel it the instant it comes back.
      if (state.note.edge === null) continue;
      let bounds;
      try {
        bounds = state.window.getBounds();
      } catch {
        continue;
      }

      // "Engaged" means the pointer is on the note *or* still in the edge strip
      // that revealed it. Without the second half, a note revealed by moving the
      // pointer to the screen edge would re-hide while the pointer is still sitting
      // there — in `offscreen` mode the note slides back to the edge and so covers
      // the very strip the pointer is in, making the note flicker.
      const onNote = pointInRect(cursor, bounds);
      const edgeZone = revealZone({ ...state.home, edge: state.note.edge }, workArea, undefined, this.#hideMode());
      const onEdge = edgeZone !== null && pointInRect(cursor, edgeZone);

      if (onNote || onEdge) {
        if (state.hideTimer !== null) {
          clearTimeout(state.hideTimer);
          state.hideTimer = null;
        }
      } else if (state.hideTimer === null && !state.gesture.dragging && !state.gesture.resizing) {
        this.#scheduleAutoHide(state);
      }
    }
  }
}

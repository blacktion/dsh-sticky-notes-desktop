/**
 * dsh-sticky-notes — the Host half's link to the Electron helper.
 *
 * Owns the helper's lifecycle and mirrors helper events into the store, so a
 * note that the user drags against a screen edge is persisted *while* it is
 * being moved. That is what makes feature 3 work: DSH can be killed at any
 * moment and the next start restores every note, hidden ones included.
 *
 * Degradation rule: the helper is optional. If Electron is missing, the
 * download failed, or the child died, every method here still answers — with a
 * documented failure value — and the rest of the plugin (list, edit, settings)
 * keeps working. Nothing in this file throws at the caller.
 *
 * @module dsh-sticky-notes/host/bridge
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ElectronHelperClient, ensureElectron, findElectron } from './runtime.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
/** `lib/host/` → package root → `electron/main.mjs`. */
const HELPER_SCRIPT = join(HERE, '..', '..', 'electron', 'main.mjs');
const HELPER_CWD = join(HERE, '..', '..', 'electron');

/** Delay before the first automatic start attempt, so plugin load stays fast. */
const AUTOSTART_DELAY_MS = 1200;

export class StickyBridge {
  #store;
  #log;
  #client = null;
  #starting = null;
  #dataDir;
  #status = { running: false, electronPath: null, source: null, error: null, hotkey: null };
  #disposed = false;
  #unsubscribe = null;
  #autostartTimer = null;
  /** Debounce for store writes driven by `note.moved`. */
  #positionFlush = new Map();
  /** Set by {@link onAlarmClosed}; null when nothing is listening. */
  #onAlarmClosed = null;
  /** Set by {@link onAlarmMoved}; null when nothing is listening. */
  #onAlarmMoved = null;

  /**
   * @param {object} options
   * @param {import('./store.js').StickyStore} options.store
   * @param {string} options.dataDir
   * @param {{ info: Function, warn: Function, error: Function }} options.log
   */
  constructor(options) {
    this.#store = options.store;
    this.#dataDir = options.dataDir;
    this.#log = options.log;
  }

  /**
   * Called when an alarm popup closes, however the user closed it.
   *
   * A plain callback rather than an import of the alarm service: the bridge must not know
   * about scheduling, and the alarm service is what needs to record the dismissal.
   *
   * @param {(id: string) => void} handler
   */
  onAlarmClosed(handler) {
    this.#onAlarmClosed = typeof handler === 'function' ? handler : null;
  }

  /**
   * Called when an alarm popup is dragged.
   *
   * The position is the setting the user is choosing, so the service has to hear about it even
   * though nothing in the host initiated the move.
   *
   * @param {(id: string, x: number, y: number) => void} handler
   */
  onAlarmMoved(handler) {
    this.#onAlarmMoved = typeof handler === 'function' ? handler : null;
  }

  /** Current helper status, safe to serialise to the browser. */
  get status() {
    return { ...this.#status };
  }

  /** A discovered-but-not-started runtime, for an informative settings page. */
  probeRuntime() {
    if (this.#status.electronPath !== null) return { path: this.#status.electronPath, source: this.#status.source };
    const found = findElectron();
    return found === null ? null : { path: found.path, source: found.source };
  }

  /** Start the helper unless it is already running or starting. */
  async start() {
    if (this.#disposed) return this.status;
    if (this.#starting !== null) return this.#starting;

    this.#starting = this.#startInner().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  async #startInner() {
    if (this.#client !== null && this.#client.alive) return this.status;

    let electron;
    try {
      electron = await ensureElectron({ log: (message) => this.#log.info(message) });
    } catch (error) {
      this.#status = {
        ...this.#status,
        running: false,
        error: error instanceof Error ? error.message : String(error),
      };
      this.#log.warn(`sticky-notes: Electron 运行时不可用：${this.#status.error}`);
      return this.status;
    }

    try {
      const client = new ElectronHelperClient({
        exe: electron.path,
        script: HELPER_SCRIPT,
        cwd: HELPER_CWD,
        log: (message) => this.#log.info(message),
      });
      this.#client = client;
      this.#unsubscribe = client.onEvent((message) => this.#onHelperEvent(message));

      // Wait for the helper to bind its RPC socket before sending anything.
      await client.ready();

      const config = await client.call('helper.config', {
        dataDir: this.#dataDir,
        settings: this.#store.getSettings(),
      }, 20000);

      // A refusal here means another helper already owns this data directory —
      // reported plainly rather than surfacing as duplicated windows later.
      if (config !== null && config !== undefined && config.ok === false) {
        throw new Error(String(config.error ?? '助手拒绝了配置'));
      }

      this.#status = {
        running: true,
        electronPath: electron.path,
        source: electron.source,
        // A helper that started fine can still report a hotkey problem: the
        // accelerator was refused because another application owns it, so the key
        // does nothing until the user picks another one.
        error: null,
        warning: typeof config?.hotkey?.warning === 'string' ? config.hotkey.warning : null,
        warningText: typeof config?.hotkey?.error === 'string' ? config.hotkey.error : null,
        // The helper reports the registration *outcome*; the browser half wants the
        // accelerator string, so unwrap it here — and keep the outcome so the
        // settings page can explain exactly what happened. A refused key reports
        // `hotkey: ''`, so `requestedHotkey` is what the UI shows the user.
        hotkey: typeof config?.hotkey?.hotkey === 'string' && config.hotkey.hotkey.length > 0 ? config.hotkey.hotkey : null,
        requestedHotkey: typeof config?.hotkey?.requested === 'string' ? config.hotkey.requested : null,
        hotkeyStatus: config?.hotkey ?? null,
      };
      if (this.#status.warning !== null) {
        this.#log.warn(`sticky-notes: ${this.#status.warningText ?? '快捷键需要留意'}`);
      }
      this.#log.info(`sticky-notes: Electron 助手已启动（${electron.path}）`);

      // Restore every note the store knows about, hidden ones included.
      await this.#restoreNotes();
      return this.status;
    } catch (error) {
      this.#status = {
        ...this.#status,
        running: false,
        electronPath: electron.path,
        source: electron.source,
        error: error instanceof Error ? error.message : String(error),
      };
      this.#log.warn(`sticky-notes: 助手启动失败：${this.#status.error}`);
      try {
        await this.#client?.dispose();
      } catch {
        /* ignore */
      }
      this.#client = null;
      return this.status;
    }
  }

  /**
   * Push the stored notes into a freshly started helper.
   * Reuses `note.reconcile` so state is applied in one round trip and a note
   * that was hidden at a screen edge comes back as its sliver, not as a window.
   */
  async #restoreNotes() {
    const client = this.#client;
    if (client === null) return;
    const notes = this.#store.listNotes();
    await client.call('note.reconcile', { notes, settings: this.#store.getSettings() }, 30000);
    this.#log.info(`sticky-notes: 已恢复 ${notes.length} 个便签`);
  }

  /** Stop the helper and wait for it to exit. */
  async stop() {
    if (this.#autostartTimer !== null) {
      clearTimeout(this.#autostartTimer);
      this.#autostartTimer = null;
    }
    const client = this.#client;
    this.#client = null;
    try {
      this.#unsubscribe?.();
    } catch {
      /* ignore */
    }
    this.#unsubscribe = null;
    if (client === null) {
      this.#status = { ...this.#status, running: false };
      return this.status;
    }
    try {
      await client.call('helper.quit', {}, 3000);
    } catch {
      /* the helper may already be gone */
    }
    try {
      await client.dispose();
    } catch {
      /* ignore */
    }
    this.#status = { ...this.#status, running: false, error: null };
    this.#log.info('sticky-notes: Electron 助手已停止');
    return this.status;
  }

  /** Schedule the automatic start after plugin load. */
  scheduleAutostart() {
    if (this.#disposed) return;
    if (this.#store.getSettings().autoStartHelper !== true) return;
    if (this.#autostartTimer !== null) return;
    this.#autostartTimer = setTimeout(() => {
      this.#autostartTimer = null;
      void this.start().catch((error) => this.#log.warn(`sticky-notes: 自动启动失败：${String(error)}`));
    }, AUTOSTART_DELAY_MS);
    if (typeof this.#autostartTimer.unref === 'function') this.#autostartTimer.unref();
  }

  // ------------------------------------------------------------ helper api ==

  /** True when a live helper can accept calls. */
  get available() {
    return this.#client !== null && this.#client.alive && this.#status.running;
  }

  /** Open (or focus) a note window for a stored note. */
  async openNote(id) {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    const note = this.#store.getNote(id);
    if (note === null) return { ok: false, error: '便签不存在' };
    try {
      // `activate: true` because this is 「打开」 — the user asked to see this note, so
      // it should come to the front and accept typing.
      await this.#client.call('note.create', {
        note,
        settings: this.#store.getSettings(),
        activate: true,
      });
      await this.#client.call('note.focus', { id });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Create a note and open its window.
   *
   * `activate: true`: a note the user just asked for must be typable immediately,
   * which is why the window is focusable and takes focus here — the opposite of the
   * restore path, where stealing focus would be hostile.
   */
  async createNote(note) {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      const result = await this.#client.call('note.create', {
        note,
        settings: this.#store.getSettings(),
        activate: true,
      });
      return { ok: true, id: result?.id ?? note?.id ?? null };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // ------------------------------------------------------------------ alarms

  /**
   * Show an alarm's popup.
   *
   * The alarm is transient: it is not a note, is not restored on restart, and disappears
   * when the user closes it. All of that lives in the helper — the host only decides *when*.
   *
   * @param {object} alarm
   */
  async showAlarm(alarm) {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      return await this.#client.call('alarm.show', { alarm });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Show a preview of an alarm that has not been saved yet.
   *
   * `draft: true` makes the helper use its placeholder id, so the 「新建闹钟」 form can 试响
   * — and therefore position the popup — before there is anything to save.
   *
   * @param {object} alarm
   */
  async showAlarmDraft(alarm) {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      return await this.#client.call('alarm.show', { alarm, draft: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Dismiss an alarm's popup. */
  async closeAlarm(id) {
    if (!this.available) return { ok: false };
    try {
      return await this.#client.call('alarm.close', { id });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Move an alarm popup, as a user drag would.
   *
   * Test hook: it rejects a synthetic position, but moving the real window still fires `move`,
   * which is the event the host actually listens to — so this exercises the whole
   * drag → `alarm.moved` → persisted position path without synthetic input.
   */
  async moveAlarmForTest(id, x, y) {
    if (!this.available) return { ok: false };
    try {
      return await this.#client.call('alarm.setPosition', { id, x, y }, 5000);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Ids of alarms currently on screen. */
  async openAlarms() {
    if (!this.available) return { ids: [] };
    try {
      return await this.#client.call('alarm.list', {}, 5000);
    } catch {
      return { ids: [] };
    }
  }

  /**
   * Ask the user to choose an image for an alarm.
   *
   * Runs in the helper because a native file dialog needs a window to own it; the browser
   * half has only an HTTP endpoint and cannot open one.
   */
  async pickAlarmImage() {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      return await this.#client.call('alarm.pickImage', {}, 300_000);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * File a draft: make a hotkey-created note visible to the host.
   *
   * Separate from {@link openNote} on purpose. A draft exists only in the helper until
   * the user presses 「保存」, and until then no store row exists — so a patch (including
   * the save's own `note.updated`) would be dropped and the note would never reach the
   * list. This is the call that tells the helper to announce it.
   *
   * @param {string} id
   */
  async commitDraft(id) {
    if (!this.available) return { ok: false, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      const result = await this.#client.call('note.commitDraft', { id });
      return { ok: result?.ok !== false, created: result?.created === true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Push an updated note (content or appearance) into its window. */
  async pushNote(id, patch) {
    if (!this.available) return { ok: false, error: 'Electron 助手未运行' };
    try {
      await this.#client.call('note.update', { id, patch });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Tell the helper the user is done with a note, so it stops holding focus.
   *
   * Required for auto-hide to resume: a focused note is never hidden, because hiding the
   * window the user is typing in would be hostile.
   *
   * @param {string} id
   */
  async blurNote(id) {
    if (!this.available) return { ok: false };
    try {
      return await this.#client.call('note.blur', { id });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Drive a note's position the way the renderer's drag does — for reproducing drag
   * behaviour in tests.
   *
   * The renderer reports its position on every animation frame, so a test that means to
   * reproduce a drag has to send many small updates rather than one jump. A single jump
   * does not exercise the same code path and hid the bug this exists to catch.
   *
   * @param {string} id
   * @param {{x: number, y: number}} point
   */
  async setBoundsForTest(id, point) {
    if (!this.available) return { ok: false };
    try {
      return await this.#client.call('note.setBounds', { id, x: point.x, y: point.y });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Every window the helper owns, for diagnostics and tests.
   *
   * "An alarm is ringing" is not the same as "an alarm window is on screen": an id can be
   * remembered while the window failed to appear, which is indistinguishable from a working
   * alarm unless something reports the windows themselves.
   */
  async debugWindows() {
    if (!this.available) return [];
    try {
      const listing = await this.#client.call('helper.windows', {}, 5000);
      return Array.isArray(listing?.windows) ? listing.windows : [];
    } catch {
      return [];
    }
  }

  /**
   * Where one alarm's popup currently is, or null.
   *
   * Asked of the helper rather than found in `debugWindows`: every popup shares its page
   * title, so "the first window titled 便签闹钟" is whichever alarm happens to be first — which
   * silently reports another alarm's position when several are open.
   *
   * @param {string} id
   */
  async alarmBounds(id) {
    if (!this.available) return null;
    try {
      const result = await this.#client.call('alarm.bounds', { id }, 5000);
      return result?.bounds ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The displays the helper can see.
   *
   * Reported by the helper, not inferred in the host: window placement uses the helper's own
   * `screen` module, so a caller asserting against the host's idea of the work area could be
   * comparing against a different display entirely.
   */
  async debugDisplays() {
    if (!this.available) return [];
    try {
      const listing = await this.#client.call('displays.list', {}, 5000);
      return Array.isArray(listing?.displays) ? listing.displays : [];
    } catch {
      return [];
    }
  }

  /**
   * Live window state for a note, for diagnostics and tests.
   *
   * Reports the note, its bounds and whether the window is focused — without these a
   * failing auto-hide is indistinguishable from a slow one.
   *
   * @param {string} id
   */
  async debugNoteState(id) {
    if (!this.available) return null;
    try {
      return await this.#client.call('note.state', { id }, 5000);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Close a note window without deleting the note. */
  async closeNote(id) {
    if (!this.available) return { ok: false };
    try {
      await this.#client.call('note.close', { id });
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** Force a note hidden or shown at its edge. */
  async setHidden(id, hidden) {
    if (!this.available) return { ok: false, error: 'Electron 助手未运行' };
    const note = this.#store.getNote(id);
    if (note === null) return { ok: false, error: '便签不存在' };
    try {
      await this.#client.call('note.setHidden', { id, hidden, edge: note.edge ?? undefined });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Set or clear "keep this note out".
   *
   * Recorded in the store even when the helper is unavailable, so the preference
   * still applies the next time it starts.
   */
  async setPinned(id, pinned) {
    const note = this.#store.getNote(id);
    if (note === null) return { ok: false, error: '便签不存在' };
    this.#store.updateNote(id, { pinned: pinned === true });
    this.#store.flushSoon();
    if (!this.available) return { ok: true, pinned: pinned === true, helper: 'unavailable' };
    try {
      await this.#client.call('note.setPinned', { id, pinned: pinned === true });
      return { ok: true, pinned: pinned === true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Show the pointer-anchored popup; returns the chosen action.
   *
   * @param {{ forcedChoice?: 'new-note'|'shot' }} [options] skips the native menu
   *        so the hotkey's action branches can be driven without a human
   */
  async showPopup(options = {}) {
    if (!this.available) return { choice: null, error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      const params = options.forcedChoice === undefined ? {} : { forcedChoice: options.forcedChoice };
      return await this.#client.call('popup.show', params, 40000);
    } catch (error) {
      return { choice: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Run a capture session. Returns the saved PNG path (and note id for 'note'). */
  async capture(mode = 'file') {
    if (!this.available) return { error: this.#status.error ?? 'Electron 助手未运行' };
    try {
      return await this.#client.call('shot.begin', { mode }, 180_000);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Apply settings to the helper (hotkey included). */
  async applySettings(settings) {
    if (!this.available) return { ok: false, error: 'Electron 助手未运行', hotkey: null };
    try {
      const result = await this.#client.call('settings.apply', { settings });
      const outcome = result?.hotkey ?? null;
      this.#status = {
        ...this.#status,
        hotkey:
          typeof outcome?.hotkey === 'string' && outcome.hotkey.length > 0 ? outcome.hotkey : null,
        requestedHotkey: typeof outcome?.requested === 'string' ? outcome.requested : null,
        warning: typeof outcome?.warning === 'string' ? outcome.warning : null,
        warningText: typeof outcome?.error === 'string' ? outcome.error : null,
        hotkeyStatus: outcome,
      };
      return {
        ok: true,
        hotkey: this.#status.hotkey,
        // `ok: false` here means "the accelerator was refused because another
        // application owns it", not "the call failed" — the settings page reports
        // the difference, and nothing is registered on the user's behalf.
        applied: outcome,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error), hotkey: null };
    }
  }

  /** List the displays the helper can see (used for diagnostics). */
  async displays() {
    if (!this.available) return { displays: [] };
    try {
      return await this.#client.call('displays.list', {}, 5000);
    } catch {
      return { displays: [] };
    }
  }

  // ------------------------------------------------------------ event path ==

  /** Mirror helper events into the store. */
  #onHelperEvent(message) {
    const event = String(message.event ?? '');
    const data = message.data ?? {};

    try {
      if (event === 'note.moved') {
        // The user finished dragging: persist geometry and hidden state so a
        // DSH restart restores it. Debounced because a drag streams updates at
        // pointer frequency, and the very latest position is cheap to lose.
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        const previous = this.#positionFlush.get(id);
        if (previous !== undefined) clearTimeout(previous);
        const timer = setTimeout(() => {
          this.#positionFlush.delete(id);
          this.#store.updateNote(id, {
            x: data.x,
            y: data.y,
            width: data.width,
            height: data.height,
            edge: data.edge ?? null,
            hidden: data.hidden === true,
          });
        }, 150);
        if (typeof timer.unref === 'function') timer.unref();
        this.#positionFlush.set(id, timer);
        return;
      }

      if (event === 'note.hidden') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        this.#store.updateNote(id, { hidden: data.hidden === true, edge: data.edge ?? null });
        // A discrete change, not a stream: write it now so a crash or a DSH
        // restart can never resurrect a note in the wrong hidden state.
        this.#store.flushSoon();
        return;
      }

      if (event === 'note.pinned') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        // "Keep this note out" is a durable preference: it has to survive a restart,
        // otherwise the note would go back to hiding itself at the edge.
        this.#store.updateNote(id, { pinned: data.pinned === true });
        this.#store.flushSoon();
        return;
      }

      if (event === 'note.created') {
        const note = data.note;
        if (note === null || typeof note !== 'object' || typeof note.id !== 'string' || note.id.length === 0) return;
        /**
         * A note the helper created on its own — the hotkey path.
         *
         * Regression: nothing recorded it, so the note existed only as a window. The
         * store never learned the id, which meant 「保存」 patched an unknown note and
         * was dropped, and the note never showed up in the sidebar list.
         *
         * `upsertNote` rather than `updateNote`: if the host already knows this id (the
         * panel path creates the row first, then asks the helper to open a window) the
         * existing row is updated instead of being duplicated. The helper's copy of the
         * appearance is authoritative for a brand-new note, since that is what the user
         * sees on screen.
         */
        this.#store.upsertNote(note);
        // Written immediately: this is a new note, and losing it to a crash before the
        // debounce elapsed would look exactly like the bug being fixed.
        this.#store.flushSoon();
        return;
      }

      if (event === 'note.updated') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        this.#store.updateNote(id, data.patch ?? {});
        this.#store.flushSoon();
        return;
      }

      if (event === 'note.closed') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        if (data.deleted === true) {
          this.#store.deleteNote(id);
          this.#store.flushSoon();
        }
        return;
      }

      if (event === 'alarm.moved') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        // Where the user dragged the popup. This is what makes 试响 also set the position.
        this.#onAlarmMoved?.(id, Number(data.x), Number(data.y));
        return;
      }

      if (event === 'alarm.closed') {
        const id = String(data.id ?? '');
        if (id.length === 0) return;
        // Reported by the helper rather than inferred from our own close call: the user can
        // also dismiss an alarm by pressing Esc or right-clicking, which the host never sees
        // otherwise.
        this.#onAlarmClosed?.(id);
        return;
      }

      if (event === 'shot.saved') {
        // A 「存为便签」 commit has no path; it produces a note instead, which arrives as
        // a separate `note.created`. Reporting only the path made that case look empty.
        const where =
          typeof data.path === 'string' && data.path.length > 0
            ? data.path
            : typeof data.noteId === 'string'
              ? `便签 ${data.noteId}`
              : '';
        this.#log.info(`sticky-notes: 截图已保存${where.length > 0 ? `：${where}` : ''}`);
        return;
      }

      if (event === 'helper.error') {
        this.#log.warn(`sticky-notes: 助手报告错误：${String(data.message ?? '')}`);
        return;
      }

      if (event === 'helper.ready') {
        this.#status = { ...this.#status, running: true, error: null };
      }
    } catch (error) {
      // Event handling must never escalate into a host-level failure.
      this.#log.warn(`sticky-notes: 处理助手事件 ${event} 失败：${String(error)}`);
    }
  }

  /** Release the helper and flush pending writes. */
  async dispose() {
    this.#disposed = true;
    for (const timer of this.#positionFlush.values()) clearTimeout(timer);
    this.#positionFlush.clear();
    await this.stop();
  }
}

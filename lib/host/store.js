/**
 * dsh-sticky-notes — durable note/settings store.
 *
 * Layout under `~/.dsh/sticky-notes/`:
 *
 *   data.json    { version, settings, notes: Note[] }   — the full index
 *   shots/       <noteId>.png                            — screenshot pixels
 *
 * Design rules, in service of "never crash DSH":
 *
 *   - In-memory state is authoritative; disk writes are best-effort and
 *     debounced. A full disk or a locked file degrades to "not persisted",
 *     never to a thrown exception inside a plugin callback.
 *   - Writes are atomic (temp file + rename) so a crash mid-write cannot
 *     truncate the index. A corrupt index is quarantined and rebuilt empty
 *     rather than thrown.
 *   - Position updates arrive at pointer-move frequency, so `updateNote`
 *     schedules a coalesced flush instead of writing per call.
 *
 * @module dsh-sticky-notes/host/store
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_NOTE_WIDTH, DEFAULT_NOTE_HEIGHT } from './geometry.js';

/** Bumped when the on-disk shape changes incompatibly. */
export const STORE_VERSION = 1;

/** Flush coalescing window for high-frequency updates (ms). */
const FLUSH_DEBOUNCE_MS = 400;

export const DEFAULT_SETTINGS = {
  /** Toggle hotkey that opens the "new note / screenshot" popup. */
  hotkey: 'CommandOrControl+Alt+S',
  /** Default note background. */
  backgroundColor: '#000000',
  /** Default note opacity, 0.2–1. */
  opacity: 0.8,
  /** Default text colour — light, because the default background is black. */
  textColor: '#f5f5f5',
  /** Default font size in px. */
  fontSize: 14,
  /** Snap-to-edge distance in px. */
  snapDistance: 12,
  /**
   * How a snapped note hides at the edge.
   *
   * `offscreen` (the default) slides the note out of the display leaving a 1px
   * edge; `tab` collapses it into a taskbar-like tab at the edge. `tab` is offered
   * in the settings page as the alternative.
   */
  hideMode: 'offscreen',
  /**
   * Delay before an edge-adjacent note hides (ms).
   *
   * Short by design: the note was already hidden until the pointer revealed it, so
   * once the pointer leaves there is nothing to wait for. A long delay here read as
   * "the note does not hide any more".
   *
   * This is a delay, not a deadline — if the pointer is still on the note when it
   * expires, the hide is retried rather than skipped, so a small value can never
   * make a note vanish from under the cursor.
   *
   * Matches `revealDelayMs`: hiding and revealing are the same gesture seen from
   * either end, so they feel wrong at different speeds.
   */
  autoHideDelayMs: 120,
  /** Delay before an edge-hidden note reveals on mouse proximity (ms). */
  revealDelayMs: 120,
  /** Launch the Electron helper on plugin load. */
  autoStartHelper: true,
  /** Where exported PNGs are written. */
  exportDir: '',
};

/** Fields a caller may patch on a note. */
const NOTE_PATCHABLE = new Set([
  'title',
  'text',
  'x',
  'y',
  'width',
  'height',
  'hidden',
  'pinned',
  'edge',
  'snapDir',
  'color',
  'opacity',
  'textColor',
  'fontSize',
  'alwaysOnTop',
]);

function nowIso() {
  return new Date().toISOString();
}

/** A defensive copy, including the nested schedule. */
function deepCopyAlarm(alarm) {
  return { ...alarm, schedule: { ...alarm.schedule } };
}

/**
 * An optional screen coordinate: a finite number, or null — never a coerced zero.
 *
 * `Number(null)` and `Number('')` are both `0`, so the plausible-looking guard
 * `Number.isFinite(Number(value))` accepts "absent" as the coordinate 0 instead of rejecting
 * it. That is what parked alarms in the top-left corner rather than centring them.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toCoord(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/** Clamp a number into a range, tolerating garbage input. */
function clamp(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalise an arbitrary object into a well-formed Note. */
export function normalizeNote(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const kind = input.kind === 'shot' ? 'shot' : 'text';
  const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : `n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    kind,
    title: typeof input.title === 'string' ? input.title : '',
    text: typeof input.text === 'string' ? input.text : '',
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 80,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 80,
    width: clamp(input.width, 120, 4000, kind === 'shot' ? 380 : DEFAULT_NOTE_WIDTH),
    height: clamp(input.height, 80, 4000, kind === 'shot' ? 280 : DEFAULT_NOTE_HEIGHT),
    hidden: input.hidden === true,
    /**
     * "Keep this note out": once the user asks for it, the note stops snapping to
     * edges and never hides itself. It is the only way a note stays put — by
     * default an edge-adjacent note hides, which is the documented behaviour.
     */
    pinned: input.pinned === true,
    edge: typeof input.edge === 'string' ? input.edge : null,
    snapDir: typeof input.snapDir === 'string' ? input.snapDir : null,
    color: typeof input.color === 'string' && input.color.length > 0 ? input.color : DEFAULT_SETTINGS.backgroundColor,
    opacity: clamp(input.opacity, 0.2, 1, DEFAULT_SETTINGS.opacity),
    textColor:
      typeof input.textColor === 'string' && input.textColor.length > 0 ? input.textColor : DEFAULT_SETTINGS.textColor,
    fontSize: clamp(input.fontSize, 8, 72, 14),
    alwaysOnTop: input.alwaysOnTop !== false,
    image: typeof input.image === 'string' && input.image.length > 0 ? input.image : null,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : nowIso(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : nowIso(),
  };
}

/** Fields a caller may patch on an alarm. */
const ALARM_PATCHABLE = new Set([
  'label',
  'kind',
  'text',
  'image',
  'schedule',
  'enabled',
  'x',
  'y',
  'lastFiredAt',
  'lastDismissedAt',
  'fireCount',
]);

/**
 * Normalise an alarm record.
 *
 * An alarm is "something to show at a time": a label for the list, content that is either
 * text or an image, and a schedule. Schedule validity is *not* enforced here — an alarm with
 * a half-typed time is stored as-is and simply never fires, so the editor can hold a
 * work-in-progress without the store silently rewriting it.
 *
 * @param {object} raw
 */
export function normalizeAlarm(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const id =
    typeof input.id === 'string' && input.id.length > 0
      ? input.id
      : `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const schedule = input.schedule !== null && typeof input.schedule === 'object' ? input.schedule : {};
  return {
    id,
    label: typeof input.label === 'string' ? input.label : '',
    kind: input.kind === 'image' ? 'image' : 'text',
    text: typeof input.text === 'string' ? input.text : '',
    image: typeof input.image === 'string' && input.image.length > 0 ? input.image : null,
    schedule: {
      kind: schedule.kind === 'weekdays' ? 'weekdays' : schedule.kind === 'once' ? 'once' : 'daily',
      time: typeof schedule.time === 'string' ? schedule.time : '09:00',
      at: typeof schedule.at === 'string' ? schedule.at : '',
    },
    enabled: input.enabled !== false,
    /**
     * Where the popup should appear, in screen pixels; `null` means "centred".
     *
     * Set by dragging the popup during 试响 — the alarm IS the window, so letting the user put it
     * where they want while previewing it is the only natural way to choose. Stored per alarm
     * because a standup reminder and a "look at this screenshot" reminder do not belong in the
     * same corner.
     *
     * `toCoord`, not `Number.isFinite(Number(x))`: **`Number(null)` is 0**, so that form turns
     * "no position saved" into the position (0,0) — the top-left corner — which is how every
     * alarm ended up parked there instead of centred.
     */
    x: toCoord(input.x),
    y: toCoord(input.y),
    // Timestamps of the last firing and dismissal. `lastFiredAt` is what stops a per-minute
    // tick from firing the same alarm repeatedly and what retires a `once` alarm.
    lastFiredAt: typeof input.lastFiredAt === 'string' && input.lastFiredAt.length > 0 ? input.lastFiredAt : null,
    lastDismissedAt:
      typeof input.lastDismissedAt === 'string' && input.lastDismissedAt.length > 0 ? input.lastDismissedAt : null,
    fireCount: Number.isFinite(Number(input.fireCount)) ? Math.max(0, Math.trunc(Number(input.fireCount))) : 0,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : nowIso(),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : nowIso(),
  };
}

/** Normalise a settings patch onto the defaults. */
export function normalizeSettings(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const merged = { ...DEFAULT_SETTINGS, ...input };
  return {
    hotkey: typeof merged.hotkey === 'string' && merged.hotkey.trim().length > 0 ? merged.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
    backgroundColor: typeof merged.backgroundColor === 'string' ? merged.backgroundColor : DEFAULT_SETTINGS.backgroundColor,
    opacity: clamp(merged.opacity, 0.2, 1, DEFAULT_SETTINGS.opacity),
    textColor: typeof merged.textColor === 'string' ? merged.textColor : DEFAULT_SETTINGS.textColor,
    fontSize: clamp(merged.fontSize, 8, 72, DEFAULT_SETTINGS.fontSize),
    snapDistance: clamp(merged.snapDistance, 0, 200, DEFAULT_SETTINGS.snapDistance),
    hideMode: merged.hideMode === 'tab' ? 'tab' : DEFAULT_SETTINGS.hideMode,
    autoHideDelayMs: clamp(merged.autoHideDelayMs, 0, 60000, DEFAULT_SETTINGS.autoHideDelayMs),
    revealDelayMs: clamp(merged.revealDelayMs, 0, 5000, DEFAULT_SETTINGS.revealDelayMs),
    autoStartHelper: merged.autoStartHelper !== false,
    exportDir: typeof merged.exportDir === 'string' ? merged.exportDir : '',
  };
}

export class StickyStore {
  #dir;
  #dataFile;
  #shotsDir;
  #log;
  #state;
  #flushTimer = null;
  #flushSoonTimer = null;
  #dirty = false;
  #closed = false;

  /**
   * @param {object} options
   * @param {string} options.dir   data directory
   * @param {(level: string, message: string) => void} [options.log]
   */
  constructor(options) {
    this.#dir = options.dir;
    this.#dataFile = join(this.#dir, 'data.json');
    this.#shotsDir = join(this.#dir, 'shots');
    this.#log = options.log ?? (() => {});
    this.#state = { version: STORE_VERSION, settings: { ...DEFAULT_SETTINGS }, notes: [], alarms: [] };
  }

  /** Read the index from disk, tolerating every failure mode. */
  load() {
    try {
      mkdirSync(this.#shotsDir, { recursive: true });
    } catch (error) {
      this.#log('warn', `sticky-notes: 无法创建数据目录 ${this.#shotsDir}：${String(error)}`);
    }

    if (!existsSync(this.#dataFile)) return this.#state;

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.#dataFile, 'utf8'));
    } catch (error) {
      // Quarantine rather than lose: a corrupt file is renamed aside so the
      // user can recover it, and we start from an empty index.
      this.#log('warn', `sticky-notes: 数据文件损坏，已备份并重建：${String(error)}`);
      try {
        renameSync(this.#dataFile, `${this.#dataFile}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return this.#state;
    }

    const notes = Array.isArray(parsed?.notes) ? parsed.notes.map(normalizeNote) : [];
    const alarms = Array.isArray(parsed?.alarms) ? parsed.alarms.map(normalizeAlarm) : [];
    this.#state = {
      version: STORE_VERSION,
      settings: normalizeSettings(parsed?.settings),
      notes,
      alarms,
    };
    return this.#state;
  }

  /** Whole documented state (a defensive copy). */
  snapshot() {
    return {
      version: this.#state.version,
      settings: { ...this.#state.settings },
      notes: this.#state.notes.map((note) => ({ ...note })),
      alarms: this.#state.alarms.map((alarm) => deepCopyAlarm(alarm)),
    };
  }

  /** All notes, id order preserved. */
  listNotes() {
    return this.#state.notes.map((note) => ({ ...note }));
  }

  /** One note by id. */
  getNote(id) {
    const found = this.#state.notes.find((note) => note.id === id);
    return found === undefined ? null : { ...found };
  }

  /** Effective settings. */
  getSettings() {
    return { ...this.#state.settings };
  }

  /** Patch settings; returns the effective settings. */
  updateSettings(patch) {
    this.#state.settings = normalizeSettings({ ...this.#state.settings, ...(patch ?? {}) });
    this.#scheduleFlush();
    return this.getSettings();
  }

  /**
   * Insert or replace a note.
   * @param {object} raw
   * @returns {object} the stored note
   */
  upsertNote(raw) {
    const incoming = raw !== null && typeof raw === 'object' ? raw : {};
    const existingIndex =
      typeof incoming.id === 'string' ? this.#state.notes.findIndex((note) => note.id === incoming.id) : -1;

    if (existingIndex >= 0) {
      const current = this.#state.notes[existingIndex];
      const patch = {};
      for (const [key, value] of Object.entries(incoming)) {
        if (NOTE_PATCHABLE.has(key)) patch[key] = value;
      }
      const next = normalizeNote({ ...current, ...patch, updatedAt: nowIso() });
      this.#state.notes[existingIndex] = next;
      this.#scheduleFlush();
      return { ...next };
    }

    const created = normalizeNote({ ...incoming, createdAt: nowIso(), updatedAt: nowIso() });
    this.#state.notes.push(created);
    this.#scheduleFlush();
    return { ...created };
  }

  /** Patch a subset of one note. Returns the note, or null when unknown. */
  updateNote(id, patch) {
    const index = this.#state.notes.findIndex((note) => note.id === id);
    if (index < 0) return null;
    const safePatch = {};
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (NOTE_PATCHABLE.has(key)) safePatch[key] = value;
    }
    const next = normalizeNote({ ...this.#state.notes[index], ...safePatch, updatedAt: nowIso() });
    this.#state.notes[index] = next;
    this.#scheduleFlush();
    return { ...next };
  }

  /** Remove a note and its pixel data. Returns true when something was removed. */
  deleteNote(id) {
    const index = this.#state.notes.findIndex((note) => note.id === id);
    if (index < 0) return false;
    this.#state.notes.splice(index, 1);
    this.#scheduleFlush();
    this.deleteShot(id);
    return true;
  }

  // ------------------------------------------------------------------ alarms

  /** All alarms, insertion order preserved. */
  listAlarms() {
    return this.#state.alarms.map((alarm) => deepCopyAlarm(alarm));
  }

  /** One alarm, or null. */
  getAlarm(id) {
    const alarm = this.#state.alarms.find((entry) => entry.id === id);
    return alarm === undefined ? null : deepCopyAlarm(alarm);
  }

  /**
   * Insert or patch an alarm.
   *
   * Used both by the editor (arbitrary fields) and by the scheduler's bookkeeping
   * (`lastFiredAt` / `fireCount`), which is why the patch is field-filtered rather than
   * trusting the caller.
   *
   * @param {object} raw
   */
  upsertAlarm(raw) {
    const incoming = raw !== null && typeof raw === 'object' ? raw : {};
    const existingIndex =
      typeof incoming.id === 'string' ? this.#state.alarms.findIndex((alarm) => alarm.id === incoming.id) : -1;

    if (existingIndex >= 0) {
      const current = this.#state.alarms[existingIndex];
      const patch = {};
      for (const [key, value] of Object.entries(incoming)) {
        if (ALARM_PATCHABLE.has(key)) patch[key] = value;
      }
      // `schedule` is merged rather than replaced so a partial patch (just the time) cannot
      // silently drop the kind and turn "工作日" into "每天".
      const merged = {
        ...current,
        ...patch,
        schedule:
          patch.schedule === undefined ? current.schedule : { ...current.schedule, ...patch.schedule },
        updatedAt: nowIso(),
      };
      const next = normalizeAlarm(merged);
      this.#state.alarms[existingIndex] = next;
      this.#scheduleFlush();
      return deepCopyAlarm(next);
    }

    const created = normalizeAlarm({ ...incoming, createdAt: nowIso(), updatedAt: nowIso() });
    this.#state.alarms.push(created);
    this.#scheduleFlush();
    return deepCopyAlarm(created);
  }

  /** Patch one alarm. Returns it, or null when unknown. */
  updateAlarm(id, patch) {
    if (this.getAlarm(id) === null) return null;
    return this.upsertAlarm({ ...(patch ?? {}), id });
  }

  /** Remove an alarm. Returns true when something was removed. */
  deleteAlarm(id) {
    const index = this.#state.alarms.findIndex((alarm) => alarm.id === id);
    if (index < 0) return false;
    this.#state.alarms.splice(index, 1);
    this.#scheduleFlush();
    return true;
  }

  /** Absolute path of a note's stored PNG. */
  shotPath(id) {
    return join(this.#shotsDir, `${id}.png`);
  }

  /** Persist raw PNG bytes for a note. Returns the absolute path. */
  saveShot(id, bytes) {
    const target = this.shotPath(id);
    try {
      mkdirSync(this.#shotsDir, { recursive: true });
      const temp = `${target}.tmp-${process.pid}`;
      writeFileSync(temp, bytes);
      renameSync(temp, target);
    } catch (error) {
      this.#log('warn', `sticky-notes: 写入截图失败 ${target}：${String(error)}`);
    }
    return target;
  }

  /** Delete stored pixels for a note. Best-effort. */
  deleteShot(id) {
    try {
      const target = this.shotPath(id);
      if (existsSync(target)) unlinkSync(target);
    } catch {
      /* ignore */
    }
  }

  #scheduleFlush() {
    this.#dirty = true;
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    if (typeof this.#flushTimer.unref === 'function') this.#flushTimer.unref();
  }

  /**
   * Flush on the next tick instead of the full debounce window.
   *
   * Used for *discrete* state changes — a note collapsing to its edge tab, a
   * setting being changed — where the debounce exists only to coalesce, not to
   * rate-limit. Position updates keep the longer window because a drag streams
   * them at pointer frequency.
   */
  flushSoon() {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#flushSoonTimer !== null) return;
    this.#flushSoonTimer = setTimeout(() => {
      this.#flushSoonTimer = null;
      this.flush();
    }, 20);
    if (typeof this.#flushSoonTimer.unref === 'function') this.#flushSoonTimer.unref();
  }

  /** Write the index immediately. Never throws. */
  flush() {
    if (!this.#dirty || this.#closed) return;
    this.#dirty = false;
    try {
      mkdirSync(this.#dir, { recursive: true });
      const temp = `${this.#dataFile}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(this.#state, null, 2), 'utf8');
      renameSync(temp, this.#dataFile);
    } catch (error) {
      this.#dirty = true;
      this.#log('warn', `sticky-notes: 保存索引失败：${String(error)}`);
    }
  }

  /** Flush and stop the debounce timers. */
  close() {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#flushSoonTimer !== null) {
      clearTimeout(this.#flushSoonTimer);
      this.#flushSoonTimer = null;
    }
    this.#dirty = true;
    this.flush();
    this.#closed = true;
  }
}

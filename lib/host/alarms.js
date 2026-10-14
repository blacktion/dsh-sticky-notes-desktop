/**
 * dsh-sticky-notes — the 便签闹钟 service.
 *
 * Owns the one thing the pieces either side of it cannot: the join between "the schedule
 * says it is time" and "put a window on screen". The scheduler computes the time, the bridge
 * talks to Electron, and this is what makes an alarm actually appear.
 *
 * The alarm popup is deliberately **not** restored on restart. An alarm is a moment, not a
 * document: if DSH was closed when it came due, showing it on the next start (which the
 * scheduler does, once) is the generous reading, but leaving it on screen indefinitely is
 * not. Dismissing it means it is gone.
 *
 * @module dsh-sticky-notes/host/alarms
 */
import { AlarmScheduler } from './alarm-scheduler.js';
import { describeSchedule, nextOccurrence } from './alarm-schedule.js';

/**
 * The id a preview of an *unsaved* alarm is shown under.
 *
 * Duplicated in `electron/alarm-windows.mjs` as a literal rather than imported: the helper
 * half runs in Electron and this half runs in the DSH host, and importing across that line
 * would pull Electron into a process that does not have it. The two only have to agree on a
 * string, which is cheap to keep in step — and the string never reaches storage.
 */
const DRAFT_ALARM_ID = '__draft__';

export class AlarmService {
  #store;
  #bridge;
  #log;
  #scheduler;
  #disposed = false;
  /** Alarms fired but not yet dismissed, so the list can say "ringing now". */
  #ringing = new Set();
  /** Where a preview of an unsaved alarm was last dragged. Never persisted. */
  #draftPosition = null;

  /**
   * @param {object} options
   * @param {import('./store.js').StickyStore} options.store
   * @param {import('./bridge.js').StickyBridge} options.bridge
   * @param {{ info: Function, warn: Function }} options.log
   */
  constructor(options) {
    this.#store = options.store;
    this.#bridge = options.bridge;
    this.#log = options.log;

    this.#scheduler = new AlarmScheduler({
      store: this.#store,
      log: (message) => this.#log.info(message),
      fire: (alarm, info) => this.#ring(alarm, info),
    });
  }

  /** Begin watching the clock. Idempotent. */
  start() {
    if (this.#disposed) return;
    this.#scheduler.start();
  }

  /** Stop watching the clock. */
  stop() {
    this.#scheduler.stop();
  }

  /** Stop for good. */
  dispose() {
    this.#disposed = true;
    this.#scheduler.dispose();
  }

  /** Ids of alarms whose popup is on screen. */
  get ringing() {
    return [...this.#ringing];
  }

  /**
   * Run one scheduler pass immediately.
   *
   * Used at startup so an alarm that came due while DSH was closed is shown promptly rather
   * than up to a tick later, and by tests that cannot wait for a wall-clock minute.
   *
   * @param {Date} [now]
   */
  async tick(now = new Date()) {
    return this.#scheduler.tick(now);
  }

  /**
   * Show one alarm's popup.
   *
   * @param {object} alarm
   * @param {{catchUp?: boolean}} [info]
   */
  async #ring(alarm, info = {}) {
    if (this.#disposed) return;
    const result = await this.#bridge.showAlarm(alarm);
    if (result?.ok === false) {
      this.#log.warn(`sticky-notes: 闹钟「${alarm.label || alarm.id}」未能显示：${String(result.error ?? '')}`);
      return;
    }
    this.#ringing.add(alarm.id);
    const suffix = info.catchUp === true ? '（补响：到点时 DSH 未运行）' : '';
    this.#log.info(
      `sticky-notes: 便签闹钟「${alarm.label || alarm.id}」已响${suffix}｜${describeSchedule(alarm)}`,
    );
  }

  /**
   * The user closed an alarm popup.
   *
   * Recorded on the alarm so a `once` alarm stays retired and a repeating one does not
   * re-fire within the same minute.
   *
   * @param {string} id
   */
  async dismiss(id) {
    this.#ringing.delete(id);
    const alarm = this.#store.getAlarm(id);
    if (alarm === null) return { ok: false };
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    this.#store.updateAlarm(id, { lastDismissedAt: stamp });
    this.#store.flushSoon();
    this.#log.info(`sticky-notes: 便签闹钟「${alarm.label || id}」已关闭`);
    return { ok: true };
  }

  /**
   * Record where the user dragged an alarm's popup.
   *
   * This is what makes 试响 double as a position picker: the window IS the alarm, so where it
   * comes to rest is the setting. An unrecognised id (a preview of an unsaved alarm) is kept
   * in memory for the editor to read back and is not written anywhere.
   *
   * @param {string} id
   * @param {number} x
   * @param {number} y
   */
  rememberPosition(id, x, y) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return { ok: false };
    const rounded = { x: Math.round(Number(x)), y: Math.round(Number(y)) };

    const alarm = id === DRAFT_ALARM_ID ? null : this.#store.getAlarm(id);
    if (alarm === null) {
      this.#draftPosition = rounded;
      return { ok: true, draft: true, ...rounded };
    }
    this.#store.updateAlarm(id, rounded);
    this.#store.flushSoon();
    return { ok: true, draft: false, ...rounded };
  }

  /** The last position a *draft* preview was dragged to, or null. */
  get draftPosition() {
    return this.#draftPosition === null ? null : { ...this.#draftPosition };
  }

  /**
   * Show an alarm now, ignoring its schedule — the editor's 试响 button.
   *
   * Deliberately does not touch `lastFiredAt`: previewing must not consume a `once` alarm or
   * shift a repeating one's next firing. That is what makes it safe to 试响 as many times as
   * it takes to get the position right.
   *
   * @param {string} id
   */
  async preview(id) {
    const alarm = this.#store.getAlarm(id);
    if (alarm === null) return { ok: false, error: '闹钟不存在' };
    const result = await this.#bridge.showAlarm(alarm);
    if (result?.ok === false) return result;
    this.#ringing.add(id);
    return { ok: true };
  }

  /**
   * Show an alarm that has not been saved yet.
   *
   * The "new alarm" form needs 试响 as much as the editor does — arguably more, since the
   * first thing a user wants to know is where it will appear. Nothing is stored: the draft
   * goes straight to the helper and its position comes back via {@link rememberPosition}.
   *
   * @param {object} draft
   */
  async previewDraft(draft) {
    const result = await this.#bridge.showAlarmDraft(draft);
    if (result?.ok === false) return result;
    this.#ringing.add(DRAFT_ALARM_ID);
    return { ok: true };
  }

  /**
   * The list the browser renders: alarms plus their derived "when next" line.
   *
   * The next-fire estimate is computed here rather than in the browser because it depends on
   * this process's clock and timezone, and the two can disagree.
   */
  list() {
    const now = new Date();
    return this.#store.listAlarms().map((alarm) => {
      const next = nextOccurrence(alarm, now);
      return {
        ...alarm,
        scheduleText: describeSchedule(alarm),
        nextAt: next === null ? null : next.toISOString(),
        ringing: this.#ringing.has(alarm.id),
      };
    });
  }
}

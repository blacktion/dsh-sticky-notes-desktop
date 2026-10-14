/**
 * dsh-sticky-notes — the tick that decides "it is time".
 *
 * Deliberately tiny: it owns a timer and the bookkeeping that stops an alarm firing twice,
 * and it delegates everything else (showing the popup) to a callback. That split is what
 * makes the interesting part — *when* to fire — testable without a clock, a window or a
 * helper process.
 *
 * Runs in the DSH host process, so alarms fire as long as DSH is running.
 *
 * @module dsh-sticky-notes/host/alarm-scheduler
 */
import { parseLocalStamp, shouldFire } from './alarm-schedule.js';

/**
 * How often to look for due alarms (ms).
 *
 * The window `shouldFire` accepts is a whole minute, so anything comfortably under 60s
 * catches every alarm. Kept at 5s rather than 60s so an alarm is never more than a few
 * seconds late, which is the difference between "an alarm" and "a schedules task".
 */
const TICK_MS = 5000;

export class AlarmScheduler {
  #store;
  #fire;
  #log;
  #timer = null;
  #disposed = false;
  /** Ids fired in this tick, so a slow `fire` cannot be re-entered by the next tick. */
  #inFlight = new Set();

  /**
   * @param {object} options
   * @param {import('./store.js').StickyStore} options.store
   * @param {(alarm: object, info: {catchUp: boolean}) => Promise<void>|void} options.fire
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.#store = options.store;
    this.#fire = options.fire;
    this.#log = options.log ?? (() => {});
  }

  /** Start ticking. Idempotent. */
  start() {
    if (this.#disposed || this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    // The host must not be kept alive by a timer that only matters while it is running.
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
    this.#log(`便签闹钟：开始轮询（每 ${TICK_MS / 1000}s）`);
  }

  /** Stop ticking. Safe to call from a dispose path. */
  stop() {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Stop and refuse to start again. */
  dispose() {
    this.#disposed = true;
    this.stop();
  }

  /**
   * Check every alarm once and fire the ones that are due.
   *
   * Exposed (rather than only scheduled) so a test can drive time explicitly instead of
   * waiting for a wall-clock minute to come around.
   *
   * @param {Date} [now]
   * @returns {Promise<string[]>} ids that fired
   */
  async tick(now = new Date()) {
    if (this.#disposed) return [];
    const fired = [];

    for (const alarm of this.#store.listAlarms()) {
      if (this.#inFlight.has(alarm.id)) continue;
      if (!shouldFire(alarm, now)) continue;

      // A `once` alarm is past-due rather than exactly-due when its instant has already
      // gone by — the case where DSH was closed at the time.
      const catchUp = this.#isCatchUp(alarm, now);

      // Claim it before firing. `lastFiredAt` is the only thing standing between a
      // per-tick check and the same alarm firing on every tick for a whole minute.
      this.#inFlight.add(alarm.id);
      this.#store.updateAlarm(alarm.id, {
        lastFiredAt: this.#stamp(now),
        fireCount: (Number(alarm.fireCount) || 0) + 1,
      });
      this.#store.flushSoon();

      fired.push(alarm.id);
      try {
        await this.#fire(this.#store.getAlarm(alarm.id) ?? alarm, { catchUp });
      } catch (error) {
        // An alarm that cannot be shown must not stop the others, and must not be retried
        // forever: it is already marked as fired, so the next tick moves on.
        this.#log(`便签闹钟：显示「${alarm.label || alarm.id}」失败：${String(error)}`);
      } finally {
        this.#inFlight.delete(alarm.id);
      }
    }

    return fired;
  }

  /** True when the alarm's instant has already passed at `now`. */
  #isCatchUp(alarm, now) {
    if (alarm?.schedule?.kind !== 'once') return false;
    const when = parseLocalStamp(alarm.schedule.at);
    return when !== null && when.getTime() < now.getTime() - 60_000;
  }

  /**
   * A local wall-clock stamp for `lastFiredAt`.
   *
   * Local, not `toISOString`: the comparison in `shouldFire` is against local calendar
   * fields, so a UTC stamp would compare across a timezone offset and could look like a
   * different minute (or a different day) entirely.
   */
  #stamp(now) {
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
}

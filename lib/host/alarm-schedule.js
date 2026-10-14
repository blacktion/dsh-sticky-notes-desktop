/**
 * dsh-sticky-notes — when a 便签闹钟 should go off.
 *
 * Pure functions over a plain alarm record and a `Date`. No I/O, no clock of its own: the
 * caller passes the time, which is what makes "does this fire on a Saturday" answerable in
 * a test instead of only in production.
 *
 * A schedule is one of three kinds:
 *
 *   - `daily`      — every day at `time`
 *   - `weekdays`   — Monday–Friday at `time`
 *   - `once`       — a single `at` instant, then done
 *
 * @module dsh-sticky-notes/host/alarm-schedule
 */

/** Schedule kinds, in the order the UI offers them. */
export const SCHEDULE_DAILY = 'daily';
export const SCHEDULE_WEEKDAYS = 'weekdays';
export const SCHEDULE_ONCE = 'once';

export const SCHEDULE_KINDS = [SCHEDULE_DAILY, SCHEDULE_WEEKDAYS, SCHEDULE_ONCE];

/** `HH:MM`, 24-hour. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `YYYY-MM-DD`, no timezone suffix: a local wall-clock date, like the user typed it. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Is this a valid `HH:MM`?
 * @param {unknown} value
 */
export function isValidTime(value) {
  return typeof value === 'string' && TIME_PATTERN.test(value.trim());
}

/**
 * Is this a valid `YYYY-MM-DD` that exists on the calendar?
 *
 * Rejects `2026-02-30`: `Date` would happily roll that over to March, which would silently
 * change the date the user asked for.
 *
 * @param {unknown} value
 */
export function isValidDate(value) {
  const match = typeof value === 'string' ? DATE_PATTERN.exec(value.trim()) : null;
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(year, month - 1, day, 12, 0, 0, 0);
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day;
}

/**
 * `HH:MM` → `{ hours, minutes }`, or null when malformed.
 * @param {unknown} time
 */
export function parseTime(time) {
  const match = typeof time === 'string' ? TIME_PATTERN.exec(time.trim()) : null;
  if (match === null) return null;
  return { hours: Number(match[1]), minutes: Number(match[2]) };
}

/**
 * Parse a naive local timestamp (`YYYY-MM-DDTHH:MM`) into a Date, or null.
 *
 * Deliberately not `new Date(string)`: that treats a bare `YYYY-MM-DDTHH:MM` as local but
 * `YYYY-MM-DD` as **UTC**, which would shift an alarm by the timezone offset. Every field
 * is passed explicitly instead.
 *
 * @param {unknown} value
 */
export function parseLocalStamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (!isValidDate(`${match[1]}-${match[2]}-${match[3]}`)) return null;
  if (hours > 23 || minutes > 59) return null;
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

/**
 * The local minute containing `at`, as a comparable number.
 *
 * Comparing minutes rather than instants is what makes a once-alarm fire when its minute is
 * *reached* rather than only on an exact millisecond match; a tick that runs a little late
 * (or a host that was asleep) still fires it.
 *
 * @param {Date} at
 */
export function minuteKey(at) {
  return Math.floor(at.getTime() / 60000);
}

/**
 * The instant an alarm's schedule next resolves to, at or after `from`.
 *
 * @param {object} alarm
 * @param {Date} from
 * @returns {Date|null} null when nothing is pending (malformed, disabled, or already done)
 */
export function nextOccurrence(alarm, from) {
  if (alarm === null || typeof alarm !== 'object') return null;
  if (alarm.enabled === false) return null;

  const kind = alarm.schedule?.kind;

  if (kind === SCHEDULE_ONCE) {
    const when = parseLocalStamp(alarm.schedule.at);
    if (when === null) return null;
    // A once-alarm that already fired is finished, even if its instant is still ahead —
    // `lastFiredAt` is what makes "dismissed" stick. An instant already in the past is
    // still returned: it is pending until the next tick shows it, which is how an alarm
    // missed while DSH was closed is caught up rather than dropped.
    if (typeof alarm.lastFiredAt === 'string' && alarm.lastFiredAt.length > 0) return null;
    return when;
  }

  const parsed = parseTime(alarm.schedule?.time);
  if (parsed === null) return null;

  const base = new Date(from.getFullYear(), from.getMonth(), from.getDate(), parsed.hours, parsed.minutes, 0, 0);
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, parsed.hours, parsed.minutes, 0, 0);
    if (candidate.getTime() < from.getTime()) continue;
    if (kind === SCHEDULE_WEEKDAYS) {
      const day = candidate.getDay();
      if (day === 0 || day === 6) continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Should this alarm fire now?
 *
 * True when the current minute is the alarm's minute *and* it has not already fired in that
 * minute. The "already fired" check is what keeps a per-minute tick from firing the same
 * alarm sixty times.
 *
 * @param {object} alarm
 * @param {Date} now
 * @returns {boolean}
 */
export function shouldFire(alarm, now) {
  if (alarm === null || typeof alarm !== 'object') return false;
  if (alarm.enabled === false) return false;

  const kind = alarm.schedule?.kind;

  if (kind === SCHEDULE_ONCE) {
    const when = parseLocalStamp(alarm.schedule.at);
    if (when === null) return false;
    if (typeof alarm.lastFiredAt === 'string' && alarm.lastFiredAt.length > 0) return false;
    // At or past the instant: a host that was closed at the time still shows it on the next
    // tick rather than dropping it silently, which is the whole point of an alarm.
    return minuteKey(now) >= minuteKey(when);
  }

  const parsed = parseTime(alarm.schedule?.time);
  if (parsed === null) return false;
  if (kind === SCHEDULE_WEEKDAYS) {
    const day = now.getDay();
    if (day === 0 || day === 6) return false;
  }

  if (now.getHours() !== parsed.hours || now.getMinutes() !== parsed.minutes) return false;

  // Already fired during this minute?
  const last = parseLocalStamp(alarm.lastFiredAt);
  if (last !== null && minuteKey(last) === minuteKey(now)) return false;
  return true;
}

/**
 * A short human phrase for a schedule, in Chinese.
 *
 * @param {object} alarm
 * @returns {string}
 */
export function describeSchedule(alarm) {
  const kind = alarm?.schedule?.kind;
  if (kind === SCHEDULE_ONCE) {
    const when = parseLocalStamp(alarm?.schedule?.at);
    if (when === null) return '时间未设置';
    const pad = (value) => String(value).padStart(2, '0');
    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(when.getHours())}:${pad(when.getMinutes())}`;
  }
  const time = isValidTime(alarm?.schedule?.time) ? alarm.schedule.time : '--:--';
  if (kind === SCHEDULE_WEEKDAYS) return `工作日 ${time}`;
  if (kind === SCHEDULE_DAILY) return `每天 ${time}`;
  return '未设置';
}

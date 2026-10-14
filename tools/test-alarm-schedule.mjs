/**
 * dsh-sticky-notes-desktop · 便签闹钟的排期计算与存储往返（单元测试）
 *
 * 「什么时候该响」这件事没有第二次机会：闹钟不是响了没反应可以再点一次的东西，错过的
 * 时间点就是错过了。所以这一套测试把排期逻辑钉死在**明确的日期**上，而不是靠"跑一下看看
 * 现在会不会响"——后者只在当下那一刻成立，明天就不知道了。
 *
 * 覆盖三件事：
 *
 *   [1] 时间/日期解析：`HH:MM`、`YYYY-MM-DD`、本地时间戳。重点是不接受
 *       `2026-02-30` 这种"日历上不存在但 Date 会悄悄进位"的日期，以及**不把裸
 *       `YYYY-MM-DD` 当 UTC**（那会让闹钟整体偏移一个时区）。
 *
 *   [2] shouldFire：每天 / 工作日 / 一次性各自的触发条件，以及两条关键不变量：
 *         a) 同一分钟内只响一次（否则每分钟一次的 tick 会把同一个闹钟响 60 遍）；
 *         b) 一次性闹钟"到点即响、过了也响"——DSH 关着的时候错过的时间点，重开后要补上，
 *            而不是无声消失（这是闹钟区别于"定时任务"的地方）。
 *
 *   [3] 存储往返：闹钟能落盘、能读回，`schedule` 的部分更新不会把 kind 丢掉
 *       （"工作日"被悄悄改成"每天"是很容易犯又很难发现的错）。
 *
 * 用法：node tools/test-alarm-schedule.mjs
 *
 * @module dsh-sticky-notes-desktop/tools/test-alarm-schedule
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

import {
  SCHEDULE_DAILY,
  SCHEDULE_WEEKDAYS,
  SCHEDULE_ONCE,
  describeSchedule,
  isValidDate,
  isValidTime,
  minuteKey,
  nextOccurrence,
  parseLocalStamp,
  parseTime,
  shouldFire,
} from '../lib/host/alarm-schedule.js';
import { StickyStore, normalizeAlarm } from '../lib/host/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
let assertions = 0;
const failures = [];

/** Count an assertion and record the failing case. */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [通过] ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`  [失败] ${name}`);
    // Printed here as well as in the summary: when this is run through a shell that folds
    // stderr, the reason is otherwise the one thing that goes missing.
    console.error(`         ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** assert.equal + counting. */
function eq(actual, expected, message) {
  assertions += 1;
  assert.equal(actual, expected, message);
}

/** assert.deepEqual + counting. */
function deepEq(actual, expected, message) {
  assertions += 1;
  assert.deepEqual(actual, expected, message);
}

/** assert.ok + counting. */
function ok(value, message) {
  assertions += 1;
  assert.ok(value, message);
}

/** A local Date, spelled out so the test never depends on the machine's clock. */
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm, 0, 0);

/** A simple daily/weekdays alarm at `time`. */
const repeating = (kind, time) => ({ id: 'a1', enabled: true, schedule: { kind, time, at: '' } });

/** A once alarm at a local stamp. */
const onceAt = (stamp, extra = {}) => ({
  id: 'a2',
  enabled: true,
  schedule: { kind: SCHEDULE_ONCE, time: '09:00', at: stamp },
  ...extra,
});

console.log('dsh-sticky-notes-desktop · 便签闹钟排期单元测试');
console.log(`被测文件：${join(HERE, '..', 'lib', 'host', 'alarm-schedule.js')}`);
console.log(`Node：${process.version}\n`);

// ─────────────────────────────────────────────────────────────────────────────
console.log('[1] 时间与日期解析');
// ─────────────────────────────────────────────────────────────────────────────

check('HH:MM 只接受 00:00–23:59', () => {
  eq(isValidTime('00:00'), true);
  eq(isValidTime('23:59'), true);
  eq(isValidTime('9:00'), false, '必须补零，否则排序与比较都会出错');
  eq(isValidTime('24:00'), false);
  eq(isValidTime('12:60'), false);
  eq(isValidTime(''), false);
  eq(isValidTime(null), false);
  eq(isValidTime(900), false);
  deepEq(parseTime('07:05'), { hours: 7, minutes: 5 });
  eq(parseTime('7:05'), null);
  eq(parseTime(undefined), null);
});

check('YYYY-MM-DD 必须真实存在于日历上（2026-02-30 要被拒绝）', () => {
  eq(isValidDate('2026-01-31'), true);
  eq(isValidDate('2026-02-28'), true);
  eq(isValidDate('2024-02-29'), true, '闰年 2 月 29 日存在');
  eq(isValidDate('2026-02-29'), false, '非闰年没有 2 月 29 日');
  eq(isValidDate('2026-02-30'), false, 'Date 会把 2 月 30 日进位成 3 月，不能接受');
  eq(isValidDate('2026-13-01'), false);
  eq(isValidDate('2026-1-1'), false, '必须补零');
  eq(isValidDate('26-01-01'), false);
});

check('本地时间戳按本地时间解析，绝不当成 UTC', () => {
  const stamp = parseLocalStamp('2026-03-05T08:30');
  ok(stamp !== null, '合法时间戳应当解析成功');
  eq(stamp.getFullYear(), 2026);
  eq(stamp.getMonth() + 1, 3);
  eq(stamp.getDate(), 5);
  eq(stamp.getHours(), 8, '小时必须原样保留：若按 UTC 解析会整体偏移一个时区');
  eq(stamp.getMinutes(), 30);
  // 用空格分隔的写法也接受（用户手打时两种都常见）。
  const spaced = parseLocalStamp('2026-03-05 08:30');
  eq(spaced === null ? null : spaced.getHours(), 8);
  eq(parseLocalStamp('2026-02-30T08:30'), null, '不存在的日期必须拒绝');
  eq(parseLocalStamp('2026-03-05T25:00'), null);
  eq(parseLocalStamp(''), null);
  eq(parseLocalStamp(null), null);
});

check('minuteKey 把同一分钟内的任意时刻归一到同一个键', () => {
  eq(minuteKey(at(2026, 3, 5, 8, 30)), minuteKey(at(2026, 3, 5, 8, 30)));
  ok(minuteKey(at(2026, 3, 5, 8, 31)) - minuteKey(at(2026, 3, 5, 8, 30)) === 1);
  ok(minuteKey(at(2026, 3, 5, 8, 30)) !== minuteKey(at(2026, 3, 5, 8, 29)));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[2] shouldFire —— 什么时候该响');
// ─────────────────────────────────────────────────────────────────────────────

check('每天：只有到点那一分钟才响', () => {
  const alarm = repeating(SCHEDULE_DAILY, '09:00');
  eq(shouldFire(alarm, at(2026, 3, 5, 9, 0)), true, '周四是工作日，每天型当然要响');
  eq(shouldFire(alarm, at(2026, 3, 5, 9, 1)), false, '过了那一分钟就不再响');
  eq(shouldFire(alarm, at(2026, 3, 5, 8, 59)), false);
  eq(shouldFire(alarm, at(2026, 3, 5, 21, 0)), false);
  eq(shouldFire(alarm, at(2026, 3, 5, 9, 0) && at(2026, 3, 5, 9, 0)), true);
});

check('每天：周末也响', () => {
  const alarm = repeating(SCHEDULE_DAILY, '09:00');
  eq(shouldFire(alarm, at(2026, 3, 7, 9, 0)), true, '2026-03-07 是周六');
  eq(shouldFire(alarm, at(2026, 3, 8, 9, 0)), true, '2026-03-08 是周日');
});

check('工作日：周一到周五响，周六周日不响', () => {
  const alarm = repeating(SCHEDULE_WEEKDAYS, '09:00');
  // 2026-03-02 周一 … 2026-03-06 周五，2026-03-07 周六，2026-03-08 周日
  eq(new Date(2026, 2, 2, 12, 0).getDay(), 1, '前提校验：2026-03-02 应当是周一');
  eq(shouldFire(alarm, at(2026, 3, 2, 9, 0)), true, '周一');
  eq(shouldFire(alarm, at(2026, 3, 3, 9, 0)), true, '周二');
  eq(shouldFire(alarm, at(2026, 3, 4, 9, 0)), true, '周三');
  eq(shouldFire(alarm, at(2026, 3, 5, 9, 0)), true, '周四');
  eq(shouldFire(alarm, at(2026, 3, 6, 9, 0)), true, '周五');
  eq(shouldFire(alarm, at(2026, 3, 7, 9, 0)), false, '周六不响');
  eq(shouldFire(alarm, at(2026, 3, 8, 9, 0)), false, '周日不响');
});

check('一次性：到点响，而且过了也补响（DSH 关着时错过的时间点不能丢）', () => {
  const alarm = onceAt('2026-03-05T08:30');
  eq(shouldFire(alarm, at(2026, 3, 5, 8, 29)), false, '还没到');
  eq(shouldFire(alarm, at(2026, 3, 5, 8, 30)), true, '正好到点');
  eq(shouldFire(alarm, at(2026, 3, 5, 8, 31)), true, '晚一分钟仍然要响');
  eq(shouldFire(alarm, at(2026, 3, 5, 12, 0)), true, '晚几小时也要响：这是闹钟不是定时任务');
  eq(shouldFire(alarm, at(2026, 3, 6, 9, 0)), true, '第二天重开 DSH 也要补响');
});

check('一次性：响过（登记过 lastFiredAt）之后彻底不再响', () => {
  const alarm = onceAt('2026-03-05T08:30', { lastFiredAt: '2026-03-05T08:30' });
  eq(shouldFire(alarm, at(2026, 3, 5, 8, 30)), false);
  eq(shouldFire(alarm, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire(alarm, at(2026, 3, 6, 9, 0)), false);
});

check('同一分钟内只响一次（否则每分钟一跳会把闹钟响 60 遍）', () => {
  const fired = repeating(SCHEDULE_DAILY, '09:00');
  fired.lastFiredAt = '2026-03-05T09:00:00.000Z';
  // lastFiredAt 是 ISO(UTC)，这里直接给一个能被 parseLocalStamp 接受的本地写法，
  // 保证比较的是"同一分钟"而不是"同一瞬间"。
  const withLocal = repeating(SCHEDULE_DAILY, '09:00');
  withLocal.lastFiredAt = '2026-03-05T09:00';
  eq(shouldFire(withLocal, at(2026, 3, 5, 9, 0)), false, '同一分钟内不得重复触发');
  // 但第二天同一时间要照常响。
  eq(shouldFire(withLocal, at(2026, 3, 6, 9, 0)), true, '第二天同一时刻必须重新触发');
});

check('停用的闹钟一律不响', () => {
  eq(shouldFire({ ...repeating(SCHEDULE_DAILY, '09:00'), enabled: false }, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire({ ...onceAt('2026-03-05T08:30'), enabled: false }, at(2026, 3, 5, 9, 0)), false);
});

check('排期损坏时安静地不响，绝不抛异常', () => {
  eq(shouldFire(null, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire({}, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire({ schedule: null }, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire({ schedule: { kind: SCHEDULE_DAILY, time: '99:99' } }, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire({ schedule: { kind: SCHEDULE_ONCE, at: '不是时间' } }, at(2026, 3, 5, 9, 0)), false);
  eq(shouldFire(repeating(SCHEDULE_DAILY, '09:00'), new Date(Number.NaN)), false, '非法时钟不得崩');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[3] nextOccurrence —— 下一次是什么时候');
// ─────────────────────────────────────────────────────────────────────────────

check('每天：今天还没到就是今天，过了就是明天', () => {
  const alarm = repeating(SCHEDULE_DAILY, '09:00');
  const before = nextOccurrence(alarm, at(2026, 3, 5, 8, 0));
  eq(before.getDate(), 5);
  eq(before.getHours(), 9);
  const after = nextOccurrence(alarm, at(2026, 3, 5, 10, 0));
  eq(after.getDate(), 6, '过了 09:00 就顺延到明天');
  eq(after.getHours(), 9);
});

check('工作日：周五晚上问，下一次是下周一（跳过周末）', () => {
  const alarm = repeating(SCHEDULE_WEEKDAYS, '09:00');
  const next = nextOccurrence(alarm, at(2026, 3, 6, 10, 0));
  eq(new Date(2026, 2, 6, 12, 0).getDay(), 5, '前提校验：2026-03-06 应当是周五');
  eq(next.getDay(), 1, '下一次必须是周一');
  eq(next.getDate(), 9);
});

check('工作日：周末问，下一次是周一（周日晚上问的是"明天"）', () => {
  const alarm = repeating(SCHEDULE_WEEKDAYS, '09:00');
  const fromSunday = nextOccurrence(alarm, at(2026, 3, 8, 20, 0));
  eq(new Date(2026, 2, 8, 12, 0).getDay(), 0, '前提校验：2026-03-08 应当是周日');
  eq(fromSunday.getDay(), 1, '周日问，下一次必须是周一');
  eq(fromSunday.getDate(), 9, '不能落到周一之后的某天');

  const fromSaturday = nextOccurrence(alarm, at(2026, 3, 7, 20, 0));
  eq(fromSaturday.getDay(), 1, '周六问，下一次也必须是周一');
  eq(fromSaturday.getDate(), 9);
});

check('跨月：月末问，下一次正确落到下个月', () => {
  const alarm = repeating(SCHEDULE_DAILY, '09:00');
  // 2026-03-31 是周二；过了 09:00 之后下一次应当是 04-01。
  const next = nextOccurrence(alarm, at(2026, 3, 31, 10, 0));
  eq(next.getMonth() + 1, 4, '跨月必须进位到 4 月');
  eq(next.getDate(), 1);
  eq(next.getHours(), 9);
});

check('停用 / 无排期 → 没有下一次', () => {
  eq(nextOccurrence({ ...repeating(SCHEDULE_DAILY, '09:00'), enabled: false }, at(2026, 3, 5, 8, 0)), null);
  eq(nextOccurrence({ schedule: { kind: SCHEDULE_DAILY, time: 'bad' } }, at(2026, 3, 5, 8, 0)), null);
  eq(nextOccurrence(null, at(2026, 3, 5, 8, 0)), null);
});

check('一次性：没响过就有下一次，响过就没有了', () => {
  const pending = nextOccurrence(onceAt('2026-03-05T08:30'), at(2026, 3, 5, 8, 0));
  eq(pending.getHours(), 8);
  eq(pending.getMinutes(), 30);
  eq(nextOccurrence(onceAt('2026-03-05T08:30', { lastFiredAt: '2026-03-05T08:30' }), at(2026, 3, 5, 8, 0)), null);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[4] describeSchedule —— 列表里显示的那句话');
// ─────────────────────────────────────────────────────────────────────────────

check('三种排期都有一句人话', () => {
  eq(describeSchedule(repeating(SCHEDULE_DAILY, '09:00')), '每天 09:00');
  eq(describeSchedule(repeating(SCHEDULE_WEEKDAYS, '18:30')), '工作日 18:30');
  eq(describeSchedule(onceAt('2026-03-05T08:30')), '2026-03-05 08:30');
  eq(describeSchedule({ schedule: { kind: SCHEDULE_DAILY, time: 'x' } }), '每天 --:--', '坏时间也要能显示');
  eq(describeSchedule(onceAt('')), '时间未设置');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[5] 存储往返 —— 闹钟真的落盘且读得回来');
// ─────────────────────────────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), 'sticky-alarm-'));
const log = () => {};

try {
  check('normalizeAlarm 给出完整的默认值，坏输入不产生残缺记录', () => {
    const alarm = normalizeAlarm({});
    ok(typeof alarm.id === 'string' && alarm.id.length > 0, '必须有 id');
    eq(alarm.kind, 'text');
    eq(alarm.enabled, true);
    eq(alarm.schedule.kind, SCHEDULE_DAILY);
    eq(alarm.schedule.time, '09:00');
    eq(alarm.fireCount, 0);
    eq(alarm.lastFiredAt, null);
    eq(normalizeAlarm({ kind: 'image', enabled: false }).kind, 'image');
    eq(normalizeAlarm({ kind: 'whatever' }).kind, 'text', '未知 kind 一律回落 text');
    eq(normalizeAlarm({ schedule: { kind: 'weekly' } }).schedule.kind, SCHEDULE_DAILY, '未知排期回落每天');
    eq(normalizeAlarm({ fireCount: -5 }).fireCount, 0);
    eq(normalizeAlarm({ fireCount: 'x' }).fireCount, 0);
    eq(normalizeAlarm(null).kind, 'text');
  });

  check('没设位置时必须是 null，而不是被强转成 (0,0)（回归：闹钟全跑到左上角）', () => {
    // `Number(null) === 0`, so the plausible-looking guard `Number.isFinite(Number(x))` accepts
    // "absent" as the coordinate 0. That is not hypothetical: it put every alarm in the top-left
    // corner and made "centred by default" unreachable.
    eq(normalizeAlarm({}).x, null, '没有位置必须是 null（= 屏幕正中）');
    eq(normalizeAlarm({}).y, null);
    eq(normalizeAlarm({ x: null, y: null }).x, null, '显式 null 仍然是 null');
    eq(normalizeAlarm({ x: '', y: '' }).x, null, '空字符串也算"没设"');
    eq(normalizeAlarm({ x: undefined, y: undefined }).y, null);
    // But a real (0,0) is a position the user may genuinely have dragged it to.
    eq(normalizeAlarm({ x: 0, y: 0 }).x, 0, '(0,0) 可能是用户真的选过的位置，不能被当成"没设"');
    eq(normalizeAlarm({ x: 0, y: 0 }).y, 0);
    // Real positions survive, in both spellings.
    eq(normalizeAlarm({ x: 300, y: 220 }).x, 300);
    eq(normalizeAlarm({ x: '300', y: '220' }).y, 220, '字符串数字也接受');
    eq(normalizeAlarm({ x: 'abc' }).x, null, '垃圾值回落 null');
    eq(normalizeAlarm({ x: Number.NaN }).x, null);
  });

  check('新建的闹钟写入并落盘到 data.json', () => {
    const store = new StickyStore({ dir: dataDir, log });
    store.load();
    const created = store.upsertAlarm({ label: '喝水', kind: 'text', text: '该喝水了', schedule: { kind: SCHEDULE_DAILY, time: '15:00' } });
    ok(typeof created.id === 'string' && created.id.length > 0);
    eq(store.listAlarms().length, 1);
    store.flush();

    const parsed = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8'));
    ok(Array.isArray(parsed.alarms), 'data.json 必须有 alarms 数组');
    eq(parsed.alarms.length, 1);
    eq(parsed.alarms[0].label, '喝水');
    eq(parsed.alarms[0].schedule.time, '15:00');
    store.close();
  });

  check('重新装载（模拟重启 DSH）后闹钟仍在', () => {
    const store2 = new StickyStore({ dir: dataDir, log });
    store2.load();
    const alarms = store2.listAlarms();
    eq(alarms.length, 1, '重启后闹钟必须还在');
    eq(alarms[0].text, '该喝水了');
    eq(alarms[0].schedule.kind, SCHEDULE_DAILY);
    store2.close();
  });

  check('部分更新 schedule 不会把 kind 丢掉（"工作日"不能被悄悄改成"每天"）', () => {
    const store = new StickyStore({ dir: dataDir, log });
    store.load();
    const alarm = store.upsertAlarm({ label: '站会', schedule: { kind: SCHEDULE_WEEKDAYS, time: '09:30' } });
    // 只改时间。
    const patched = store.updateAlarm(alarm.id, { schedule: { time: '10:15' } });
    eq(patched.schedule.kind, SCHEDULE_WEEKDAYS, 'kind 必须保留');
    eq(patched.schedule.time, '10:15');
    // 只改 kind。
    const retyped = store.updateAlarm(alarm.id, { schedule: { kind: SCHEDULE_ONCE, at: '2026-03-05T08:30' } });
    eq(retyped.schedule.time, '10:15', 'time 也必须保留');
    eq(retyped.schedule.at, '2026-03-05T08:30');
    store.close();
  });

  check('调度器的记账字段可以写回（lastFiredAt / fireCount）', () => {
    const store = new StickyStore({ dir: dataDir, log });
    store.load();
    const alarm = store.upsertAlarm({ label: '记账' });
    const fired = store.updateAlarm(alarm.id, { lastFiredAt: '2026-03-05T09:00', fireCount: 3 });
    eq(fired.lastFiredAt, '2026-03-05T09:00');
    eq(fired.fireCount, 3);
    // 不可信字段不得进存储。
    const guarded = store.updateAlarm(alarm.id, { id: 'hacked', nope: 'x' });
    eq(guarded.id, alarm.id, 'id 不允许被 patch 改掉');
    eq('nope' in guarded, false, '未知字段不得进存储');
    ok(store.updateAlarm('不存在', { label: 'x' }) === null, '未知 id 返回 null');
    store.close();
  });

  check('删除闹钟，并且不影响便签', () => {
    const store = new StickyStore({ dir: dataDir, log });
    store.load();
    const note = store.upsertNote({ text: '便签' });
    const alarm = store.upsertAlarm({ label: '待删' });
    eq(store.deleteAlarm(alarm.id), true);
    eq(store.getAlarm(alarm.id), null);
    eq(store.deleteAlarm(alarm.id), false, '再删一次返回 false');
    eq(store.listNotes().length, 1, '便签不受影响');
    eq(store.getNote(note.id).text, '便签');
    store.close();
  });

  check('snapshot 是深拷贝，改它不会污染存储里的 schedule', () => {
    const store = new StickyStore({ dir: dataDir, log });
    store.load();
    store.upsertAlarm({ label: '拷贝' });
    const snap = store.snapshot();
    snap.alarms[0].schedule.time = '00:00';
    const live = store.listAlarms()[0];
    ok(live.schedule.time !== '00:00', `schedule 必须是深拷贝，实际 ${live.schedule.time}`);
    store.close();
  });

  check('没有 alarms 字段的旧 data.json 仍然能正常装载', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'sticky-alarm-legacy-'));
    writeFileSync(
      join(legacyDir, 'data.json'),
      JSON.stringify({ version: 1, settings: {}, notes: [{ id: 'n1', text: '老便签' }] }),
      'utf8',
    );
    const store = new StickyStore({ dir: legacyDir, log });
    store.load();
    eq(store.listNotes().length, 1, '旧便签必须还在');
    deepEq(store.listAlarms(), [], '没有 alarms 就是空列表，不是崩溃');
    store.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });

  check('损坏的 alarms 数据不会让整个存储装载失败', () => {
    const brokenDir = mkdtempSync(join(tmpdir(), 'sticky-alarm-broken-'));
    writeFileSync(
      join(brokenDir, 'data.json'),
      JSON.stringify({ version: 1, settings: {}, notes: [], alarms: 'not-an-array' }),
      'utf8',
    );
    const store = new StickyStore({ dir: brokenDir, log });
    store.load();
    deepEq(store.listAlarms(), [], '非数组的 alarms 必须被当成空');
    store.close();
    rmSync(brokenDir, { recursive: true, force: true });
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

// ─────────────────────────────────────────────────────────────────────────────
const line = '─'.repeat(62);
console.log(`\n${line}`);
console.log(`用例：${passed + failed}（通过 ${passed}，失败 ${failed}）｜断言：${assertions}`);
if (failed > 0) {
  console.log('\n失败清单：');
  for (const [index, item] of failures.entries()) {
    console.log(`  ${index + 1}. ${item.name}`);
    console.log(`     ${item.error instanceof Error ? item.error.message : String(item.error)}`);
  }
  console.log(`\n结果：失败 ${failed} 个用例 ❌`);
  process.exitCode = 1;
} else {
  console.log('结果：全部通过 ✅（退出码 0）');
  process.exitCode = 0;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMinutes,
  toHHMM,
  addDays,
  daysBetween,
  weekdayOf,
  humanDay,
  freeSlots,
  windowsForDay,
  totalMinutes,
  todayIn,
  hourIn
} from '../src/engine/clock.mjs';

test('تحويل الدقائق ذهابًا وإيابًا', () => {
  assert.equal(toMinutes('18:30'), 1110);
  assert.equal(toHHMM(1110), '18:30');
  assert.equal(toHHMM(toMinutes('00:05')), '00:05');
  assert.equal(toHHMM(1439), '23:59');
});

test('حساب الأيام يعبر حدود الشهر والسنة', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(daysBetween('2026-11-19', '2026-12-15'), 26);
  assert.equal(daysBetween('2026-12-15', '2026-11-19'), -26);
});

test('أسماء الأيام والتواريخ العربية', () => {
  assert.equal(weekdayOf('2026-11-19'), 'thursday');
  assert.match(humanDay('2026-12-15'), /دجنبر 2026/);
  assert.match(humanDay('2026-11-19'), /الخميس/);
});

test('النوافذ تُقرأ من الإعدادات حسب اليوم', () => {
  const config = {
    availability: { thursday: [['18:00', '21:30']], friday: [] }
  };
  assert.deepEqual(windowsForDay(config, '2026-11-19'), [{ start: 1080, end: 1290 }]);
  assert.deepEqual(windowsForDay(config, '2026-11-20'), []);
});

test('طرح الفترات المشغولة لا ينتج تداخلًا', () => {
  const windows = [
    { start: 1080, end: 1290 }, // 18:00–21:30
    { start: 600, end: 720 } // 10:00–12:00
  ];
  const busy = [{ start: '18:30', end: '19:00' }];
  const slots = freeSlots(windows, busy);

  assert.deepEqual(slots, [
    { start: 1080, end: 1110 },
    { start: 1140, end: 1290 },
    { start: 600, end: 720 }
  ]);
  assert.equal(totalMinutes(slots), 30 + 150 + 120);
});

test('الفترات القصيرة جدًا تُهمل', () => {
  const slots = freeSlots([{ start: 1000, end: 1010 }], []);
  assert.deepEqual(slots, []);
});

test('المنطقة الزمنية تُطبَّق على «الآن»', () => {
  const instant = new Date('2026-11-19T23:30:00Z');
  assert.equal(todayIn('UTC', instant), '2026-11-19');
  assert.equal(todayIn('Africa/Casablanca', instant), '2026-11-20'); // UTC+1
  assert.equal(hourIn('Africa/Casablanca', instant), 0);
});

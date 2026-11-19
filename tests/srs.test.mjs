import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  review,
  forgettingRisk,
  isDue,
  priorityScore,
  QUALITY,
  MAX_INTERVAL_DAYS
} from '../src/engine/srs.mjs';

const topic = { id: 't1', name: 'موضوع', difficulty: 3, minutes: 40 };

test('الحالة الابتدائية مستحقة اليوم وبلا إتقان', () => {
  const s = initialState(topic, '2026-11-19');
  assert.equal(s.mastery, 0);
  assert.equal(s.reps, 0);
  assert.equal(s.dueDate, '2026-11-19');
  assert.equal(isDue(s, '2026-11-19'), true);
});

test('المراجعة الناجحة توسّع الفاصل تدريجيًا', () => {
  let s = initialState(topic, '2026-11-19');

  s = review(s, QUALITY.GOOD, 40, '2026-11-19');
  assert.equal(s.reps, 1);
  assert.equal(s.dueDate, '2026-11-20');

  s = review(s, QUALITY.GOOD, 40, '2026-11-20');
  assert.equal(s.dueDate, '2026-11-23');

  const before = s.intervalDays;
  s = review(s, QUALITY.GOOD, 40, '2026-11-23');
  assert.ok(s.intervalDays > before, 'الفاصل يجب أن يتسع');
  assert.ok(s.intervalDays <= MAX_INTERVAL_DAYS);
  assert.ok(s.mastery > 0.4, `الإتقان تراكم: ${s.mastery}`);
});

test('التعثّر يعيد الفاصل إلى يوم ويُسجّل lapse', () => {
  let s = initialState(topic, '2026-11-19');
  s = review(s, 5, 45, '2026-11-19');
  s = review(s, 5, 45, '2026-11-20');
  const masteryBefore = s.mastery;

  s = review(s, QUALITY.AGAIN, 20, '2026-11-23');
  assert.equal(s.intervalDays, 1);
  assert.equal(s.lapses, 1);
  assert.equal(s.reps, 0);
  assert.ok(s.mastery < masteryBefore, 'الإتقان يجب أن ينخفض بعد التعثّر');
});

test('الإتقان لا يتجاوز الحدود', () => {
  let s = initialState(topic, '2026-11-19');
  for (let i = 0; i < 40; i += 1) s = review(s, 5, 60, '2026-11-19');
  assert.ok(s.mastery <= 1);
  assert.ok(s.ease <= 2.9);
  assert.ok(s.intervalDays <= MAX_INTERVAL_DAYS);
});

test('خطر النسيان يزداد مع مرور الوقت ثم يهبط بعد المراجعة', () => {
  const s = review(initialState(topic, '2026-11-01'), 4, 40, '2026-11-01');
  const soon = forgettingRisk(s, topic, '2026-11-02');
  const later = forgettingRisk(s, topic, '2026-11-09');
  assert.ok(later > soon, `${later} يجب أن يكون أكبر من ${soon}`);
  assert.ok(later <= 1 && later >= 0);
});

test('الموضوع المستحق يُراجَع مرة أخرى بعد فوات موعده', () => {
  const s = review(initialState(topic, '2026-11-01'), 4, 40, '2026-11-01');
  assert.equal(isDue(s, '2026-11-02'), true);
  assert.equal(isDue(s, '2026-10-30'), false);
});

test('الامتحان القريب يرفع الأولوية، والماضي يخفضها', () => {
  const s = initialState(topic, '2026-11-19');
  const near = priorityScore({ state: s, topic: { ...topic, examDate: '2026-11-21' }, today: '2026-11-19' });
  const far = priorityScore({ state: s, topic: { ...topic, examDate: '2027-06-01' }, today: '2026-11-19' });
  const past = priorityScore({ state: s, topic: { ...topic, examDate: '2026-11-01' }, today: '2026-11-19' });

  assert.ok(near.score > far.score);
  assert.ok(far.score > past.score);
  assert.equal(near.daysToExam, 2);
});

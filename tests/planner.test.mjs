import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, catalog } from '../src/engine/planner.mjs';
import { toMinutes } from '../src/engine/clock.mjs';

const config = {
  student: { timezone: 'Africa/Casablanca' },
  preferences: {
    blockMinutes: 45,
    breakMinutes: 10,
    maxDailyMinutes: 150,
    reviewShare: 0.4,
    interleave: true,
    examHorizonDays: 30
  },
  availability: {
    thursday: [['18:00', '21:30']],
    friday: [],
    saturday: [['09:00', '12:00']]
  },
  subjects: [
    {
      id: 'math',
      name: 'الرياضيات',
      color: '#7dd3fc',
      topics: [
        { id: 'm1', name: 'اشتقاق', difficulty: 4, minutes: 45, examDate: '2026-12-01' },
        { id: 'm2', name: 'متتاليات', difficulty: 3, minutes: 40 }
      ]
    },
    {
      id: 'prog',
      name: 'البرمجة',
      color: '#86efac',
      topics: [
        { id: 'p1', name: 'حلقات', difficulty: 2, minutes: 40, examDate: '2026-11-25' },
        { id: 'p2', name: 'دوال', difficulty: 3, minutes: 40 }
      ]
    },
    {
      id: 'eng',
      name: 'الإنجليزية',
      color: '#fca5a5',
      topics: [{ id: 'e1', name: 'مفردات', difficulty: 1, minutes: 25 }]
    }
  ]
};

const DAY = '2026-11-19'; // خميس

test('كتالوج المواضيع يضمّ المادة مع كل موضوع', () => {
  const list = catalog(config);
  assert.equal(list.length, 5);
  assert.equal(list[0].subjectName, 'الرياضيات');
});

test('الخطة تحترم سقف الدقائق والوقت المتاح', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY });
  assert.ok(plan.plannedMinutes <= 150);
  assert.ok(plan.plannedMinutes <= plan.capacityMinutes);
  assert.equal(plan.plannedMinutes, plan.blocks.reduce((s, b) => s + b.minutes, 0));
});

test('كل الجلسات داخل النوافذ وبلا تداخل', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY });
  assert.ok(plan.blocks.length > 0);

  let prevEnd = -1;
  for (const b of plan.blocks) {
    const start = toMinutes(b.start);
    const end = toMinutes(b.end);
    assert.ok(start >= 1080 && end <= 1290, `${b.start}-${b.end} خارج النافذة`);
    assert.ok(end > start);
    assert.ok(start >= prevEnd, 'يوجد تداخل بين الجلسات');
    prevEnd = end;
  }
});

test('التداخل يمنع مادتين متتاليتين', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY });
  for (let i = 1; i < plan.blocks.length; i += 1) {
    assert.notEqual(
      plan.blocks[i].subjectId,
      plan.blocks[i - 1].subjectId,
      'مادتان متتاليتان رغم توفّر بديل'
    );
  }
});

test('المواضيع غير المُدرَسة تصنَّف «تعلّم» لا مراجعة', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY });
  assert.equal(plan.learnMinutes, plan.plannedMinutes);
  assert.equal(plan.reviewMinutes, 0);
});

test('الفترات المشغولة تُستثنى من الجدولة', () => {
  const busy = [{ start: '18:00', end: '20:00' }];
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY, busy });

  for (const b of plan.blocks) {
    assert.ok(toMinutes(b.start) >= 1200, `الجلسة ${b.start} تتداخل مع الالتزام`);
  }
  assert.ok(plan.capacityMinutes < 210);
});

test('اليوم بلا نوافذ يعطي خطة فارغة مع سبب واضح', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: '2026-11-20' }); // جمعة
  assert.equal(plan.blocks.length, 0);
  assert.equal(plan.plannedMinutes, 0);
  assert.ok(plan.notes.some((n) => n.includes('لا توجد نافذة')));
});

test('الموضوع المستحق يُقدَّم على غيره', () => {
  const state = {
    topics: {
      m1: { id: 'm1', mastery: 0.8, ease: 2.3, intervalDays: 10, reps: 3, dueDate: '2026-12-05', lastReviewedAt: '2026-11-18T10:00:00Z' },
      p1: { id: 'p1', mastery: 0.2, ease: 2.0, intervalDays: 1, reps: 1, dueDate: '2026-11-01', lastReviewedAt: '2026-11-10T10:00:00Z' }
    }
  };
  const plan = buildPlan({ config, state, today: DAY });
  const ids = plan.blocks.map((b) => b.topicId);
  assert.ok(ids.includes('p1'), 'الموضوع المستحق يجب أن يُجدول');
});

test('المخطط حتمي: نفس المدخلات = نفس الخطة', () => {
  const a = buildPlan({ config, state: { topics: {} }, today: DAY });
  const b = buildPlan({ config, state: { topics: {} }, today: DAY });
  const strip = (p) => ({ ...p, generatedAt: null });
  assert.deepEqual(strip(a), strip(b));
});

test('كل جلسة تحمل سببًا مقروءًا', () => {
  const plan = buildPlan({ config, state: { topics: {} }, today: DAY });
  for (const b of plan.blocks) {
    assert.ok(b.rationale && b.rationale.length > 5, 'سبب مفقود');
  }
});

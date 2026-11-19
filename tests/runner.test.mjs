import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/engine/store.mjs';
import { tick, recordSession, snapshot, writeBusy } from '../src/engine/runner.mjs';
import { createProviders, drainOutbox } from '../src/providers/index.mjs';

function makeConfig() {
  return {
    student: { timezone: 'Africa/Casablanca', name: '' },
    preferences: { blockMinutes: 45, breakMinutes: 10, maxDailyMinutes: 120, reviewShare: 0.4, interleave: true },
    automation: {
      tickMinutes: 15,
      autoDispatch: false,
      dailyBriefHour: 7,
      weeklyReportDay: 'sunday',
      providers: { calendar: 'local', mail: 'local', notes: 'local', tasks: 'local' }
    },
    availability: {
      thursday: [['18:00', '21:30']],
      friday: [['18:00', '21:30']]
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
        topics: [{ id: 'p1', name: 'حلقات', difficulty: 2, minutes: 40, examDate: '2026-11-25' }]
      }
    ]
  };
}

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aall-test-'));
  const store = createStore(dir);
  await store.ensure();
  const config = makeConfig();
  return { dir, store, config, providers: createProviders(config) };
}

const NOW = new Date('2026-11-19T18:00:00Z'); // 19:00 في الدار البيضاء

test('النبضة تنشئ خطة مرة واحدة فقط', async () => {
  const { store, config, providers } = await setup();

  const first = await tick({ store, config, providers, now: NOW });
  assert.equal(first.day, '2026-11-19');
  assert.ok(first.created.includes('plan'));
  assert.ok(first.plan.blocks.length > 0);
  assert.equal(first.pending, 4, 'تقويم + ملاحظات + مهام + موجز');

  const second = await tick({ store, config, providers, now: NOW });
  assert.ok(second.skipped.includes('plan-exists'));
  assert.ok(second.skipped.includes('brief-already-sent'));
  assert.equal(second.enqueued.length, 0);
  assert.equal(second.pending, 4, 'لا تكرار للإجراءات');
});

test('التسليم يفرّغ الصندوق ويكتب ملفات قياسية', async () => {
  const { dir, store, config, providers } = await setup();
  await tick({ store, config, providers, now: NOW });

  const summary = await drainOutbox({ store, config, providers });
  assert.equal(summary.sent, 4);
  assert.equal(summary.failed, 0);

  const outDir = path.join(dir, 'out', '2026-11-19');
  const files = await fs.readdir(outDir);
  assert.ok(files.some((f) => f.endsWith('.ics')));
  assert.ok(files.some((f) => f.endsWith('.eml')));
  assert.ok(files.some((f) => f.endsWith('.md')));

  const ics = await fs.readFile(path.join(outDir, 'study-2026-11-19.ics'), 'utf8');
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /SUMMARY:دراسة/);

  assert.equal((await store.listPending()).length, 0);
});

test('إعادة النبضة بالقوة لا تُكرّر الأحداث في التقويم', async () => {
  const { dir, store, config, providers } = await setup();
  await tick({ store, config, providers, now: NOW });
  await tick({ store, config, providers, now: NOW, force: true });
  await tick({ store, config, providers, now: NOW, force: true });
  await drainOutbox({ store, config, providers });

  const events = JSON.parse(
    await fs.readFile(path.join(dir, 'out', '2026-11-19', 'events.json'), 'utf8')
  );
  const ids = new Set(events.map((e) => e.uid));
  assert.equal(ids.size, events.length, 'يوجد حدث مكرّر');
});

test('تسجيل جلسة يحدّث الإتقان والموعد القادم والسلسلة', async () => {
  const { store, config, providers } = await setup();
  await tick({ store, config, providers, now: NOW });

  const result = await recordSession({
    store,
    config,
    topicId: 'm1',
    quality: 4,
    minutes: 45,
    day: '2026-11-19'
  });

  assert.ok(result.session.mastery > 0);
  assert.equal(result.session.dueDate, '2026-11-20');
  assert.equal(result.streak, 1);

  const state = await store.readState();
  assert.equal(state.meta.totalSessions, 1);
  assert.equal(state.meta.totalMinutes, 45);
});

test('السلسلة تتزايد عبر الأيام وتنقطع بعد فجوة', async () => {
  const { store, config, providers } = await setup();
  await tick({ store, config, providers, now: NOW });

  await recordSession({ store, config, topicId: 'm1', quality: 4, minutes: 30, day: '2026-11-19' });
  const day2 = await recordSession({ store, config, topicId: 'm1', quality: 4, minutes: 30, day: '2026-11-20' });
  assert.equal(day2.streak, 2);

  const gap = await recordSession({ store, config, topicId: 'm1', quality: 4, minutes: 30, day: '2026-11-25' });
  assert.equal(gap.streak, 1, 'انقطاع السلسلة بعد فجوة');
});

test('الالتزامات تُستثنى من الخطة وتُحفظ', async () => {
  const { store, config, providers } = await setup();
  await writeBusy(store, '2026-11-19', [{ start: '18:00', end: '20:00', title: 'درس خصوصي' }]);

  const summary = await tick({ store, config, providers, now: NOW });
  assert.equal(summary.plan.busy.length, 1);
  for (const b of summary.plan.blocks) {
    assert.ok(b.start >= '20:00', `الجلسة ${b.start} تتداخل مع الالتزام`);
  }
});

test('الملخص يعطي لوحة التحكم كل ما تحتاجه', async () => {
  const { store, config, providers } = await setup();
  await tick({ store, config, providers, now: NOW });
  const snap = await snapshot({ store, config, providers });

  assert.equal(snap.day, '2026-11-19');
  assert.equal(snap.topics.length, 3);
  assert.equal(snap.subjects.length, 2);
  assert.ok(snap.plan.blocks.length > 0);
  assert.equal(snap.automation.streak, 0);
  assert.equal(snap.pending.length, 4);
  assert.equal(snap.providers.calendar, 'local');
});

test('موضوع بلا معرّف في الحالة يحصل على حالة افتراضية', async () => {
  const { store, config, providers } = await setup();
  const state = await store.readState();
  state.topics = {};
  await store.writeState(state);

  const summary = await tick({ store, config, providers, now: NOW });
  assert.ok(summary.created.includes('initialized-topic-states'));
  assert.equal(Object.keys(summary.state.topics).length, 3);
});

test('نوع الإجراء المجهول يُرفض بوضوح', async () => {
  const { store, config, providers } = await setup();
  await store.enqueue({ kind: 'unknown.thing', day: '2026-11-19' });
  const summary = await drainOutbox({ store, config, providers });
  assert.equal(summary.failed, 1);
  assert.match(summary.results[0].error, /غير معروف/);
});

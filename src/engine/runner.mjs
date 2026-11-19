/**
 * runner.mjs — «نبضة» النظام: كل ما يحدث تلقائيًا يحدث هنا.
 *
 * التصميم حول فكرة واحدة: النبضة (tick) متكرّرة وآمنة (idempotent).
 * يمكن استدعاؤها كل 15 دقيقة، أو كل ساعة، أو يدويًا، أو من GitHub Actions —
 * والنتيجة نفسها في كل مرة، دون تكرار إجراء أو إرسال بريد مرتين.
 *
 * العلامات المستخدمة للحماية من التكرار:
 *   meta.planCreatedFor  ← تاريخ آخر خطة مُنشأة
 *   meta.briefSentFor    ← تاريخ آخر موجز صباحي
 *   meta.reportSentFor   ← أسبوع آخر تقرير
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { todayIn, hourIn, weekdayOf, weekKey, addDays, isDay, humanDay } from './clock.mjs';
import { buildPlan, catalog } from './planner.mjs';
import { initialState, review, isDue } from './srs.mjs';
import { defaultState } from './store.mjs';
import { briefMarkdown, briefHtml, notesMarkdown, tasksFor, weeklyReport, reportMarkdown } from './content.mjs';
import { drainOutbox } from '../providers/index.mjs';

const REPORT_DAYS = 7;

/** فترات مشغولة خارجية (من التقويم). ملف بسيط حتى تعمل بقية المكوّنات دونه. */
export async function readBusy(store, day) {
  const file = path.join(store.paths.base, 'busy', `${day}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((b) => b && b.start && b.end) : [];
  } catch {
    return [];
  }
}

export async function writeBusy(store, day, busy) {
  const dir = path.join(store.paths.base, 'busy');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${day}.json`), JSON.stringify(busy, null, 2), 'utf8');
}

/** يتأكد أن كل موضوع في الإعدادات له حالة، دون المساس بالحالات القائمة. */
export function ensureTopicStates(state, config, day) {
  let changed = false;
  for (const topic of catalog(config)) {
    if (!state.topics[topic.id]) {
      state.topics[topic.id] = initialState(topic, day);
      changed = true;
    }
  }
  return changed;
}

function isStreakAlive(state, day) {
  const last = state.meta?.lastStudyDay;
  if (!isDay(last)) return false;
  return last === day || last === addDays(day, -1);
}

export function updateStreak(state, day) {
  const last = state.meta?.lastStudyDay;
  if (last === day) return state.meta?.streakDays || 0;
  if (last === addDays(day, -1)) {
    state.meta.streakDays = (state.meta?.streakDays || 0) + 1;
  } else {
    state.meta.streakDays = 1;
  }
  state.meta.lastStudyDay = day;
  return state.meta.streakDays;
}

/** تسجيل جلسة دراسية (يُستدعى من لوحة التحكم أو من CLI). */
export async function recordSession({ store, config, topicId, quality, minutes, day, now = new Date() }) {
  const state = await store.readState();
  const catalogList = catalog(config);
  const topic = catalogList.find((t) => t.id === topicId);
  if (!topic) throw new Error(`موضوع غير معروف: ${topicId}`);

  const current = state.topics[topicId] || initialState(topic, day);
  state.topics[topicId] = review(current, quality, minutes, day);

  state.meta.totalMinutes = (state.meta?.totalMinutes || 0) + Math.max(1, Math.round(minutes));
  state.meta.totalSessions = (state.meta?.totalSessions || 0) + 1;
  const streak = updateStreak(state, day);

  await store.writeState(state);
  await store.logAction(day, {
    type: 'session',
    topicId,
    topicName: topic.name,
    subjectName: topic.subjectName,
    quality: Number(quality),
    minutes: Math.round(minutes),
    mastery: state.topics[topicId].mastery,
    nextDue: state.topics[topicId].dueDate
  });

  return { state, topic, session: state.topics[topicId], streak, at: now.toISOString() };
}

/**
 * النبضة الكاملة. تُعيد ملخّصًا بما فعلته (أو لم تفعله ولماذا).
 */
export async function tick({ store, config, providers, now = new Date(), force = false, dispatch }) {
  await store.ensure();
  const tz = config?.student?.timezone || 'UTC';
  const day = todayIn(tz, now);
  const hour = hourIn(tz, now);
  const summary = {
    day,
    humanDay: humanDay(day),
    created: [],
    skipped: [],
    enqueued: [],
    dispatch: null,
    warnings: []
  };

  const state = await store.readState();
  const fresh = !state.meta?.lastTickAt;
  state.meta ||= defaultState().meta;

  if (ensureTopicStates(state, config, day)) {
    summary.created.push('initialized-topic-states');
  }

  // ---- 1) خطة اليوم ----
  let plan = await store.readPlan(day);
  const needPlan = force || !plan || state.meta.planCreatedFor !== day;

  if (needPlan) {
    const busy = await readBusy(store, day);
    plan = buildPlan({ config, state, today: day, busy });
    await store.writePlan(day, plan);
    state.meta.planCreatedFor = day;
    summary.created.push('plan');

    // نضع إجراءات التسليم في الصندوق الصادر (مرة واحدة في اليوم).
    if (plan.blocks.length) {
      summary.enqueued.push(
        await store.enqueue({
          kind: 'calendar.block',
          day,
          blocks: plan.blocks,
          note: 'جلسات دراسة مولّدة آليًا'
        })
      );

      summary.enqueued.push(
        await store.enqueue({
          kind: 'notes.page',
          day,
          slug: `plan-${day}`,
          title: `خطة ${day}`,
          markdown: notesMarkdown({ plan, state, config, catalog: catalog(config) })
        })
      );

      summary.enqueued.push(
        await store.enqueue({
          kind: 'tasks.batch',
          day,
          tasks: tasksFor(plan)
        })
      );
    }
  } else {
    summary.skipped.push('plan-exists');
  }

  // ---- 2) الموجز اليومي ----
  const briefDue = hour >= (config?.automation?.dailyBriefHour ?? 7);
  if (briefDue && state.meta.briefSentFor !== day) {
    const to = config?.automation?.email || process.env.AALL_EMAIL || 'me@local';
    const subject = `خطة ${humanDay(day)} · ${plan.plannedMinutes} دقيقة في ${plan.blocks.length} جلسات`;
    summary.enqueued.push(
      await store.enqueue({
        kind: 'mail.brief',
        day,
        slug: `brief-${day}`,
        to,
        subject,
        text: briefMarkdown({ plan, state, config, streak: state.meta.streakDays || 0 }),
        html: briefHtml({ plan, config, streak: state.meta.streakDays || 0 })
      })
    );
    state.meta.briefSentFor = day;
    summary.created.push('daily-brief');
  } else {
    summary.skipped.push(briefDue ? 'brief-already-sent' : 'before-brief-hour');
  }

  // ---- 3) التقرير الأسبوعي ----
  const reportDay = config?.automation?.weeklyReportDay || 'sunday';
  const wk = weekKey(day);
  if (weekdayOf(day) === reportDay && state.meta.reportSentFor !== wk) {
    const { report, markdown: md } = await generateWeeklyReport({ store, config, day, name: `week-${wk}` });

    summary.enqueued.push(
      await store.enqueue({
        kind: 'mail.report',
        day,
        slug: `report-${wk}`,
        to: report?.to || config?.automation?.email || process.env.AALL_EMAIL || 'me@local',
        subject: `تقرير الأسبوع ${wk} · ${report.hours} ساعة دراسة`,
        text: md
      })
    );
    state.meta.reportSentFor = wk;
    summary.created.push('weekly-report');
  }

  // ---- 4) التسليم ----
  const shouldDispatch = dispatch ?? (config?.automation?.autoDispatch === true);
  if (shouldDispatch && summary.enqueued.length) {
    summary.dispatch = await drainOutbox({ store, config, providers });
  }

  state.meta.lastTickAt = now.toISOString();
  await store.writeState(state);
  await store.logAction(day, {
    type: 'tick',
    fresh,
    created: summary.created,
    skipped: summary.skipped,
    enqueued: summary.enqueued.length,
    dispatched: summary.dispatch?.sent ?? 0
  });

  summary.plan = plan;
  summary.state = state;
  summary.pending = (await store.listPending()).length;
  return summary;
}

async function collectDays(store, day, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = addDays(day, -i);
    const entries = await store.readLog(d);
    const plan = await store.readPlan(d);
    out.push({
      day: d,
      plan,
      sessions: entries.filter((e) => e.type === 'session')
    });
  }
  return out;
}

/** حالة مجمّعة للوحة التحكم. */
export async function snapshot({ store, config, providers }) {
  const tz = config?.student?.timezone || 'UTC';
  const day = todayIn(tz);
  const state = await store.readState();
  const plan = await store.readPlan(day);
  const pending = await store.listPending();
  const log = await store.readLog(day);
  const items = catalog(config);

  const topics = items.map((t) => {
    const st = state.topics?.[t.id] || initialState(t, day);
    return {
      ...t,
      mastery: Number((st.mastery || 0).toFixed(3)),
      ease: Number((st.ease || 2.3).toFixed(2)),
      intervalDays: st.intervalDays || 0,
      reps: st.reps || 0,
      lapses: st.lapses || 0,
      minutes: st.minutes || 0,
      dueDate: st.dueDate,
      due: isDue(st, day),
      lastReviewedAt: st.lastReviewedAt
    };
  });

  return {
    day,
    humanDay: humanDay(day),
    timezone: tz,
    student: config?.student || {},
    plan,
    topics,
    subjects: (config?.subjects || []).map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      topics: topics.filter((t) => t.subjectId === s.id)
    })),
    meta: state.meta,
    pending: pending.map((p) => ({ id: p.id, kind: p.kind, createdAt: p.createdAt, attempts: p.attempts || 0 })),
    todaySessions: log.filter((e) => e.type === 'session'),
    providers: providers?.mapping || config?.automation?.providers,
    automation: {
      tickMinutes: config?.automation?.tickMinutes ?? 15,
      autoDispatch: config?.automation?.autoDispatch === true,
      dailyBriefHour: config?.automation?.dailyBriefHour ?? 7,
      lastTickAt: state.meta?.lastTickAt || null,
      streak: state.meta?.streakDays || 0,
      streakAlive: isStreakAlive(state, day),
      totalMinutes: state.meta?.totalMinutes || 0,
      totalSessions: state.meta?.totalSessions || 0
    }
  };
}

/**
 * توليد تقرير أسبوعي وحفظه (JSON + Markdown).
 * مستخدم من النبضة، ومن CLI، ومن لوحة التحكم — مصدر واحد للحقيقة.
 */
export async function generateWeeklyReport({ store, config, day, name }) {
  const days = await collectDays(store, day, REPORT_DAYS);
  const state = await store.readState();
  const key = name || `week-${weekKey(day)}`;
  const report = weeklyReport({ days, state, config, catalog: catalog(config), day });
  const markdown = reportMarkdown(report, { config });

  await store.writeReport(key, report);
  await fs.mkdir(store.paths.reports, { recursive: true });
  await fs.writeFile(path.join(store.paths.reports, `${key}.md`), markdown, 'utf8');

  return { report, markdown, key };
}

/**
 * planner.mjs — من «ماذا أعرف» إلى «ماذا أفعل اليوم، وفي أي ساعة».
 *
 * المخطط لا يوزّع الوقت بالتساوي، بل يوازن بين ثلاثة ضغوط:
 *   1) خطر النسيان   — ما بدأ يتسرّب من الذاكرة.
 *   2) فجوة الإتقان  — ما لم يُتقن أصلًا.
 *   3) ضغط الامتحان  — ما اقترب موعده.
 * ثم يفرض قيدين عمليين: الوقت المتاح فعلًا بعد الالتزامات، وقاعدة التداخل
 * (لا موضوعان من نفس المادة متتاليًا) حتى لا يحدث تعلّم سطحي.
 *
 * الدالة نقية بلا قراءة ملفات ولا شبكة: تُمرَّر لها الحالة فتعيد خطة.
 */

import {
  freeSlots,
  totalMinutes,
  toHHMM,
  windowsForDay,
  weekdayAr,
  humanDay,
  daysBetween,
  isDay
} from './clock.mjs';
import { initialState, isDue, priorityScore, daysToExam } from './srs.mjs';

export const MIN_BLOCK = 15;
export const MAX_BLOCK = 90;

/** تفكيك الإعدادات إلى قائمة مواضيع مسطّحة مع مادتها. */
export function catalog(config) {
  const out = [];
  for (const subject of config?.subjects || []) {
    for (const topic of subject.topics || []) {
      out.push({
        ...topic,
        subjectId: subject.id,
        subjectName: subject.name,
        color: subject.color || '#7dd3fc'
      });
    }
  }
  return out;
}

function stateFor(state, topic, today) {
  return state?.topics?.[topic.id] || initialState(topic, today);
}

/** دوال مساعدة للاختيار: نحمي من تكرار نفس المادة في بلوكين متتاليين. */
function pickNext(pool, lastSubjectId, interleave) {
  if (!pool.length) return null;
  if (!interleave || !lastSubjectId) return pool.shift();
  const idx = pool.findIndex((c) => c.topic.subjectId !== lastSubjectId);
  if (idx === -1) return pool.shift();
  const [chosen] = pool.splice(idx, 1);
  return chosen;
}

function rationaleFor({ topic, meta, state, today }) {
  const parts = [];
  if (meta.daysToExam !== null && meta.daysToExam >= 0 && meta.daysToExam <= 30) {
    parts.push(`الامتحان بعد ${meta.daysToExam} يوم`);
  }
  if (state.reps === 0) parts.push('أول تعرّف على الموضوع');
  else if (meta.risk >= 0.6) parts.push(`خطر نسيان مرتفع (${Math.round(meta.risk * 100)}%)`);
  else if (state.lapses > 0 && state.streak === 0) parts.push('إعادة بناء بعد تعثّر');
  else if (meta.gap >= 0.6) parts.push('الإتقان ما زال ضعيفًا');
  else parts.push(`مراجعة دورية بعد ${daysBetween(today, today)} يوم فاصل ${state.intervalDays}`);

  if (topic.difficulty >= 4) parts.push('موضوع ثقيل يحتاج تركيزًا');
  return parts.filter(Boolean).join(' · ');
}

/**
 * بناء خطة يوم كامل.
 *
 * @param {object} opts
 * @param {object} opts.config إعدادات الدراسة
 * @param {object} opts.state  الحالة العامة (topics)
 * @param {string} opts.today  YYYY-MM-DD
 * @param {Array<{start:string,end:string,title?:string}>} [opts.busy] فترات مشغولة
 */
export function buildPlan({ config, state, today, busy = [] }) {
  if (!isDay(today)) throw new Error(`تاريخ غير صالح: ${today}`);

  const prefs = config?.preferences || {};
  const blockMinutes = clampNumber(prefs.blockMinutes, 20, MAX_BLOCK, 45);
  const breakMinutes = clampNumber(prefs.breakMinutes, 0, 30, 10);
  const maxDaily = clampNumber(prefs.maxDailyMinutes, 20, 600, 150);
  const reviewShare = clampNumber(prefs.reviewShare, 0, 1, 0.4);
  const interleave = prefs.interleave !== false;
  const horizon = clampNumber(prefs.examHorizonDays, 1, 120, 30);

  const windows = windowsForDay(config, today);
  const slots = freeSlots(windows, busy);
  const capacity = totalMinutes(slots);
  const budget = Math.min(maxDaily, capacity);

  // طول الجلسة الفعلي: نوزّع الميزانية على عدد جلسات صحيح بدل ترك
  // «بقية» قصيرة في آخر اليوم (45+45+45+15 أسوأ من 4×38).
  const evenBlocks = Math.max(1, Math.ceil(budgetOr(maxDaily, slots) / blockMinutes));
  const effectiveBlock = Math.min(
    blockMinutes,
    Math.max(MIN_BLOCK, Math.round(budgetOr(maxDaily, slots) / evenBlocks))
  );


  const items = catalog(config).map((topic) => {
    const st = stateFor(state, topic, today);
    const meta = priorityScore({ state: st, topic, today, examHorizonDays: horizon });
    return { topic, state: st, meta, due: isDue(st, today) };
  });

  const byId = (a, b) =>
    b.meta.score - a.meta.score || String(a.topic.id).localeCompare(String(b.topic.id));

  const duePool = items.filter((i) => i.due).sort(byId);
  const newPool = items.filter((i) => !i.due).sort(byId);

  const blocks = [];
  let remaining = budget;
  let lastSubjectId = null;
  let timeCursor = null;

  const dueBudget = Math.round(budget * reviewShare);
  let dueSpent = 0;

  // 1) حصّة المراجعات المستحقة أولًا.
  const queue = [];
  const dueQueue = [...duePool];
  while (dueQueue.length && dueSpent < dueBudget) {
    const cand = pickNext(dueQueue, lastSubjectId, interleave);
    if (!cand) break;
    const size = Math.min(effectiveBlock, cand.topic.minutes || effectiveBlock, remaining);
    if (size < MIN_BLOCK) break;
    queue.push({ ...cand, size, kind: kindOf(cand) });
    dueSpent += size;
    remaining -= size;
    lastSubjectId = cand.topic.subjectId;
  }

  // 2) بقية الوقت: الأهم من المراجعات المتبقية + المواضيع الجديدة، بالتداخل.
  const restPool = [...dueQueue, ...newPool].sort(byId);
  lastSubjectId = queue.length ? queue[queue.length - 1].topic.subjectId : null;
  while (remaining >= MIN_BLOCK && restPool.length) {
    const cand = pickNext(restPool, lastSubjectId, interleave);
    if (!cand) break;
    const size = Math.min(effectiveBlock, cand.topic.minutes || effectiveBlock, remaining);
    if (size < MIN_BLOCK) break;
    queue.push({ ...cand, size, kind: kindOf(cand) });
    remaining -= size;
    lastSubjectId = cand.topic.subjectId;
  }

  // 3) التوزيع على الساعات المتاحة فعليًا.
  let slotIndex = 0;
  let slotCursor = slots.length ? slots[0].start : 0;

  for (const item of queue) {
    let placed = false;
    while (slotIndex < slots.length) {
      const slot = slots[slotIndex];
      const start = Math.max(slotCursor, slot.start);
      const end = start + item.size;
      if (end <= slot.end) {
        blocks.push({
          index: blocks.length + 1,
          topicId: item.topic.id,
          topicName: item.topic.name,
          subjectId: item.topic.subjectId,
          subjectName: item.topic.subjectName,
          color: item.topic.color,
          kind: item.kind,
          day: today,
          start: toHHMM(start),
          end: toHHMM(end),
          minutes: item.size,
          risk: item.meta.risk,
          mastery: Number((item.state.mastery || 0).toFixed(3)),
          daysToExam: item.meta.daysToExam,
          rationale: rationaleFor({
            topic: item.topic,
            meta: item.meta,
            state: item.state,
            today
          })
        });
        lastSubjectId = item.topic.subjectId;
        timeCursor = end + breakMinutes;
        slotCursor = end + breakMinutes;
        placed = true;
        break;
      }
      // انتقل إلى النافذة التالية.
      slotIndex += 1;
      if (slotIndex < slots.length) slotCursor = slots[slotIndex].start;
    }
    if (!placed) break;
  }

  const scheduledIds = new Set(blocks.map((b) => b.topicId));
  const skipped = items
    .filter((i) => !scheduledIds.has(i.topic.id))
    .sort((a, b) => b.meta.score - a.meta.score)
    .map((i) => ({
      topicId: i.topic.id,
      topicName: i.topic.name,
      subjectName: i.topic.subjectName,
      risk: i.meta.risk,
      due: i.due,
      reason: slots.length === 0 ? 'لا يوجد وقت متاح اليوم' : 'لم يتّسع له الوقت المتاح'
    }));

  const exams = catalog(config)
    .filter((t) => isDay(t.examDate) && daysBetween(today, t.examDate) >= 0)
    .sort((a, b) => a.examDate.localeCompare(b.examDate))
    .map((t) => ({
      topicId: t.id,
      topicName: t.name,
      subjectName: t.subjectName,
      examDate: t.examDate,
      daysLeft: daysBetween(today, t.examDate)
    }));

  const focus = [...items]
    .sort((a, b) => b.meta.risk - a.meta.risk)
    .slice(0, 3)
    .map((i) => ({
      topicId: i.topic.id,
      topicName: i.topic.name,
      subjectName: i.topic.subjectName,
      risk: i.meta.risk,
      mastery: Number((i.state.mastery || 0).toFixed(3))
    }));

  return {
    version: 1,
    day: today,
    weekday: weekdayAr(today),
    humanDay: humanDay(today),
    generatedAt: new Date().toISOString(),
    capacityMinutes: capacity,
    budgetMinutes: budget,
    plannedMinutes: blocks.reduce((s, b) => s + b.minutes, 0),
    reviewMinutes: blocks.filter((b) => b.kind === 'review').reduce((s, b) => s + b.minutes, 0),
    learnMinutes: blocks.filter((b) => b.kind === 'learn').reduce((s, b) => s + b.minutes, 0),
    blocks,
    skipped,
    exams,
    focus,
    busy,
    windows,
    slots,
    notes: buildNotes({ blocks, slots, capacity, items })
  };
}

function buildNotes({ blocks, slots, capacity, items }) {
  const notes = [];
  if (!slots.length) {
    notes.push('لا توجد نافذة متاحة اليوم: إمّا أن اليوم مشغول بالكامل أو أنه يوم راحة.');
    return notes;
  }
  if (capacity < 45) notes.push('الوقت المتاح قصير اليوم؛ الأولوية للمراجعات الأكثر خطرًا فقط.');
  const due = items.filter((i) => i.due).length;
  if (due > blocks.length) {
    notes.push(`يوجد ${due} موضوعًا مستحقًا و${blocks.length} فقط اتّسع لها الوقت — ستُقدَّم غدًا.`);
  }
  const heavy = blocks.filter((b) => b.daysToExam !== null && b.daysToExam <= 7);
  if (heavy.length) {
    notes.push(`ضغط امتحانات هذا الأسبوع: ${heavy.length} جلسات لمواضيع امتحانها قريب.`);
  }
  if (!notes.length) notes.push('الخطة متوازنة: مراجعة + تعلّم جديد + تداخل بين المواد.');
  return notes;
}

/**
 * التصنيف يتبع حالة الموضوع لا موعده: الموضوع الذي لم يُدرس بعد
 * (reps = 0) هو «تعلّم جديد» ولو كان مستحقًا؛ هذا يمنع تسمية كل شيء مراجعة.
 */
function kindOf(cand) {
  return (cand.state.reps || 0) === 0 ? 'learn' : 'review';
}

function budgetOr(maxDaily, slots) {
  return Math.min(maxDaily, totalMinutes(slots));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * srs.mjs — جدولة التكرار المتباعد (نسخة SM-2 مبسّطة ومعدّلة للدراسة).
 *
 * لماذا لا نستخدم SM-2 الخام؟
 *  - SM-2 يعمل على "بطاقات" ويقيس الاسترجاع فقط، بينما هنا الوحدة هي «موضوع»
 *    له مدة دراسة وأهمية وامتحان. لذلك نضيف: إتقانًا متدرّجًا (mastery)،
 *    ونسيانًا يعتمد على الزمن (forgetting risk)، ووزنًا للصعوبة.
 *  - نتجنّب القفزات العنيفة في الفاصل الزمني: السقف 60 يومًا داخل السدس.
 *
 * كل الدوال نقية (pure): تأخذ الحالة وتعيد حالة جديدة، بلا آثار جانبية.
 * هذا ما يجعل النظام قابلًا للاختبار وللإعادة الحساب بأمان.
 */

import { addDays, daysBetween, isDay } from './clock.mjs';

export const QUALITY = {
  AGAIN: 1,
  HARD: 3,
  GOOD: 4,
  EASY: 5
};

export const EASE_MIN = 1.3;
export const EASE_MAX = 2.9;
export const EASE_START = 2.3;
export const MAX_INTERVAL_DAYS = 60;

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** الحالة الابتدائية لموضوع لم يُدرَس بعد. */
export function initialState(topic, today) {
  return {
    id: topic.id,
    mastery: 0,
    ease: EASE_START,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    streak: 0,
    minutes: 0,
    dueDate: today,
    lastReviewedDay: null,
    lastReviewedAt: null,
    createdAt: today,
    history: []
  };
}

/**
 * تحديث حالة موضوع بعد جلسة دراسة.
 *
 * @param {object} state  الحالة الحالية
 * @param {number} quality جودة الاسترجاع 1..5
 * @param {number} minutes الدقائق التي استُغرقت فعليًا
 * @param {string} today   تاريخ اليوم YYYY-MM-DD
 */
export function review(state, quality, minutes, today) {
  const q = clamp(Number(quality) || 0, 1, 5);
  const spent = Math.max(1, Math.round(Number(minutes) || 0));
  const prev = { ...state };

  let { ease, intervalDays, reps, lapses, streak, mastery } = prev;
  ease = Number.isFinite(ease) ? ease : EASE_START;
  intervalDays = Number.isFinite(intervalDays) ? intervalDays : 0;
  reps = Number.isFinite(reps) ? reps : 0;
  lapses = Number.isFinite(lapses) ? lapses : 0;
  streak = Number.isFinite(streak) ? streak : 0;
  mastery = clamp(Number.isFinite(mastery) ? mastery : 0, 0, 1);

  const failed = q < 3;

  if (failed) {
    // فشل الاسترجاع: نعود إلى فاصل قصير جدًا ونعيد بناء الإتقان ببطء.
    lapses += 1;
    reps = 0;
    streak = 0;
    intervalDays = 1;
    ease = clamp(ease - 0.2, EASE_MIN, EASE_MAX);
  } else {
    reps += 1;
    streak += 1;
    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 3;
    else intervalDays = clamp(Math.round(Math.max(1, intervalDays) * ease), 1, MAX_INTERVAL_DAYS);

    // تعديل SM-2 القياسي، لكن بميل ألطف حتى لا ينفجر الفاصل الزمني.
    const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
    ease = clamp(ease + delta * 0.9, EASE_MIN, EASE_MAX);

    // مكافأة الجلسات الطويلة: 45 دقيقة ترسّخ أكثر من 10 دقائق.
    const effortBonus = clamp(spent / 90, 0, 0.6);
    intervalDays = clamp(Math.round(intervalDays * (1 + effortBonus * 0.25)), 1, MAX_INTERVAL_DAYS);
  }

  // الإتقان: متوسط متحرك أسّي يتجاهل الجلسات القصيرة جدًا.
  const weight = clamp(0.18 + spent / 150, 0.18, 0.6);
  const target = q / 5;
  mastery = clamp(mastery + (target - mastery) * weight, 0, 1);
  if (failed) mastery = clamp(mastery * 0.75, 0, 1);

  return {
    ...prev,
    id: prev.id,
    mastery,
    ease,
    intervalDays,
    reps,
    lapses,
    streak,
    minutes: (prev.minutes || 0) + spent,
    dueDate: addDays(today, intervalDays),
    // التاريخ يُشتق من اليوم الممرَّر لا من ساعة الحائط، حتى تكون الدالة نقية
    // وقابلة للاختبار ولإعادة الحساب التاريخي.
    lastReviewedDay: today,
    lastReviewedAt: `${today}T00:00:00.000Z`,
    history: [
      ...(prev.history || []).slice(-59),
      { date: today, quality: q, minutes: spent, mastery: Number(mastery.toFixed(3)) }
    ]
  };
}

/**
 * خطر النسيان الآن: 0 = راسخ، 1 = على وشك الضياع.
 * يعتمد على نسبة الزمن المنقضي من الفاصل الزمني، ويُعدّل بالصعوبة والإتقان.
 */
export function forgettingRisk(state, topic, today) {
  const mastery = clamp(state?.mastery ?? 0, 0, 1);
  const interval = Math.max(1, state?.intervalDays || 0);
  const last =
    state?.lastReviewedDay ||
    (state?.lastReviewedAt ? String(state.lastReviewedAt).slice(0, 10) : null);
  const base = last && isDay(last) ? daysBetween(last, today) : interval;

  const ratio = Math.max(0, base) / interval;
  const difficulty = clamp((topic?.difficulty || 3) / 5, 0.2, 1);

  // منحنى نسيان أُسّي: R = exp(-k·t/S) مقلوبًا.
  const decay = 1 - Math.exp(-1.2 * ratio);
  const risk = clamp(decay * (0.55 + 0.45 * difficulty) * (1.15 - 0.5 * mastery), 0, 1);
  return Number(risk.toFixed(3));
}

/** هل موضوع مستحق للمراجعة اليوم؟ */
export function isDue(state, today) {
  if (!state?.dueDate || !isDay(state.dueDate)) return true;
  return daysBetween(today, state.dueDate) <= 0;
}

/** أيام متبقية قبل الامتحان (سالب إذا مضى). */
export function daysToExam(topic, today) {
  if (!topic?.examDate || !isDay(topic.examDate)) return null;
  return daysBetween(today, topic.examDate);
}

/**
 * درجة الاستحقاق: تُستخدم لترتيب الأولويات في المخطط.
 * كل الحدود مضبوطة صراحةً، لا توجد أرقام سحرية مخفية.
 */
export function priorityScore({ state, topic, today, examHorizonDays = 30 }) {
  const risk = forgettingRisk(state, topic, today);
  const gap = 1 - clamp(state?.mastery ?? 0, 0, 1);
  const difficulty = clamp((topic?.difficulty || 3) / 5, 0.2, 1);
  const left = daysToExam(topic, today);

  let urgency = 1;
  if (left !== null) {
    if (left < 0) urgency = 0.15; // امتحان مضى: نخفّض بشدة
    else if (left <= examHorizonDays) urgency = 1 + 1.8 * Math.pow(1 - left / examHorizonDays, 1.6);
    else urgency = 0.9;
  }

  const base = 0.45 * risk + 0.35 * gap + 0.2 * difficulty;
  return {
    score: Number((base * urgency).toFixed(4)),
    risk,
    gap,
    difficulty,
    urgency: Number(urgency.toFixed(3)),
    daysToExam: left
  };
}

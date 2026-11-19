/**
 * clock.mjs — أدوات الزمن بدون أي مكتبات خارجية.
 *
 * كل الحسابات الداخلية تجري على تواريخ نصية بالصيغة YYYY-MM-DD (تقويم مدني،
 * بلا مناطق زمنية)، والمنطقة الزمنية تُستخدم فقط عند قراءة "الآن" وعند العرض.
 * هذا يمنع أخطاء الساعة الصيفية وأخطاء الحدود عند منتصف الليل.
 */

export const DAY_MS = 86_400_000;

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
];

const AR_WEEKDAYS = {
  sunday: 'الأحد',
  monday: 'الاثنين',
  tuesday: 'الثلاثاء',
  wednesday: 'الأربعاء',
  thursday: 'الخميس',
  friday: 'الجمعة',
  saturday: 'السبت'
};

const AR_MONTHS = [
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'ماي',
  'يونيو',
  'يوليوز',
  'غشت',
  'شتنبر',
  'أكتوبر',
  'نونبر',
  'دجنبر'
];

/** تاريخ اليوم في منطقة زمنية معيّنة، بصيغة YYYY-MM-DD. */
export function todayIn(timeZone = 'UTC', now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(now);
}

/** الساعة الحالية (0-23) في منطقة زمنية معيّنة. */
export function hourIn(timeZone = 'UTC', now = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      hour12: false
    }).format(now)
  );
}

/** تحويل YYYY-MM-DD إلى كائن Date عند منتصف الليل UTC (لأغراض الفروق فقط). */
export function parseDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** إضافة عدد أيام إلى تاريخ نصي. */
export function addDays(day, n) {
  const dt = parseDay(day);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** عدد الأيام من a إلى b (b - a). */
export function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS);
}

export function weekdayOf(day) {
  return WEEKDAYS[parseDay(day).getUTCDay()];
}

export function weekdayAr(day) {
  return AR_WEEKDAYS[weekdayOf(day)];
}

/** 2026-12-15 ← «الثلاثاء 15 دجنبر 2026» */
export function humanDay(day) {
  if (!isDay(day)) return '—';
  const dt = parseDay(day);
  return `${AR_WEEKDAYS[WEEKDAYS[dt.getUTCDay()]]} ${dt.getUTCDate()} ${
    AR_MONTHS[dt.getUTCMonth()]
  } ${dt.getUTCFullYear()}`;
}

/** "18:30" ← 1110 دقيقة. */
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/** 1110 ← "18:30" */
export function toHHMM(minutes) {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** النوافذ المتاحة ليوم معيّن، محوّلة إلى دقائق. */
export function windowsForDay(config, day) {
  const list = config?.availability?.[weekdayOf(day)] || [];
  return list
    .map(([start, end]) => ({ start: toMinutes(start), end: toMinutes(end) }))
    .filter((w) => w.end > w.start)
    .sort((a, b) => a.start - b.start);
}

/** طرح الفترات المشغولة من النوافذ المتاحة. */
export function freeSlots(windows, busy = []) {
  const busyList = busy
    .map((b) => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))
    .filter((b) => b.end > b.start);

  const out = [];
  for (const w of windows) {
    let cursor = w.start;
    const overlaps = busyList
      .filter((b) => b.end > w.start && b.start < w.end)
      .sort((a, b) => a.start - b.start);
    for (const b of overlaps) {
      if (b.start > cursor) out.push({ start: cursor, end: Math.min(b.start, w.end) });
      cursor = Math.max(cursor, b.end);
      if (cursor >= w.end) break;
    }
    if (cursor < w.end) out.push({ start: cursor, end: w.end });
  }
  return out.filter((s) => s.end - s.start >= 15);
}

export function totalMinutes(slots) {
  return slots.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** رقم الأسبوع داخل السدس (ISO-ish، يكفي للتجميع). */
export function weekKey(day) {
  const dt = parseDay(day);
  const dayOfYear = Math.floor((dt - Date.UTC(dt.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
  return `${dt.getUTCFullYear()}-W${String(Math.ceil(dayOfYear / 7)).padStart(2, '0')}`;
}

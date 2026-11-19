/**
 * ics.mjs — توليد ملفات iCalendar صحيحة (RFC 5545) بدون مكتبات.
 *
 * قرار تصميمي: نكتب DTSTART/DTEND بصيغة UTC (تنتهي بـ Z) بدل TZID.
 * السبب: كتلة VTIMEZONE اليدوية الطويلة هي أكثر مصدر للأخطاء، وبعض العملاء
 * ترفض TZID بدون تعريف المنطقة. الحساب إلى UTC هنا دقيق ويُختبر.
 */

const CRLF = '\r\n';

/** تحويل وقت جداري (يوم + HH:MM) في منطقة زمنية إلى لحظة UTC. */
export function zonelessToUtc(day, hhmm, timeZone = 'UTC') {
  const [y, m, d] = String(day).split('-').map(Number);
  const [hh, mi] = String(hhmm).split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mi);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(new Date(guess));

  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute')
  );

  // الفرق بين ما نعتقده UTC وما هو فعليًا في تلك المنطقة.
  return new Date(guess - (wallAsUtc - guess));
}

export function utcStamp(date) {
  const iso = new Date(date).toISOString(); // 2026-11-19T17:00:00.000Z
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** هروب النصوص حسب RFC 5545. */
export function escapeText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** ثني الأسطر عند 75 أوكتيت (بايت) مع مراعاة أن الحرف العربي يأخذ بايتين. */
export function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 73) return line;

  const chunks = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    const limit = chunks.length === 0 ? 73 : 72; // الأسطر التالية تبدأ بمسافة
    if (currentBytes + size > limit) {
      chunks.push(current);
      current = ch;
      currentBytes = size;
    } else {
      current += ch;
      currentBytes += size;
    }
  }
  if (current) chunks.push(current);
  return chunks[0] + chunks.slice(1).map((c) => CRLF + ' ' + c).join('');
}

export function eventBlock({
  uid,
  day,
  start,
  end,
  title,
  description = '',
  timeZone = 'UTC',
  categories = '',
  stamp = new Date()
}) {
  const dtStart = utcStamp(zonelessToUtc(day, start, timeZone));
  const dtEnd = utcStamp(zonelessToUtc(day, end, timeZone));

  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${utcStamp(stamp)}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeText(title)}`,
    description ? `DESCRIPTION:${escapeText(description)}` : null,
    categories ? `CATEGORIES:${escapeText(categories)}` : null,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'BEGIN:VALARM',
    'TRIGGER:-PT10M',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeText(title)}`,
    'END:VALARM',
    'END:VEVENT'
  ].filter(Boolean);

  return lines.map(foldLine).join(CRLF);
}

export function calendar({ events, prodId = '-//AALL//Study Engine//AR', name = 'AALL' }) {
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
    'X-WR-TIMEZONE:Africa/Casablanca'
  ];
  const tail = ['END:VCALENDAR'];
  return [...head, ...events, ...tail].join(CRLF) + CRLF;
}

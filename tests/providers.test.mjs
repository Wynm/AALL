import test from 'node:test';
import assert from 'node:assert/strict';
import { zonelessToUtc, calendar, eventBlock, escapeText, foldLine } from '../src/providers/ics.mjs';
import { buildEmail, encodeHeader } from '../src/providers/eml.mjs';

test('التحويل إلى UTC يحترم فرق المنطقة (UTC+1)', () => {
  const utc = zonelessToUtc('2026-11-19', '18:00', 'Africa/Casablanca');
  assert.equal(utc.toISOString(), '2026-11-19T17:00:00.000Z');
});

test('التحويل إلى UTC صحيح أيضًا في نيويورك (UTC-5 شتاءً)', () => {
  const utc = zonelessToUtc('2026-01-15', '09:00', 'America/New_York');
  assert.equal(utc.toISOString(), '2026-01-15T14:00:00.000Z');
});

test('التحويل إلى UTC صحيح في لندن صيفًا (UTC+1)', () => {
  const utc = zonelessToUtc('2026-07-01', '09:00', 'Europe/London');
  assert.equal(utc.toISOString(), '2026-07-01T08:00:00.000Z');
});

test('ملف iCal يحتوي على بنية صحيحة', () => {
  const ics = calendar({
    name: 'AALL',
    events: [
      eventBlock({
        uid: 'x-1@aall.local',
        day: '2026-11-19',
        start: '18:00',
        end: '18:45',
        title: 'دراسة · رياضيات',
        description: 'سطر أول\nسطر ثانٍ',
        timeZone: 'Africa/Casablanca'
      })
    ]
  });

  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20261119T170000Z/);
  assert.match(ics, /DTEND:20261119T174500Z/);
  assert.match(ics, /END:VEVENT/);
});

test('النصوص الخاصة تُهرَّب حسب RFC 5545', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
});

test('ثني الأسطر يحترم حد 75 بايت', () => {
  const long = 'ا'.repeat(120);
  const folded = foldLine(long);
  for (const part of folded.split('\r\n')) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 75, `سطر أطول من الحد: ${Buffer.byteLength(part, 'utf8')}`);
    assert.equal(Buffer.from(part, 'utf8').toString('utf8'), part);
  }
  // إزالة الطي يجب أن يعيد النص الأصلي
  assert.equal(folded.split('\r\n ').join(''), long);
});

test('رسالة البريد قابلة للقراءة ويُستعاد النص العربي', () => {
  const body = '# خطة اليوم\n\n18:00 — رياضيات';
  const eml = buildEmail({
    from: 'aall@local',
    to: 'me@local',
    subject: 'خطة الخميس',
    text: body
  });

  assert.match(eml, /^Date: /);
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
  assert.match(eml, /Content-Transfer-Encoding: base64/);

  const encoded = eml.split('\r\n\r\n').pop().replace(/\r\n/g, '');
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), body);
});

test('ترميز العنوان يترك ASCII كما هو', () => {
  assert.equal(encodeHeader('Study plan'), 'Study plan');
  assert.match(encodeHeader('خطة'), /^=\?UTF-8\?B\?/);
});

test('رسالة multipart تحتوي النسختين', () => {
  const eml = buildEmail({
    from: 'a@b.c',
    to: ['d@e.f', 'g@h.i'],
    subject: 'x',
    text: 'نص',
    html: '<p>نص</p>'
  });
  assert.match(eml, /multipart\/alternative/);
  assert.match(eml, /text\/html/);
  assert.match(eml, /d@e\.f, g@h\.i/);
});

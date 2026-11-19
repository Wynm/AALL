/**
 * eml.mjs — بناء رسالة بريد MIME صحيحة (RFC 5322) وتُحفظ كملف .eml.
 *
 * الغرض: عندما لا يوجد اتصال مباشر ببريد الطالب، نكتب الرسالة كملف بريد
 * قياسي يمكن فتحه في أي عميل أو إرساله لاحقًا — وليس مجرد ملف نصي.
 */

const CRLF = '\r\n';

/** ترميز العنوان العربي حسب RFC 2047 (encoded-word). */
export function encodeHeader(text) {
  const raw = String(text ?? '');
  if (/^[\x20-\x7E]*$/.test(raw)) return raw;
  return `=?UTF-8?B?${Buffer.from(raw, 'utf8').toString('base64')}?=`;
}

export function base64Body(text, width = 76) {
  const b64 = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
  return lines.join(CRLF);
}

export function buildEmail({ from, to, subject, text, html, date = new Date(), messageId }) {
  const id = messageId || `<${Date.now()}.${Math.random().toString(36).slice(2)}@aall.local>`;
  const headers = [
    `Date: ${date.toUTCString()}`,
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0'
  ];

  let body;
  if (html) {
    const boundary = `----AALL_${Date.now().toString(36)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(text || ''),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(html),
      `--${boundary}--`,
      ''
    ].join(CRLF);
  } else {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: base64');
    body = CRLF + base64Body(text || '');
  }

  return headers.join(CRLF) + CRLF + body + CRLF;
}

export function safeFilename(text) {
  return String(text)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

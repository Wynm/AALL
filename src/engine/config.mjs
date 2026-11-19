/**
 * config.mjs — تحميل الإعدادات والتحقق منها.
 *
 * مبدأ: لا نفشل بصمت. إذا كان الإعداد غير صالح نقول بالضبط ما هو الخطأ،
 * وإذا غاب ملف الإعدادات نعيد إعدادات افتراضية آمنة بدل أن نتعطّل.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isDay, todayIn } from './clock.mjs';

export const CONFIG_PATH = path.resolve('config/study.json');

export async function loadConfig(file = CONFIG_PATH) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { config: fallbackConfig(), warnings: [`لا يوجد ملف إعدادات في ${file}؛ استُخدم إعداد افتراضي.`] };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ملف الإعدادات ليس JSON صالحًا: ${err.message}`);
  }

  const { config: normalized, warnings } = validate(config);
  return { config: normalized, warnings };
}

export function validate(config) {
  const warnings = [];
  const out = structuredClone(config || {});

  out.student ||= {};
  out.student.timezone ||= 'Africa/Casablanca';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: out.student.timezone });
  } catch {
    warnings.push(`منطقة زمنية غير معروفة (${out.student.timezone}) — تم الرجوع إلى UTC.`);
    out.student.timezone = 'UTC';
  }

  out.preferences ||= {};
  out.automation ||= {};
  out.automation.providers ||= { calendar: 'local', mail: 'local', notes: 'local', tasks: 'local' };
  out.automation.tickMinutes = clampInt(out.automation.tickMinutes, 1, 1440, 15);
  out.automation.dailyBriefHour = clampInt(out.automation.dailyBriefHour, 0, 23, 7);
  out.automation.autoDispatch = out.automation.autoDispatch === true;

  out.availability ||= {};
  for (const [day, windows] of Object.entries(out.availability)) {
    const clean = (Array.isArray(windows) ? windows : []).filter(
      (w) => Array.isArray(w) && w.length === 2 && /^\d{2}:\d{2}$/.test(w[0]) && /^\d{2}:\d{2}$/.test(w[1])
    );
    if (clean.length !== (windows || []).length) {
      warnings.push(`نافذة زمنية غير صالحة في «${day}» تم تجاهلها.`);
    }
    out.availability[day] = clean;
  }

  if (!Array.isArray(out.subjects) || out.subjects.length === 0) {
    warnings.push('لا توجد مواد دراسية — أضف مادة واحدة على الأقل من لوحة التحكم أو من config/study.json.');
    out.subjects = [];
  }

  const seen = new Set();
  for (const subject of out.subjects) {
    subject.id ||= slug(subject.name || 'subject');
    subject.topics = Array.isArray(subject.topics) ? subject.topics : [];
    for (const topic of subject.topics) {
      topic.id ||= slug(`${subject.id}-${topic.name || 'topic'}`);
      if (seen.has(topic.id)) warnings.push(`معرّف موضوع مكرر: ${topic.id}`);
      seen.add(topic.id);
      topic.difficulty = clampInt(topic.difficulty, 1, 5, 3);
      topic.minutes = clampInt(topic.minutes, 10, 120, 40);
      if (topic.examDate && !isDay(topic.examDate)) {
        warnings.push(`تاريخ امتحان غير صالح للموضوع «${topic.name}» تم تجاهله.`);
        delete topic.examDate;
      }
    }
  }

  return { config: out, warnings };
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function slug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'item';
}

export function fallbackConfig() {
  return validate({
    student: { timezone: 'Africa/Casablanca' },
    availability: {
      monday: [['18:00', '21:00']],
      tuesday: [['18:00', '21:00']],
      wednesday: [['18:00', '21:00']],
      thursday: [['18:00', '21:00']],
      friday: [['18:00', '20:00']],
      saturday: [['10:00', '13:00']],
      sunday: [['10:00', '13:00']]
    },
    subjects: []
  }).config;
}

/** كتابة الإعدادات بعد تعديلها من لوحة التحكم. */
export async function saveConfig(config, file = CONFIG_PATH) {
  const tmp = `${file}.tmp-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
}

export function nowFor(config, now = new Date()) {
  return todayIn(config?.student?.timezone || 'UTC', now);
}

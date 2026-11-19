/**
 * server.mjs — خادم HTTP بلا تبعيات + المحرّك الذاتي.
 *
 * لماذا خادم بلا إطار عمل؟
 *  - عدد المسارات صغير، والحاجة الحقيقية هي أن يعمل في أي بيئة (حاوية، Vercel،
 *    جهاز الطالب) دون بناء أو تثبيت. صفر تبعيات = صفر أعطال تثبيت.
 *
 * المحرّك يعمل داخل نفس العملية عبر مؤقّت، لكنه لا يعتمد على الخادم:
 * نفس النبضة يمكن تشغيلها من cron أو GitHub Actions.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, saveConfig, validate, nowFor, slug } from './engine/config.mjs';
import { createStore } from './engine/store.mjs';
import { tick, recordSession, snapshot, writeBusy, generateWeeklyReport } from './engine/runner.mjs';
import { createProviders, drainOutbox } from './providers/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

async function body(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('الطلب كبير جدًا');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('JSON غير صالح');
  }
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return false; // حماية من الخروج من المجلد

  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

export function createServer({ store, getConfig, providers }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    try {
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        if (await serveStatic(res, p)) return;
        json(res, 404, { error: 'غير موجود' });
        return;
      }

      const config = await getConfig();

      // ---------- قراءة ----------
      if (req.method === 'GET' && p === '/api/snapshot') {
        json(res, 200, await snapshot({ store, config, providers }));
        return;
      }

      if (req.method === 'GET' && p === '/api/health') {
        const state = await store.readState();
        json(res, 200, {
          ok: true,
          day: nowFor(config),
          lastTickAt: state.meta?.lastTickAt || null,
          uptime: Math.round(process.uptime())
        });
        return;
      }

      if (req.method === 'GET' && p.startsWith('/api/plan/')) {
        const day = p.split('/').pop();
        const plan = await store.readPlan(day);
        if (!plan) {
          json(res, 404, { error: 'لا توجد خطة لهذا اليوم' });
          return;
        }
        json(res, 200, plan);
        return;
      }

      if (req.method === 'GET' && p === '/api/report') {
        const name = url.searchParams.get('name') || `week-${new Date().toISOString().slice(0, 10)}`;
        const report = await store.readReport(name);
        json(res, report ? 200 : 404, report || { error: 'لا يوجد تقرير' });
        return;
      }

      // ---------- كتابة ----------
      if (req.method === 'POST' && p === '/api/review') {
        const payload = await body(req);
        if (!payload.topicId) throw new Error('topicId مطلوب');
        const result = await recordSession({
          store,
          config,
          topicId: payload.topicId,
          quality: Number(payload.quality ?? 4),
          minutes: Number(payload.minutes ?? 40),
          day: nowFor(config)
        });
        json(res, 200, {
          ok: true,
          topicId: payload.topicId,
          mastery: result.session.mastery,
          dueDate: result.session.dueDate,
          intervalDays: result.session.intervalDays,
          streak: result.streak
        });
        return;
      }

      if (req.method === 'POST' && p === '/api/tick') {
        const payload = await body(req);
        const summary = await tick({
          store,
          config,
          providers,
          force: payload.force === true,
          dispatch: payload.dispatch === true ? true : undefined
        });
        json(res, 200, {
          ok: true,
          day: summary.day,
          created: summary.created,
          skipped: summary.skipped,
          enqueued: summary.enqueued.length,
          pending: summary.pending,
          dispatch: summary.dispatch
        });
        return;
      }

      if (req.method === 'POST' && p === '/api/dispatch') {
        const summary = await drainOutbox({ store, config, providers });
        json(res, 200, { ok: true, ...summary });
        return;
      }

      if (req.method === 'POST' && p === '/api/report') {
        const payload = await body(req);
        const day = payload.day || nowFor(config);
        const { report, markdown, key } = await generateWeeklyReport({ store, config, day });
        json(res, 200, { ok: true, name: key, report, markdown });
        return;
      }

      if (req.method === 'POST' && p === '/api/busy') {
        const payload = await body(req);
        const day = payload.day || nowFor(config);
        await writeBusy(store, day, Array.isArray(payload.busy) ? payload.busy : []);
        json(res, 200, { ok: true, day });
        return;
      }

      if (req.method === 'POST' && p === '/api/subjects') {
        const payload = await body(req);
        const name = String(payload.name || '').trim();
        if (!name) throw new Error('اسم المادة مطلوب');
        const draft = structuredClone(config);
        const id = payload.id ? slug(payload.id) : slug(name);
        if (draft.subjects.some((s) => s.id === id)) throw new Error(`المادة «${id}» موجودة`);
        draft.subjects.push({ id, name, color: payload.color || pickColor(draft.subjects.length), topics: [] });
        const { config: next, warnings } = validate(draft);
        await saveConfig(next);
        json(res, 200, { ok: true, subject: { id, name }, warnings });
        return;
      }

      if (req.method === 'POST' && p === '/api/topics') {
        const payload = await body(req);
        const name = String(payload.name || '').trim();
        if (!name) throw new Error('اسم الموضوع مطلوب');
        const draft = structuredClone(config);
        const subject = draft.subjects.find((s) => s.id === payload.subjectId);
        if (!subject) throw new Error('المادة غير موجودة');
        const id = payload.id ? slug(payload.id) : slug(`${subject.id}-${name}`);
        if (subject.topics.some((t) => t.id === id)) throw new Error('الموضوع موجود');
        subject.topics.push({
          id,
          name,
          difficulty: Number(payload.difficulty ?? 3),
          minutes: Number(payload.minutes ?? 40),
          ...(payload.examDate ? { examDate: payload.examDate } : {})
        });
        const { config: next, warnings } = validate(draft);
        await saveConfig(next);
        json(res, 200, { ok: true, topic: { id, name }, warnings });
        return;
      }

      if (req.method === 'POST' && p === '/api/topics/delete') {
        const payload = await body(req);
        const draft = structuredClone(config);
        for (const s of draft.subjects) s.topics = s.topics.filter((t) => t.id !== payload.topicId);
        const { config: next } = validate(draft);
        await saveConfig(next);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && p === '/api/settings') {
        const payload = await body(req);
        const draft = structuredClone(config);
        for (const key of ['preferences', 'automation', 'student', 'semester']) {
          if (payload[key] && typeof payload[key] === 'object') {
            draft[key] = { ...draft[key], ...payload[key] };
          }
        }
        const { config: next, warnings } = validate(draft);
        await saveConfig(next);
        json(res, 200, { ok: true, warnings });
        return;
      }

      json(res, 404, { error: 'مسار غير معروف' });
    } catch (err) {
      json(res, 400, { error: String(err.message || err) });
    }
  });
}

function pickColor(n) {
  const palette = ['#7dd3fc', '#a78bfa', '#86efac', '#fca5a5', '#fcd34d', '#f9a8d4', '#5eead4'];
  return palette[n % palette.length];
}

export async function startServer({ port = 4173 } = {}) {
  const store = createStore(process.env.AALL_DATA || 'data');
  await store.ensure();

  let cache = null;
  let cacheAt = 0;
  const getConfig = async () => {
    const now = Date.now();
    if (cache && now - cacheAt < 1500) return cache;
    const { config, warnings } = await loadConfig();
    if (warnings.length) for (const w of warnings) console.warn(`[config] ${w}`);
    cache = config;
    cacheAt = now;
    return config;
  };

  const providers = createProviders(await getConfig());
  const server = createServer({ store, getConfig, providers });

  server.listen(port, '0.0.0.0', () => {
    console.log(`AALL يعمل على http://0.0.0.0:${port}`);
  });

  // نبضة عند الإقلاع ثم كل tickMinutes — بلا تدخل بشري.
  const runTick = async () => {
    try {
      const config = await getConfig();
      const p = createProviders(config);
      const summary = await tick({ store, config, providers: p });
      console.log(
        `[tick ${summary.day}] خطة: ${summary.plan.blocks.length} جلسة · جديد: ${summary.created.join(',') || '—'} · معلّق: ${summary.pending}`
      );
    } catch (err) {
      console.error('[tick] فشل:', err.message);
    }
  };

  setTimeout(runTick, 400);

  let timer = null;
  const schedule = async () => {
    if (timer) clearInterval(timer);
    const config = await getConfig();
    const minutes = config?.automation?.tickMinutes || 15;
    timer = setInterval(runTick, Math.max(1, minutes) * 60_000);
    timer.unref?.();
    console.log(`[scheduler] نبضة كل ${minutes} دقيقة`);
  };
  await schedule();

  return { server, store, getConfig, runTick };
}

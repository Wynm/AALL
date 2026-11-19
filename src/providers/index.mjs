/**
 * providers/index.mjs — طبقة التسليم.
 *
 * المحرّك يقرّر «ماذا يجب أن يحدث» ويكتبه كإجراءات في صندوق صادر (outbox).
 * هذه الطبقة هي التي تُسلّمها: إلى ملفات محلية قابلة للاستيراد، أو إلى
 * Webhook يُنفّذ الإجراء في خدمات الطالب (Calendar / Gmail / Notion / Linear).
 *
 * الفصل بين القرار والتسليم مقصود:
 *  - إذا تعطّلت خدمة خارجية لا تتوقف الدراسة ولا تُفقد الخطة.
 *  - كل إجراء قابل لإعادة المحاولة، وله معرّف ثابت يمنع التكرار.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { calendar, eventBlock } from './ics.mjs';
import { buildEmail, safeFilename } from './eml.mjs';

// ---------------------------------------------------------------------------
// تسليم محلي: ملفات قياسية قابلة للاستيراد
// ---------------------------------------------------------------------------

function outDir(store, day) {
  return path.join(store.paths.base, 'out', day);
}

const local = {
  async 'calendar.block'(action, { store, config, day }) {
    const dir = outDir(store, day);
    await fs.mkdir(dir, { recursive: true });
    const indexFile = path.join(dir, 'events.json');

    let events = [];
    try {
      events = JSON.parse(await fs.readFile(indexFile, 'utf8'));
    } catch {
      events = [];
    }

    for (const block of action.blocks || []) {
      const uid = `aall-${block.topicId}-${day}-${block.start.replace(':', '')}@aall.local`;
      events = events.filter((e) => e.uid !== uid);
      events.push({
        uid,
        day,
        start: block.start,
        end: block.end,
        title: `دراسة · ${block.topicName}`,
        description: [
          `المادة: ${block.subjectName}`,
          `المدة: ${block.minutes} دقيقة`,
          `السبب: ${block.rationale}`,
          '— مولّد آليًا بواسطة AALL'
        ].join('\n'),
        categories: block.subjectName
      });
    }

    events.sort((a, b) => (a.start < b.start ? -1 : 1));
    await fs.writeFile(indexFile, JSON.stringify(events, null, 2), 'utf8');

    const icsFile = path.join(dir, `study-${day}.ics`);
    const content = calendar({
      name: 'AALL · خطة الدراسة',
      events: events.map((e) =>
        eventBlock({
          uid: e.uid,
          day: e.day,
          start: e.start,
          end: e.end,
          title: e.title,
          description: e.description,
          categories: e.categories,
          timeZone: config?.student?.timezone || 'UTC'
        })
      )
    });
    await fs.writeFile(icsFile, content, 'utf8');
    return { ok: true, provider: 'local', file: icsFile, events: events.length };
  },

  async 'mail.brief'(action, { store, day }) {
    const dir = outDir(store, day);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeFilename(action.slug || 'brief')}.eml`);
    const eml = buildEmail({
      from: action.from || 'aall@local',
      to: action.to || 'me@local',
      subject: action.subject,
      text: action.text,
      html: action.html
    });
    await fs.writeFile(file, eml, 'utf8');
    return { ok: true, provider: 'local', file };
  },

  async 'notes.page'(action, { store, day }) {
    const dir = outDir(store, day);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${safeFilename(action.slug || 'notes')}.md`);
    await fs.writeFile(file, action.markdown, 'utf8');
    return { ok: true, provider: 'local', file };
  },

  async 'tasks.batch'(action, { store, day }) {
    const dir = outDir(store, day);
    await fs.mkdir(dir, { recursive: true });
    const jsonFile = path.join(dir, 'tasks.json');
    const mdFile = path.join(dir, 'tasks.md');

    let existing = [];
    try {
      existing = JSON.parse(await fs.readFile(jsonFile, 'utf8'));
    } catch {
      existing = [];
    }
    const merged = [...existing];
    for (const task of action.tasks || []) {
      if (!merged.some((t) => t.id === task.id)) merged.push(task);
    }
    await fs.writeFile(jsonFile, JSON.stringify(merged, null, 2), 'utf8');

    const md = [
      `# مهام ${day}`,
      '',
      '> ملف مُولّد آليًا. يمكن استيراده إلى Notion / Linear / أي مدير مهام.',
      '',
      ...merged.map(
        (t) =>
          `- [${t.done ? 'x' : ' '}] **${t.title}** — ${t.due || 'بدون موعد'}${t.notes ? `\n  - ${t.notes}` : ''}`
      ),
      ''
    ].join('\n');
    await fs.writeFile(mdFile, md, 'utf8');
    return { ok: true, provider: 'local', files: [jsonFile, mdFile], tasks: merged.length };
  }
};

// ---------------------------------------------------------------------------
// تسليم عبر Webhook: نفس الإجراءات، لكن تُنفَّذ في خدمة خارجية
// ---------------------------------------------------------------------------

function webhookFor(config) {
  return config?.automation?.webhook?.url || process.env.AALL_WEBHOOK_URL || null;
}

const webhook = {
  async deliver(action, { config }) {
    const url = webhookFor(config);
    if (!url) throw new Error('لا يوجد webhook مُهيّأ (automation.webhook.url)');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-aall-action': action.kind,
          'x-aall-id': action.id || '',
          ...(config?.automation?.webhook?.token
            ? { authorization: `Bearer ${config.automation.webhook.token}` }
            : {})
        },
        body: JSON.stringify({ action }),
        signal: controller.signal
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`webhook ${res.status}: ${body.slice(0, 300)}`);
      }
      return { ok: true, provider: 'webhook', status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
};

// ---------------------------------------------------------------------------
// السجل
// ---------------------------------------------------------------------------

const KIND_CHANNEL = {
  'calendar.block': 'calendar',
  'mail.brief': 'mail',
  'mail.report': 'mail',
  'notes.page': 'notes',
  'tasks.batch': 'tasks'
};

export function createProviders(config) {
  const mapping = config?.automation?.providers || {};

  return {
    mapping,
    /** تسليم إجراء واحد. يعيد {ok, provider, ...} أو يرمي خطأً. */
    async deliver(action, ctx) {
      const channel = KIND_CHANNEL[action.kind];
      if (!channel) throw new Error(`نوع إجراء غير معروف: ${action.kind}`);

      const mode = mapping[channel] || 'local';
      if (mode === 'webhook') {
        if (webhookFor(config)) return webhook.deliver(action, { ...ctx, config });
        // لا webhook: نسقط إلى المحلي بدل تعطيل النظام كله.
        (ctx.warnings ||= []).push(`القناة «${channel}» مضبوطة على webhook بدون عنوان؛ تم التسليم محليًا.`);
      }

      const handler = local[action.kind];
      if (!handler) throw new Error(`لا يوجد مُسلِّم محلي للنوع: ${action.kind}`);
      return handler(action, { ...ctx, config });
    }
  };
}

// ---------------------------------------------------------------------------
// دفع الصندوق الصادر
// ---------------------------------------------------------------------------

/**
 * يفرّغ كل الإجراءات المعلّقة. يعيد ملخّصًا.
 * الإجراء الفاشل يبقى معلّقًا مع زيادة عدد المحاولات — لا يُفقد شيء.
 */
export async function drainOutbox({ store, config, providers, maxAttempts = 5 }) {
  const pending = await store.listPending();
  const summary = { total: pending.length, sent: 0, failed: 0, results: [] };

  for (const action of pending) {
    const warnings = [];
    try {
      const result = await providers.deliver(action, {
        store,
        config,
        day: (action.day || new Date().toISOString().slice(0, 10)),
        warnings
      });
      await store.markSent(action, { ...result, warnings });
      summary.sent += 1;
      summary.results.push({ id: action.id, kind: action.kind, ok: true, ...result, warnings });
    } catch (err) {
      const attempts = (action.attempts || 0) + 1;
      summary.failed += 1;
      summary.results.push({ id: action.id, kind: action.kind, ok: false, error: String(err.message || err) });
      if (attempts >= maxAttempts) {
        await store.markSent(action, { error: String(err.message || err), attempts, abandoned: true });
      } else {
        await store.writeJson(path.join(store.paths.pending, `${action.id}.json`), {
          ...action,
          attempts,
          lastError: String(err.message || err),
          lastAttemptAt: new Date().toISOString()
        });
      }
    }
  }
  return summary;
}

/**
 * store.mjs — تخزين محلي بسيط ومتين (بدون قاعدة بيانات).
 *
 * لماذا ملفات JSON بدل SQLite؟
 *  - صفر تبعيات، صفر ترحيلات، يعمل في GitHub Actions وفي أي حاوية.
 *  - الكتابة ذرّية (tmp + rename) حتى لا يتلف الملف إذا انقطع التنفيذ.
 *  - كل شيء قابل للقراءة والمراجعة بـ git diff، وهذا مهم لأتمتة تُعدّل ملفات.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

export function createStore(root = 'data') {
  const base = path.resolve(root);

  const p = {
    base,
    state: path.join(base, 'state.json'),
    plans: path.join(base, 'plans'),
    outbox: path.join(base, 'outbox'),
    pending: path.join(base, 'outbox', 'pending'),
    sent: path.join(base, 'outbox', 'sent'),
    log: path.join(base, 'log'),
    reports: path.join(base, 'reports')
  };

  async function ensure() {
    for (const dir of [base, p.plans, p.pending, p.sent, p.log, p.reports]) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  async function readJson(file, fallback) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return fallback;
      // ملف تالف: نُبقيه جانبًا بدل أن نفقد المعطيات.
      try {
        await fs.rename(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* تجاهل */
      }
      return fallback;
    }
  }

  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  }

  async function appendJsonl(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
  }

  return {
    paths: p,
    ensure,
    readJson,
    writeJson,
    appendJsonl,

    async readState() {
      return readJson(p.state, { version: 1, topics: {}, meta: {} });
    },
    async writeState(state) {
      return writeJson(p.state, state);
    },
    async readPlan(day) {
      return readJson(path.join(p.plans, `${day}.json`), null);
    },
    async writePlan(day, plan) {
      return writeJson(path.join(p.plans, `${day}.json`), plan);
    },
    async readReport(name) {
      return readJson(path.join(p.reports, `${name}.json`), null);
    },
    async writeReport(name, report) {
      return writeJson(path.join(p.reports, `${name}.json`), report);
    },
    async listPlans() {
      if (!existsSync(p.plans)) return [];
      return (await fs.readdir(p.plans))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
        .sort();
    },
    async enqueue(action) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const record = { id, createdAt: new Date().toISOString(), status: 'pending', ...action };
      await writeJson(path.join(p.pending, `${id}.json`), record);
      return record;
    },
    async listPending() {
      if (!existsSync(p.pending)) return [];
      const files = (await fs.readdir(p.pending)).filter((f) => f.endsWith('.json')).sort();
      const out = [];
      for (const f of files) {
        const v = await readJson(path.join(p.pending, f), null);
        if (v) out.push(v);
      }
      return out;
    },
    async markSent(record, result) {
      await writeJson(path.join(p.sent, `${record.id}.json`), {
        ...record,
        status: 'sent',
        sentAt: new Date().toISOString(),
        result: result ?? null
      });
      await fs.rm(path.join(p.pending, `${record.id}.json`), { force: true });
    },
    async logAction(day, entry) {
      await appendJsonl(path.join(p.log, `${day}.jsonl`), {
        at: new Date().toISOString(),
        ...entry
      });
    },
    async readLog(day) {
      const file = path.join(p.log, `${day}.jsonl`);
      try {
        const raw = await fs.readFile(file, 'utf8');
        return raw
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      } catch {
        return [];
      }
    }
  };
}

export function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    topics: {},
    meta: {
      lastTickAt: null,
      planCreatedFor: null,
      briefSentFor: null,
      reportSentFor: null,
      streakDays: 0,
      lastStudyDay: null,
      totalMinutes: 0,
      totalSessions: 0
    }
  };
}

#!/usr/bin/env node
/**
 * cli.mjs — كل ما يمكن فعله من الطرفية، في مكان واحد.
 *
 * الأوامر:
 *   serve     تشغيل اللوحة + المحرّك الذاتي
 *   tick      نبضة واحدة (مناسبة لـ cron / GitHub Actions)
 *   plan      طباعة خطة اليوم
 *   report    توليد تقرير الأسبوع
 *   dispatch  تفريغ الصندوق الصادر
 *   review    تسجيل جلسة: review --topic <id> --quality 4 --minutes 45
 *   doctor    فحص صحة الإعدادات والحالة
 *   seed      إنشاء الحالة وإعدادات أولية إن لم تكن موجودة
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, saveConfig, nowFor } from './engine/config.mjs';
import { createStore } from './engine/store.mjs';
import { tick, recordSession, snapshot, generateWeeklyReport } from './engine/runner.mjs';
import { createProviders, drainOutbox } from './providers/index.mjs';
import { briefMarkdown } from './engine/content.mjs';


const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  teal: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function context() {
  const { config, warnings } = await loadConfig();
  const store = createStore(process.env.AALL_DATA || 'data');
  const providers = createProviders(config);
  await store.ensure();
  return { config, store, providers, warnings };
}

function line(text = '') {
  process.stdout.write(text + '\n');
}

async function cmdTick(args) {
  const { config, store, providers, warnings } = await context();
  for (const w of warnings) line(`${C.yellow}! ${w}${C.reset}`);
  const summary = await tick({
    store,
    config,
    providers,
    force: Boolean(args.force),
    dispatch: args.dispatch ? true : undefined
  });

  line(`${C.teal}${C.bold}نبضة ${summary.humanDay}${C.reset}`);
  line(`${C.dim}الخطة: ${summary.plan.plannedMinutes} دقيقة · ${summary.plan.blocks.length} جلسة${C.reset}`);
  if (summary.created.length) line(`${C.green}أُنشئ: ${summary.created.join(', ')}${C.reset}`);
  if (summary.skipped.length) line(`${C.dim}تُخطّي: ${summary.skipped.join(', ')}${C.reset}`);
  line(`${C.dim}إجراءات معلّقة: ${summary.pending}${C.reset}`);
  if (summary.dispatch) {
    line(`تسليم: ${summary.dispatch.sent} نجح · ${summary.dispatch.failed} فشل`);
    for (const r of summary.dispatch.results) {
      line(`  ${r.ok ? '✓' : '✗'} ${r.kind}${r.file ? ` → ${path.relative(process.cwd(), r.file)}` : ''}${r.error ? ` (${r.error})` : ''}`);
    }
  } else if (summary.pending) {
    line(`${C.dim}للتسليم: npm run dispatch${C.reset}`);
  }
}

async function cmdPlan(args) {
  const { config, store } = await context();
  const day = args.day || nowFor(config);
  let plan = await store.readPlan(day);
  if (!plan) {
    const { tick: runTick } = await import('./engine/runner.mjs');
    const summary = await runTick({ store, config, providers: createProviders(config), force: true });
    plan = summary.plan;
  }
  const state = await store.readState();
  line(briefMarkdown({ plan, state, config, streak: state.meta?.streakDays || 0 }));
}

async function cmdReport(args) {
  const { config, store } = await context();
  const day = args.day || nowFor(config);
  const { markdown, report } = await generateWeeklyReport({ store, config, day });
  line(markdown);
  line(`${C.dim}حُفظ في data/reports/ · ${report.sessions} جلسة · ${report.hours} ساعة${C.reset}`);
}

async function cmdDispatch() {
  const { config, store, providers } = await context();
  const summary = await drainOutbox({ store, config, providers });
  line(`${C.teal}تسليم ${summary.sent}/${summary.total}${C.reset}`);
  for (const r of summary.results) {
    line(`  ${r.ok ? '✓' : '✗'} ${r.kind}${r.file ? ` → ${path.relative(process.cwd(), r.file)}` : ''}${r.error ? ` (${r.error})` : ''}`);
  }
}

async function cmdReview(args) {
  const { config, store } = await context();
  if (!args.topic) throw new Error('مرّر --topic <id> (استخدم npm run doctor لرؤية المعرّفات)');
  const day = nowFor(config);
  const result = await recordSession({
    store,
    config,
    topicId: args.topic,
    quality: Number(args.quality || 4),
    minutes: Number(args.minutes || 40),
    day
  });
  line(`${C.green}✓${C.reset} ${result.topic.name}: إتقان ${(result.session.mastery * 100).toFixed(0)}% · المراجعة القادمة ${result.session.dueDate} · سلسلة ${result.streak}`);
}

async function cmdDoctor() {
  const { config, store, warnings } = await context();
  const snap = await snapshot({ store, config });
  line(`${C.teal}${C.bold}AALL · فحص الحالة${C.reset}`);
  line(`  اليوم: ${snap.humanDay} (${snap.day}) · المنطقة: ${snap.timezone}`);
  line(`  المواد: ${config.subjects.length} · المواضيع: ${snap.topics.length}`);
  line(`  آخر نبضة: ${snap.automation.lastTickAt || 'لم تحدث بعد'} (كل ${snap.automation.tickMinutes} دقيقة)`);
  line(`  سلسلة: ${snap.automation.streak} يوم · جلسات: ${snap.automation.totalSessions} · دقائق: ${snap.automation.totalMinutes}`);
  line(`  الخطة: ${snap.plan ? `${snap.plan.plannedMinutes} دقيقة / ${snap.plan.blocks.length} جلسة` : 'غير موجودة'}`);
  line(`  صندوق صادر: ${snap.pending.length} معلّق · autoDispatch=${snap.automation.autoDispatch}`);
  const due = snap.topics.filter((t) => t.due).length;
  line(`  مستحق للمراجعة: ${due} موضوعًا`);
  if (warnings.length) {
    line(`${C.yellow}تحذيرات:${C.reset}`);
    for (const w of warnings) line(`  - ${w}`);
  }
  line(`${C.dim}المواضيع:${C.reset}`);
  for (const t of snap.topics) {
    const bar = '█'.repeat(Math.round(t.mastery * 10)).padEnd(10, '·');
    line(`  ${t.due ? C.yellow + '●' : C.dim + '○'}${C.reset} ${t.id.padEnd(14)} ${bar} ${String(Math.round(t.mastery * 100)).padStart(3)}%  ${t.topicName ?? t.name}`);
  }
}

async function cmdSeed() {
  const { config, store } = await context();
  const state = await store.readState();
  if (Object.keys(state.topics || {}).length) {
    line(`${C.yellow}الحالة موجودة مسبقًا — لن ألمسها. استخدم --force للمتابعة.${C.reset}`);
    if (!process.argv.includes('--force')) return;
  }
  const summary = await tick({ store, config, providers: createProviders(config), force: true });
  line(`${C.green}✓${C.reset} جاهز: ${summary.plan.blocks.length} جلسة لليوم، ${summary.pending} إجراء في الصندوق.`);
}

async function cmdServe(args) {
  const { startServer } = await import('./server.mjs');
  await startServer({ port: Number(args.port || process.env.PORT || 4173) });
}

const commands = {
  tick: cmdTick,
  plan: cmdPlan,
  report: cmdReport,
  dispatch: cmdDispatch,
  review: cmdReview,
  doctor: cmdDoctor,
  seed: cmdSeed,
  serve: cmdServe
};

const argv = process.argv.slice(2);
const args = parseArgs(argv);
const command = args._[0] || 'serve';

if (!commands[command]) {
  line(`أمر غير معروف: ${command}`);
  line(`الأوامر: ${Object.keys(commands).join(' | ')}`);
  process.exit(1);
}

try {
  await commands[command](args);
} catch (err) {
  line(`${C.red}خطأ: ${err.message}${C.reset}`);
  if (process.env.DEBUG) line(err.stack);
  process.exit(1);
}

/**
 * content.mjs — تحويل الخطة والحالة إلى نصوص يقرأها إنسان.
 *
 * كل المخرجات (بريد، صفحة ملاحظات، مهام، تقرير) تُبنى من نفس الخطة،
 * حتى لا تتعارض الرسائل التي تصلك من مصادر مختلفة.
 */

export function briefMarkdown({ plan, state, config, streak = 0 }) {
  const name = config?.student?.name?.trim();
  const lines = [];

  lines.push(`# ${name ? `${name}، ` : ''}خطة ${plan.humanDay}`);
  lines.push('');
  lines.push(
    `**${plan.plannedMinutes} دقيقة** موزّعة على **${plan.blocks.length} جلسة** · مراجعة ${plan.reviewMinutes} د · تعلّم ${plan.learnMinutes} د${streak ? ` · سلسلة ${streak} يوم` : ''}`
  );
  lines.push('');

  if (!plan.blocks.length) {
    lines.push('لا توجد جلسات اليوم (وقت غير متاح أو لا مواضيع). خذ راحة مبرمجة.');
  } else {
    lines.push('## جدول اليوم');
    lines.push('');
    for (const b of plan.blocks) {
      lines.push(
        `- **${b.start}–${b.end}** · ${b.topicName} _(${b.subjectName})_ — ${b.kind === 'review' ? 'مراجعة' : 'تعلّم جديد'}\n  - ${b.rationale}`
      );
    }
  }

  if (plan.focus?.length) {
    lines.push('');
    lines.push('## نقاط الخطر');
    lines.push('');
    for (const f of plan.focus) {
      lines.push(`- ${f.topicName} (${f.subjectName}) — خطر نسيان ${Math.round(f.risk * 100)}%، إتقان ${Math.round(f.mastery * 100)}%`);
    }
  }

  if (plan.exams?.length) {
    lines.push('');
    lines.push('## أقرب امتحانات');
    lines.push('');
    for (const e of plan.exams.slice(0, 5)) {
      lines.push(`- ${e.topicName} — ${e.examDate} (بعد ${e.daysLeft} يوم)`);
    }
  }

  if (plan.notes?.length) {
    lines.push('');
    lines.push('## ملاحظات المحرّك');
    lines.push('');
    for (const n of plan.notes) lines.push(`- ${n}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('_مُولّد آليًا بواسطة AALL. لا حاجة للرد — النظام يتابع وحده._');

  return lines.join('\n');
}

export function briefHtml({ plan, config, streak = 0 }) {
  const name = config?.student?.name?.trim() || '';
  const row = (b) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #23304a;white-space:nowrap;font-variant-numeric:tabular-nums">
        <strong>${b.start}–${b.end}</strong>
      </td>
      <td style="padding:10px 12px;border-bottom:1px solid #23304a">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${b.color};margin-inline-end:8px"></span>
        <strong>${escapeHtml(b.topicName)}</strong>
        <span style="color:#8fa3bf"> · ${escapeHtml(b.subjectName)} · ${b.kind === 'review' ? 'مراجعة' : 'تعلّم'}</span>
        <div style="color:#8fa3bf;font-size:12px;margin-top:4px">${escapeHtml(b.rationale)}</div>
      </td>
    </tr>`;

  return `<!doctype html>
<html dir="rtl" lang="ar"><body style="margin:0;background:#0b1220;font-family:'Segoe UI',Tahoma,Arial,sans-serif;color:#e6edf7">
<div style="max-width:680px;margin:0 auto;padding:28px 20px">
  <div style="font-size:12px;letter-spacing:2px;color:#5eead4;text-transform:uppercase">AALL · محرّك الدراسة</div>
  <h1 style="font-size:22px;margin:8px 0 4px">${name ? `${escapeHtml(name)}، ` : ''}خطة ${escapeHtml(plan.humanDay)}</h1>
  <p style="color:#8fa3bf;margin:0 0 20px">
    ${plan.plannedMinutes} دقيقة · ${plan.blocks.length} جلسة · مراجعة ${plan.reviewMinutes} د · تعلّم ${plan.learnMinutes} د${streak ? ` · سلسلة ${streak} يوم` : ''}
  </p>
  <table style="width:100%;border-collapse:collapse;background:#111b2e;border-radius:14px;overflow:hidden">
    ${plan.blocks.map(row).join('') || '<tr><td style="padding:16px;color:#8fa3bf">لا جلسات اليوم.</td></tr>'}
  </table>
  ${
    plan.focus?.length
      ? `<h2 style="font-size:15px;margin:24px 0 8px;color:#fca5a5">نقاط الخطر</h2>
         <ul style="margin:0;padding-inline-start:18px;color:#c7d4e6">${plan.focus
           .map((f) => `<li>${escapeHtml(f.topicName)} — نسيان ${Math.round(f.risk * 100)}%</li>`)
           .join('')}</ul>`
      : ''
  }
  <p style="color:#5b6b85;font-size:12px;margin-top:28px">مُولّد آليًا. لا حاجة للرد — النظام يتابع وحده.</p>
</div></body></html>`;
}

export function notesMarkdown({ plan, state, config, catalog }) {
  const bySubject = new Map();
  for (const t of catalog) {
    if (!bySubject.has(t.subjectId)) bySubject.set(t.subjectId, { name: t.subjectName, topics: [] });
    bySubject.get(t.subjectId).topics.push(t);
  }

  const lines = [`# لوحة AALL · ${plan.humanDay}`, ''];
  lines.push(`> تحديث آلي. الخطة: ${plan.plannedMinutes} دقيقة / ${plan.blocks.length} جلسة.`);
  lines.push('');

  for (const [subjectId, subject] of bySubject) {
    lines.push(`## ${subject.name}`);
    for (const t of subject.topics) {
      const st = state.topics?.[t.id];
      const mastery = Math.round((st?.mastery || 0) * 100);
      const bar = '█'.repeat(Math.round(mastery / 10)).padEnd(10, '░');
      lines.push(
        `- [ ] **${t.name}** — إتقان ${bar} ${mastery}%${t.examDate ? ` · امتحان ${t.examDate}` : ''}`
      );
    }
    lines.push('');
  }

  lines.push('## جلسات اليوم');
  for (const b of plan.blocks) {
    lines.push(`- [ ] ${b.start}–${b.end} · ${b.topicName} (${b.reason || b.rationale})`);
  }
  return lines.join('\n');
}

export function tasksFor(plan) {
  return plan.blocks.map((b, i) => ({
    id: `${plan.day}-${i + 1}-${b.topicId}`,
    title: `${b.start} · ${b.topicName}`,
    notes: `${b.subjectName} — ${b.rationale}`,
    due: plan.day,
    minutes: b.minutes,
    done: false
  }));
}

export function weeklyReport({ days, state, config, catalog, day }) {
  const sessions = days.flatMap((d) => d.sessions || []);
  const minutes = sessions.reduce((s, x) => s + (x.minutes || 0), 0);
  const bySubject = new Map();
  for (const s of sessions) {
    bySubject.set(s.subjectName, (bySubject.get(s.subjectName) || 0) + s.minutes);
  }

  const avgQuality = sessions.length
    ? sessions.reduce((s, x) => s + (x.quality || 0), 0) / sessions.length
    : 0;

  const mastery = catalog.map((t) => ({
    topic: t.name,
    subject: t.subjectName,
    mastery: Number(((state.topics?.[t.id]?.mastery || 0) * 100).toFixed(1)),
    dueDate: state.topics?.[t.id]?.dueDate || null
  }));

  const weak = [...mastery].sort((a, b) => a.mastery - b.mastery).slice(0, 5);
  const adoption = sessions.length ? Math.min(1, sessions.length / Math.max(1, days.length * 3)) : 0;

  return {
    day,
    generatedAt: new Date().toISOString(),
    sessions: sessions.length,
    minutes,
    hours: Number((minutes / 60).toFixed(1)),
    avgQuality: Number(avgQuality.toFixed(2)),
    activeDays: days.filter((d) => (d.sessions || []).length).length,
    perSubject: [...bySubject.entries()].map(([name, mins]) => ({ name, minutes: mins })),
    weakest: weak,
    coverage: Number(adoption.toFixed(2)),
    streak: state.meta?.streakDays || 0,
    mastery
  };
}

export function reportMarkdown(report, { config } = {}) {
  const lines = [`# تقرير AALL الأسبوعي — ${report.day}`, ''];
  lines.push(`- جلسات: **${report.sessions}**`);
  lines.push(`- وقت فعلي: **${report.hours} ساعة** (${report.minutes} دقيقة)`);
  lines.push(`- متوسط جودة الاسترجاع: **${report.avgQuality}/5**`);
  lines.push(`- أيام نشطة: **${report.activeDays}**`);
  lines.push(`- سلسلة الاستمرارية: **${report.streak} يوم**`);
  lines.push('');

  if (report.perSubject.length) {
    lines.push('## الوقت حسب المادة');
    for (const s of report.perSubject.sort((a, b) => b.minutes - a.minutes)) {
      lines.push(`- ${s.name}: ${s.minutes} دقيقة`);
    }
    lines.push('');
  }

  if (report.weakest.length) {
    lines.push('## أضعف خمسة مواضيع');
    for (const w of report.weakest) {
      lines.push(`- ${w.topic} (${w.subject}): ${w.mastery}% — استحقاق ${w.dueDate || '—'}`);
    }
    lines.push('');
  }

  lines.push('## قراءة نقدية');
  if (!report.sessions) {
    lines.push('- لم تُسجّل أي جلسة هذا الأسبوع. الخطة موجودة، لكن بلا تنفيذ لا يوجد تعلّم. ابدأ بجلسة واحدة فقط.');
  } else if (report.avgQuality < 3) {
    lines.push('- جودة الاسترجاع منخفضة: المشكلة غالبًا في طريقة الدراسة لا في الوقت. استخدم استرجاعًا نشطًا بدل إعادة القراءة.');
  } else if (report.coverage < 0.4) {
    lines.push('- التزامك أقل من نصف الخطة. راجع مقدار الوقت المتاح في الإعدادات بدل الشعور بالذنب.');
  } else {
    lines.push('- الأداء مستقر. لا تزد الوقت؛ زد الصعوبة تدريجيًا (مسائل مركّبة بدل قراءة).');
  }

  const heavy = report.mastery.filter((m) => m.mastery < 40).length;
  if (heavy > report.mastery.length / 2) {
    lines.push(`- ${heavy} موضوعًا تحت 40% إتقان: الخطة تميل إلى التوسّع أكثر من التعميق. انتبه.`);
  }

  lines.push('');
  lines.push('_مُولّد آليًا. لا حاجة لأي إجراء._');
  return lines.join('\n');
}

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

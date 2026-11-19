/* app.js — لوحة التحكم: قراءة الحالة، تسجيل الجلسات، وتشغيل المحرّك يدويًا. */

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let snapshot = null;

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `فشل الطلب (${res.status})`);
  return data;
}

async function load() {
  try {
    snapshot = await api('/api/snapshot');
    render(snapshot);
  } catch (err) {
    toast(`تعذّر تحميل الحالة: ${err.message}`, true);
  }
}

function render(snap) {
  const { plan, automation, meta, topics } = snap;
  const doneMinutes = (snap.todaySessions || []).reduce((s, x) => s + (x.minutes || 0), 0);
  const planned = plan?.plannedMinutes || 0;
  const pct = planned ? Math.min(100, Math.round((doneMinutes / planned) * 100)) : 0;

  $('#todayLabel').textContent = snap.humanDay || snap.day;
  $('#heroTitle').textContent = planned ? `خطة ${snap.humanDay}` : 'لا توجد خطة بعد';
  $('#heroSub').textContent = plan
    ? `${planned} دقيقة موزّعة على ${plan.blocks.length} جلسة · أنجزت ${doneMinutes} دقيقة · ${plan.notes?.[0] || ''}`
    : 'شغّل نبضة لإنشاء خطة اليوم تلقائيًا.';

  const ring = $('#ringFg');
  const circumference = 2 * Math.PI * 52;
  ring.style.strokeDasharray = `${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - pct / 100)}`;
  $('#ringValue').textContent = `${pct}%`;
  $('#ringCaption').textContent = `${doneMinutes} / ${planned} د`;

  $('#statMinutes').textContent = planned || '0';
  $('#statMinutesSub').textContent = `سقف اليوم ${plan?.budgetMinutes ?? '—'} د · متاح ${plan?.capacityMinutes ?? '—'} د`;
  $('#statBlocks').textContent = plan?.blocks.length ?? 0;
  $('#statBlocksSub').textContent = plan ? `مراجعة ${plan.reviewMinutes} د · تعلّم ${plan.learnMinutes} د` : '—';
  $('#statStreak').textContent = `${automation.streak} يوم`;
  $('#statStreakSub').textContent = automation.streakAlive ? 'السلسلة حيّة اليوم' : 'ابدأ جلسة للحفاظ عليها';
  const due = topics.filter((t) => t.due).length;
  $('#statDue').textContent = due;
  $('#statDueSub').textContent = `من ${topics.length} موضوعًا`;

  $('#statusText').textContent = automation.lastTickAt
    ? `نبضة كل ${automation.tickMinutes} د · آخرها ${new Date(automation.lastTickAt).toLocaleTimeString('ar-MA', { hour: '2-digit', minute: '2-digit' })}`
    : 'لم تحدث نبضة بعد';

  $('#planTag').textContent = plan ? `${plan.blocks.length} جلسة` : 'بدون خطة';

  // الجدول الزمني
  const timeline = $('#timeline');
  if (!plan || !plan.blocks.length) {
    timeline.innerHTML = `<div class="empty">لا جلسات اليوم. قد يكون اليوم راحة، أو أن الوقت المتاح مستهلك بالكامل.</div>`;
  } else {
    timeline.innerHTML = plan.blocks
      .map(
        (b) => `
      <li class="tl-item">
        <div class="tl-time"><strong>${esc(b.start)}</strong>${esc(b.end)}</div>
        <span class="tl-dot" style="background:${esc(b.color)}"></span>
        <div class="tl-card">
          <h4>${esc(b.topicName)} <span class="chip ${b.kind === 'review' ? 'review' : 'learn'}">${b.kind === 'review' ? 'مراجعة' : 'تعلّم جديد'}</span></h4>
          <p>${esc(b.subjectName)} · ${b.minutes} دقيقة · ${esc(b.rationale)}</p>
          <div class="tl-meta">
            <span class="chip">إتقان ${Math.round(b.mastery * 100)}%</span>
            ${b.risk >= 0.55 ? `<span class="chip warn">خطر نسيان ${Math.round(b.risk * 100)}%</span>` : ''}
            ${b.daysToExam !== null ? `<span class="chip">امتحان بعد ${b.daysToExam} يوم</span>` : ''}
          </div>
        </div>
      </li>`
      )
      .join('');
  }

  $('#planNotes').innerHTML = (plan?.notes || []).map((n) => `<p>${esc(n)}</p>`).join('');

  // نقاط الخطر
  const riskList = $('#riskList');
  riskList.innerHTML = (plan?.focus || []).length
    ? plan.focus
        .map(
          (f) => `
      <li class="risk-item">
        <div class="top"><span>${esc(f.topicName)}</span><b>${Math.round(f.risk * 100)}%</b></div>
        <div class="bar"><span style="width:${Math.round(f.risk * 100)}%"></span></div>
        <small style="color:#8fa3bf;font-size:11px">${esc(f.subjectName)} · إتقان ${Math.round(f.mastery * 100)}%</small>
      </li>`
        )
        .join('')
    : `<li class="empty">لا خطر مرتفع الآن.</li>`;

  // الامتحانات
  const examList = $('#examList');
  examList.innerHTML = (plan?.exams || []).length
    ? plan.exams
        .slice(0, 6)
        .map(
          (e) => `
      <li class="exam-item"><span><b>${esc(e.topicName)}</b> · ${esc(e.subjectName)}</span>
      <span class="soon">${e.examDate} · بعد ${e.daysLeft} يوم</span></li>`
        )
        .join('')
    : `<li class="empty">لا امتحانات مسجّلة.</li>`;

  // المواد
  $('#subjects').innerHTML = (snap.subjects || [])
    .map((subject) => {
      const avg = subject.topics.length
        ? Math.round((subject.topics.reduce((s, t) => s + t.mastery, 0) / subject.topics.length) * 100)
        : 0;
      const rows = subject.topics
        .map(
          (t) => `
        <div class="topic-row ${t.due ? 'due' : ''}">
          <div class="topic-name">${esc(t.name)}
            <small>${t.reps} مراجعة · فاصل ${t.intervalDays} يوم · استحقاق ${esc(t.dueDate || '—')}${t.due ? ' · مستحق الآن' : ''}</small>
          </div>
          <div class="mastery">
            <div class="track"><div class="fill" style="width:${Math.round(t.mastery * 100)}%"></div></div>
            <span>${Math.round(t.mastery * 100)}%</span>
          </div>
          <div class="review-btns" data-topic="${esc(t.id)}">
            <button class="rate" data-q="1" title="تعثّرت — أعد الجدولة قريبًا">تعثّر</button>
            <button class="rate" data-q="3" title="صعب">صعب</button>
            <button class="rate" data-q="4" title="جيد">جيد</button>
            <button class="rate" data-q="5" title="سهل">سهل</button>
          </div>
        </div>`
        )
        .join('');
      return `
      <div class="subject-group">
        <div class="subject-head">
          <span class="sq" style="background:${esc(subject.color || '#7dd3fc')}"></span>
          ${esc(subject.name)}
          <span class="avg">متوسط الإتقان ${avg}%</span>
        </div>
        ${rows || '<div class="empty">لا مواضيع — أضف موضوعًا من النموذج.</div>'}
      </div>`;
    })
    .join('');

  // التشغيل الذاتي
  const pendingCount = snap.pending?.length || 0;
  $('#autoKv').innerHTML = `
    <dt>آخر نبضة</dt><dd>${automation.lastTickAt ? new Date(automation.lastTickAt).toLocaleString('ar-MA') : '—'}</dd>
    <dt>دورية النبضة</dt><dd>كل ${automation.tickMinutes} دقيقة</dd>
    <dt>التسليم التلقائي</dt><dd class="${automation.autoDispatch ? 'good' : 'warn'}">${automation.autoDispatch ? 'مفعّل' : 'يدوي'}</dd>
    <dt>الموجز اليومي</dt><dd>${automation.dailyBriefHour}:00</dd>
    <dt>صندوق صادر معلّق</dt><dd class="${pendingCount ? 'warn' : 'good'}">${pendingCount}</dd>
    <dt>جلسات مسجّلة</dt><dd>${automation.totalSessions}</dd>
    <dt>وقت تراكمي</dt><dd>${(automation.totalMinutes / 60).toFixed(1)} ساعة</dd>
    <dt>الموفّرون</dt><dd>${Object.entries(snap.providers || {}).map(([k, v]) => `${k}:${v}`).join(' · ')}</dd>
    ${pendingCount ? `<dt>أنواع معلّقة</dt><dd>${[...new Set(snap.pending.map((p) => p.kind))].map(esc).join(' · ')}</dd>` : ''}
  `;

  // اختيار المادة
  const select = $('#subjectSelect');
  const current = select.value;
  select.innerHTML = (snap.subjects || [])
    .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
    .join('');
  if (current) select.value = current;
}

// ---------------------------------------------------------------------------
// الأحداث
// ---------------------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const rate = event.target.closest('.rate');
  if (!rate) return;
  const topicId = rate.closest('.review-btns')?.dataset.topic;
  const quality = Number(rate.dataset.q);
  const minutes = quality === 1 ? 20 : 45;
  rate.disabled = true;
  try {
    const res = await api('/api/review', {
      method: 'POST',
      body: JSON.stringify({ topicId, quality, minutes })
    });
    toast(`تم التسجيل · الإتقان ${Math.round(res.mastery * 100)}% · المراجعة القادمة ${res.dueDate}`);
    await load();
  } catch (err) {
    toast(err.message, true);
  } finally {
    rate.disabled = false;
  }
});

$('#tickBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await api('/api/tick', { method: 'POST', body: JSON.stringify({}) });
    toast(`نبضة ${res.day} · جديد: ${res.created.join('، ') || 'لا شيء'} · معلّق: ${res.pending}`);
    await load();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#dispatchBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await api('/api/dispatch', { method: 'POST', body: JSON.stringify({}) });
    toast(`تم التسليم: ${res.sent} نجح · ${res.failed} فشل`);
    await load();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#reportBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const res = await api('/api/report', { method: 'POST', body: JSON.stringify({}) });
    showReport(res.markdown, res.name);
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('#addTopicForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const payload = {
      subjectId: $('#subjectSelect').value,
      name: $('#topicName').value.trim(),
      difficulty: Number($('#topicDifficulty').value),
      minutes: Number($('#topicMinutes').value)
    };
    const exam = $('#topicExam').value;
    if (exam) payload.examDate = exam;
    await api('/api/topics', { method: 'POST', body: JSON.stringify(payload) });
    $('#topicName').value = '';
    toast('أُضيف الموضوع — سيدخل التخطيط في النبضة القادمة.');
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

$('#addSubjectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const name = $('#subjectName').value.trim();
    await api('/api/subjects', { method: 'POST', body: JSON.stringify({ name }) });
    $('#subjectName').value = '';
    toast(`أُضيفت المادة «${name}».`);
    await load();
  } catch (err) {
    toast(err.message, true);
  }
});

// نافذة التقرير
function showReport(markdown, name) {
  const dialog = $('#reportDialog');
  $('#reportTitle').textContent = `تقرير ${name || ''}`;
  $('#reportBody').textContent = markdown;
  dialog.showModal();
}

$('#reportClose').addEventListener('click', () => $('#reportDialog').close());

// تحديث دوري هادئ كل 60 ثانية (بلا إزعاج)
setInterval(() => {
  if (!document.hidden) load();
}, 60_000);

load();

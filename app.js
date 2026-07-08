/* =========================================================================
   SwimCoach AI — тренерский разбор заплыва (MVP)
   Вся продуктовая логика на правилах: коррекция пульса, детекция пауз,
   чистая статистика, оценки, выводы, программа. Отсутствующие данные = null.
   ========================================================================= */

'use strict';

/* ---------- Пресеты таблицы коррекции пульса (сырой → поправка, узлы) ----------
   Значения по умолчанию для Huawei GT 5 Pro (из PRD: 140→−4, 150→−6, 175→−14). */
const CORRECTION_PRESETS = {
  huawei_gt5: [
    { hr: 120, d: 0 },
    { hr: 130, d: -2 },
    { hr: 140, d: -4 },
    { hr: 150, d: -6 },
    { hr: 160, d: -10 },
    { hr: 175, d: -14 },
    { hr: 190, d: -18 },
  ],
  generic: [
    { hr: 120, d: 0 },
    { hr: 140, d: -2 },
    { hr: 160, d: -5 },
    { hr: 180, d: -9 },
    { hr: 195, d: -12 },
  ],
  none: [{ hr: 100, d: 0 }, { hr: 200, d: 0 }],
};

/* ---------- Образец тренировки (метры, секунды, гребки, сырой пульс) ----------
   Содержит паузы у бортика (SWOLF ~100) и финальный спринт (SWOLF 27). */
const SAMPLE = [
  { distance: 50, time: 60, strokes: 46, hr: 126 },
  { distance: 50, time: 58, strokes: 44, hr: 130 },
  { distance: 50, time: 53, strokes: 40, hr: 146 },
  { distance: 50, time: 52, strokes: 41, hr: 150 },
  { distance: 25, time: 92, strokes: 11, hr: 150 }, // пауза у бортика
  { distance: 50, time: 54, strokes: 40, hr: 158 },
  { distance: 50, time: 55, strokes: 42, hr: 162 },
  { distance: 25, time: 88, strokes: 9,  hr: 155 }, // пауза у бортика
  { distance: 50, time: 51, strokes: 39, hr: 168 },
  { distance: 50, time: 52, strokes: 40, hr: 171 },
  { distance: 25, time: 14, strokes: 13, hr: 175 }, // спринт
  { distance: 50, time: 70, strokes: 44, hr: 148 }, // заминка
];

const SAMPLE_CSV = SAMPLE.map((s) => `${s.distance},${s.time},${s.strokes},${s.hr}`).join('\n');

/* ---------- Состояние приложения ---------- */
const state = {
  raw: null,            // распарсенные строки
  correction: null,     // рабочая таблица коррекции (копия пресета)
  poolLen: 25,
  age: 30,
  model: 'huawei_gt5',
};

/* =========================================================================
   1. Коррекция пульса: кусочно-линейная интерполяция по узлам
   ========================================================================= */
function correctHR(rawHr, table) {
  if (rawHr == null || Number.isNaN(rawHr)) return null;
  const nodes = [...table].sort((a, b) => a.hr - b.hr);
  if (rawHr <= nodes[0].hr) return Math.round(rawHr + nodes[0].d);
  const last = nodes[nodes.length - 1];
  if (rawHr >= last.hr) return Math.round(rawHr + last.d);
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (rawHr >= a.hr && rawHr <= b.hr) {
      const t = (rawHr - a.hr) / (b.hr - a.hr);
      const d = a.d + t * (b.d - a.d);
      return Math.round(rawHr + d);
    }
  }
  return Math.round(rawHr);
}

/* =========================================================================
   2. Производные метрики отрезка + нормализация SWOLF на длину бассейна
   ========================================================================= */
function enrichSplit(s, poolLen, table) {
  const lengths = s.distance / poolLen;             // сколько «бассейнов» в отрезке
  const pace100 = (s.time / s.distance) * 100;      // сек / 100 м
  const swolf = lengths > 0 ? s.time / lengths + s.strokes / lengths : null; // на длину бассейна
  const hrCorr = correctHR(s.hr, table);
  return {
    ...s,
    lengths,
    pace100,
    swolf: swolf != null ? Math.round(swolf) : null,
    hrRaw: s.hr,
    hrCorr,
  };
}

/* =========================================================================
   3. Детекция пауз — калибровка по базовому уровню самого спортсмена
   Правило: пустой график гребков (strokes≈0) ИЛИ аномальные темп/SWOLF
   относительно медианы «похоже-на-плавание» отрезков.
   ========================================================================= */
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function detectPauses(splits) {
  // Базовый уровень считаем по «быстрым» 60% отрезков — вероятное реальное плавание.
  const byPace = [...splits].filter((s) => s.pace100 != null).sort((a, b) => a.pace100 - b.pace100);
  const coreCount = Math.max(3, Math.round(byPace.length * 0.6));
  const core = byPace.slice(0, coreCount);
  const basePace = median(core.map((s) => s.pace100));
  const baseSwolf = median(core.map((s) => s.swolf).filter((v) => v != null));

  splits.forEach((s) => {
    const noStrokes = s.strokes <= 3 && s.pace100 > basePace * 1.4;
    const slowPace = basePace != null && s.pace100 > basePace * 1.5;
    const highSwolf = baseSwolf != null && s.swolf != null && s.swolf > baseSwolf * 1.6;
    s.isPause = Boolean(noStrokes || slowPace || highSwolf);
  });

  return { basePace, baseSwolf };
}

/* =========================================================================
   4. Классификация: спринт (лучший активный SWOLF) и рабочие отрезки
   ========================================================================= */
function classify(splits) {
  const active = splits.filter((s) => !s.isPause && s.swolf != null);
  if (!active.length) return;
  const bestSwolf = Math.min(...active.map((s) => s.swolf));
  // Спринт: заметно ниже медианы рабочего SWOLF и быстрый темп.
  const workSwolfMed = median(active.map((s) => s.swolf));
  active.forEach((s) => {
    s.isSprint = s.swolf === bestSwolf && s.swolf < workSwolfMed * 0.8;
  });
}

/* =========================================================================
   5. Пульсовые зоны (на скорректированном пульсе), max HR = 220 − возраст
   ========================================================================= */
const ZONE_DEFS = [
  { key: 'Z1', name: 'Восстановление', lo: 0.50, hi: 0.60, color: '#5aa9e6' },
  { key: 'Z2', name: 'Аэробная база',  lo: 0.60, hi: 0.70, color: '#3ddc97' },
  { key: 'Z3', name: 'Темповая',       lo: 0.70, hi: 0.80, color: '#ffc155' },
  { key: 'Z4', name: 'Порог',          lo: 0.80, hi: 0.90, color: '#ff8f6b' },
  { key: 'Z5', name: 'Максимум',       lo: 0.90, hi: 1.01, color: '#ff6b6b' },
];

function computeZones(splits, maxHr) {
  const zones = ZONE_DEFS.map((z) => ({ ...z, time: 0 }));
  let total = 0;
  splits.filter((s) => !s.isPause && s.hrCorr != null).forEach((s) => {
    const frac = s.hrCorr / maxHr;
    const z = zones.find((zz) => frac >= zz.lo && frac < zz.hi) || zones[zones.length - 1];
    z.time += s.time;
    total += s.time;
  });
  zones.forEach((z) => (z.pct = total ? z.time / total : 0));
  return { zones, total };
}

/* =========================================================================
   6. Сводная статистика (чистая — без пауз) + разрыв потенциал/реализация
   ========================================================================= */
function summarize(splits, poolLen, maxHr) {
  const active = splits.filter((s) => !s.isPause);
  const pauses = splits.filter((s) => s.isPause);

  const activeDist = active.reduce((a, s) => a + s.distance, 0);
  const activeTime = active.reduce((a, s) => a + s.time, 0);
  const totalTime = splits.reduce((a, s) => a + s.time, 0);
  const restTime = pauses.reduce((a, s) => a + s.time, 0);

  const workSplits = active.filter((s) => !s.isSprint && s.swolf != null);
  const sprint = active.find((s) => s.isSprint) || null;

  const avgPace = activeDist ? (activeTime / activeDist) * 100 : null;
  const avgSwolfWork = workSplits.length ? Math.round(median(workSplits.map((s) => s.swolf))) : null;
  const bestSprintSwolf = sprint ? sprint.swolf : (active.length ? Math.min(...active.map((s) => s.swolf)) : null);

  const hrCorrVals = active.map((s) => s.hrCorr).filter((v) => v != null);
  const hrRawVals = active.map((s) => s.hrRaw).filter((v) => v != null);
  const avgHrCorr = hrCorrVals.length ? Math.round(hrCorrVals.reduce((a, b) => a + b, 0) / hrCorrVals.length) : null;
  const avgHrRaw = hrRawVals.length ? Math.round(hrRawVals.reduce((a, b) => a + b, 0) / hrRawVals.length) : null;
  const maxHrCorr = hrCorrVals.length ? Math.max(...hrCorrVals) : null;

  // Разрыв потенциал/реализация: рабочий SWOLF / лучший спринтерский.
  const gapRatio = (avgSwolfWork && bestSprintSwolf) ? avgSwolfWork / bestSprintSwolf : null;

  const { zones, total: zoneTotal } = computeZones(splits, maxHr);

  return {
    activeDist, activeTime, totalTime, restTime,
    pauseCount: pauses.length, splitCount: splits.length,
    avgPace, avgSwolfWork, bestSprintSwolf, gapRatio,
    avgHrCorr, avgHrRaw, maxHrCorr, maxHr,
    zones, zoneTotal, sprint,
  };
}

/* =========================================================================
   7. Оценки (0–5) — прозрачные эвристики по фактическим данным
   ========================================================================= */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function computeScores(sum) {
  // Объём: 800 м → 4, 1600 м → 5
  const volume = clamp(sum.activeDist / 320, 1, 5);

  // Интенсивность: доля рабочего времени в Z3+ ближе к сбалансированной
  const hard = sum.zones.filter((z) => ['Z3', 'Z4', 'Z5'].includes(z.key))
    .reduce((a, z) => a + z.pct, 0);
  // Оптимум ~0.5 доли высокоинтенсивной работы
  const intensity = clamp(5 - Math.abs(hard - 0.5) * 6, 1, 5);

  // Техника: чем ниже рабочий SWOLF, тем выше (40→4.5, 60→2.5)
  const technique = sum.avgSwolfWork != null
    ? clamp(5 - (sum.avgSwolfWork - 34) / 8, 1, 5) : null;

  // Восстановление: сколько времени провели в Z1–Z2
  const easy = sum.zones.filter((z) => ['Z1', 'Z2'].includes(z.key))
    .reduce((a, z) => a + z.pct, 0);
  const recovery = clamp(2 + easy * 4, 1, 5);

  const parts = [volume, intensity, technique, recovery].filter((v) => v != null);
  const overall = parts.reduce((a, b) => a + b, 0) / parts.length;

  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  return {
    overall: r1(overall),
    volume: r1(volume),
    intensity: r1(intensity),
    technique: r1(technique),
    recovery: r1(recovery),
  };
}

/* =========================================================================
   8. Выводы — только по фактам, ключевой инсайт: разрыв потенциал/реализация
   ========================================================================= */
function buildInsights(sum, scores) {
  const out = [];

  if (sum.avgHrRaw != null && sum.avgHrCorr != null && sum.avgHrRaw !== sum.avgHrCorr) {
    out.push({ type: 'key', ic: '❤️',
      text: `Средний пульс скорректирован с ${sum.avgHrRaw} до ${sum.avgHrCorr} уд/мин — интенсивность ниже, чем показали часы. Все зоны и оценки построены на скорректированном пульсе.` });
  }

  if (sum.pauseCount > 0) {
    out.push({ type: 'pos', ic: '✂️',
      text: `Обнаружено пауз: ${sum.pauseCount} (${fmtTime(sum.restTime)} у бортика). Исключены из статистики техники — средние не испорчены.` });
  }

  if (sum.gapRatio != null) {
    const pct = Math.round((sum.gapRatio - 1) * 100);
    if (sum.gapRatio >= 1.4) {
      out.push({ type: 'neg', ic: '🎯',
        text: `Разрыв потенциал/реализация: рабочий SWOLF ${sum.avgSwolfWork} против спринтерского ${sum.bestSprintSwolf} (+${pct}%). Техника есть, но в основном режиме ты её не используешь — это главный резерв.` });
    } else {
      out.push({ type: 'pos', ic: '🎯',
        text: `Разрыв потенциал/реализация небольшой: рабочий SWOLF ${sum.avgSwolfWork} близок к спринтерскому ${sum.bestSprintSwolf}. Техника стабильно переносится в рабочий режим.` });
    }
  }

  if (scores.technique != null && scores.technique < 3) {
    out.push({ type: 'neg', ic: '🛠️',
      text: `Рабочий SWOLF ${sum.avgSwolfWork} высоковат — стоит добавить технические упражнения на длину гребка.` });
  } else if (scores.technique != null && scores.technique >= 4) {
    out.push({ type: 'pos', ic: '💧',
      text: `Хорошая экономичность гребка: рабочий SWOLF ${sum.avgSwolfWork}.` });
  }

  if (sum.maxHrCorr != null) {
    const frac = sum.maxHrCorr / sum.maxHr;
    if (frac >= 0.9) out.push({ type: 'neg', ic: '🔥',
      text: `Пиковый скорректированный пульс ${sum.maxHrCorr} — это ${Math.round(frac * 100)}% от максимума. Тренировка затронула зону максимума.` });
  }

  return out;
}

/* =========================================================================
   9. Программа следующей тренировки — правила под слабое место
   ========================================================================= */
function buildProgram(sum, scores) {
  let goal, sets;
  const focusTechnique = sum.gapRatio != null && sum.gapRatio >= 1.4;

  if (focusTechnique) {
    goal = 'перенос техники в рабочий режим (сокращение разрыва потенциал/реализация)';
    sets = [
      { vol: '400 м', desc: 'Разминка спокойно', sub: 'вольный стиль, дыхание 3' },
      { vol: '6×50 м', desc: 'Технические: считаем гребки, минус 1 гребок каждые 50', sub: 'отдых 20 сек, держим SWOLF ≤ ' + Math.round((sum.bestSprintSwolf + sum.avgSwolfWork) / 2) },
      { vol: '8×50 м', desc: 'Рабочий темп на длинном гребке', sub: 'цель: рабочий SWOLF ближе к спринтерскому ' + sum.bestSprintSwolf },
      { vol: '4×25 м', desc: 'Спринт с идеальной техникой', sub: 'полный отдых, контроль гребков' },
      { vol: '200 м', desc: 'Заминка', sub: 'легко, восстановление' },
    ];
  } else if (scores.intensity != null && scores.intensity < 3) {
    goal = 'добавить интенсивности и работы в пороговой зоне';
    sets = [
      { vol: '400 м', desc: 'Разминка', sub: 'нарастающе' },
      { vol: '5×100 м', desc: 'Пороговые интервалы', sub: 'отдых 30 сек, пульс в Z4' },
      { vol: '4×50 м', desc: 'Быстро', sub: 'отдых 40 сек' },
      { vol: '200 м', desc: 'Заминка', sub: 'легко' },
    ];
  } else {
    goal = 'поддержание объёма и аэробной базы';
    sets = [
      { vol: '400 м', desc: 'Разминка', sub: 'ровно' },
      { vol: '4×200 м', desc: 'Аэробно на технике', sub: 'отдых 30 сек, ровный SWOLF' },
      { vol: '6×50 м', desc: 'Ускорения по 25', sub: 'отдых 20 сек' },
      { vol: '200 м', desc: 'Заминка', sub: 'легко' },
    ];
  }

  const total = sets.reduce((a, s) => {
    const m = s.vol.match(/(\d+)(?:×(\d+))?/);
    if (!m) return a;
    return a + (m[2] ? Number(m[1]) * Number(m[2]) : Number(m[1]));
  }, 0);

  return { goal, sets, total };
}

/* =========================================================================
   Форматтеры
   ========================================================================= */
function fmtPace(sec100) {
  if (sec100 == null) return '—';
  const m = Math.floor(sec100 / 60);
  const s = Math.round(sec100 % 60);
  return `${m}'${String(s).padStart(2, '0')}"`;
}
function fmtTime(sec) {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

/* =========================================================================
   Парсинг импорта
   ========================================================================= */
function parseCSV(text) {
  const rows = [];
  text.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (/[a-zА-Яа-я]/i.test(t.replace(/[eе]?\d/gi, '')) && /distance|дист/i.test(t)) return; // заголовок
    const parts = t.split(/[,;\t]+/).map((x) => Number(x.trim()));
    if (parts.length < 4 || parts.some((n) => Number.isNaN(n))) return;
    rows.push({ distance: parts[0], time: parts[1], strokes: parts[2], hr: parts[3] });
  });
  return rows;
}

/* =========================================================================
   Главный конвейер: данные → разбор → рендер
   ========================================================================= */
function analyze() {
  if (!state.raw || !state.raw.length) return;
  const table = state.correction;
  const poolLen = state.poolLen;
  const maxHr = 220 - state.age;

  const splits = state.raw.map((s) => enrichSplit(s, poolLen, table));
  detectPauses(splits);
  classify(splits);
  const sum = summarize(splits, poolLen, maxHr);
  const scores = computeScores(sum);
  const insights = buildInsights(sum, scores);
  const program = buildProgram(sum, scores);

  render({ splits, sum, scores, insights, program });
}

/* =========================================================================
   Рендер
   ========================================================================= */
const $ = (id) => document.getElementById(id);

function render({ splits, sum, scores, insights, program }) {
  $('emptyState').classList.add('hidden');
  $('dashboard').classList.remove('hidden');

  // Заголовок + бейдж оценки
  const totalDist = splits.reduce((a, s) => a + s.distance, 0);
  $('workoutMeta').textContent =
    `${totalDist} м всего · ${fmtTime(sum.totalTime)} · ${sum.splitCount} отрезков`;
  const badge = $('gradeBadge');
  badge.querySelector('.grade-num').textContent = scores.overall ?? '—';
  badge.style.setProperty('--pct', `${(scores.overall ?? 0) / 5 * 100}%`);

  // Метрики
  renderMetrics(sum);

  // Графики
  $('hrChart').innerHTML = renderHRChart(splits);
  $('hrNote').textContent = sum.avgHrRaw != null
    ? `сред. ${sum.avgHrRaw} → ${sum.avgHrCorr} уд/мин` : '';
  $('swolfChart').innerHTML = renderSwolfChart(splits);

  // Зоны
  renderZones(sum);

  // Таблица
  renderSplits(splits);
  $('splitsCount').textContent = `${sum.pauseCount} пауз исключено`;

  // Оценки
  renderScores(scores);

  // Выводы
  $('insights').innerHTML = insights.map((i) =>
    `<li class="${i.type}"><span class="ic">${i.ic}</span><span>${i.text}</span></li>`).join('');

  // Программа
  renderProgram(program);

  $('dashboard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function metric(label, value, unit, sub) {
  return `<div class="metric"><div class="m-label">${label}</div>
    <div class="m-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    ${sub ? `<div class="m-sub">${sub}</div>` : ''}</div>`;
}

function renderMetrics(sum) {
  const hrHero = (sum.avgHrRaw != null)
    ? `<div class="metric hero"><div class="m-label">Пульс: сырой → скорректированный</div>
        <div class="m-value dual">
          <span class="raw">${sum.avgHrRaw}</span>
          <span class="arrow">→</span>
          <span class="corr">${sum.avgHrCorr}</span>
          <span class="unit">уд/мин</span>
        </div>
        <div class="m-sub">часы завышают пульс под нагрузкой — расчёты на скорректированном</div></div>`
    : '';

  $('metrics').innerHTML =
    hrHero +
    metric('Чистая дистанция', sum.activeDist, 'м', `без пауз · ${sum.pauseCount} пауз исключено`) +
    metric('Активное время', fmtTime(sum.activeTime), '', `отдых ${fmtTime(sum.restTime)} исключён`) +
    metric('Средний темп', fmtPace(sum.avgPace), '/100м', 'по чистым отрезкам') +
    metric('Рабочий SWOLF', sum.avgSwolfWork ?? '—', '', `спринт ${sum.bestSprintSwolf ?? '—'}`) +
    (sum.gapRatio != null
      ? metric('Разрыв потенциал/реализация', '×' + sum.gapRatio.toFixed(2), '',
          sum.gapRatio >= 1.4 ? 'техника не используется в рабочем режиме' : 'техника переносится в рабочий режим')
      : '');
}

function renderZones(sum) {
  $('zones').innerHTML = sum.zones.map((z) => {
    const pct = Math.round(z.pct * 100);
    return `<div class="zone-row">
      <div class="zone-name">${z.key}<small>${z.name}</small></div>
      <div class="zone-bar"><span style="width:${pct}%;background:${z.color}"></span></div>
      <div class="zone-val">${pct ? pct + '%' : '—'}</div>
    </div>`;
  }).join('');
}

function renderSplits(splits) {
  const head = `<thead><tr>
    <th>#</th><th>Тип</th><th>Дист</th><th>Время</th><th>Темп/100</th><th>SWOLF</th><th>Пульс</th>
  </tr></thead>`;
  const body = splits.map((s, i) => {
    const cls = s.isPause ? 'pause' : (s.isSprint ? 'best' : '');
    const tag = s.isPause
      ? '<span class="tag rest">отдых</span>'
      : (s.isSprint ? '<span class="tag sprint">спринт</span>' : '<span class="tag swim">заплыв</span>');
    const hr = s.hrCorr != null
      ? `<span style="color:var(--corr)">${s.hrCorr}</span><small style="color:var(--raw)"> ${s.hrRaw}</small>`
      : '—';
    return `<tr class="${cls}">
      <td>${i + 1}</td>
      <td>${tag}</td>
      <td>${s.distance} м</td>
      <td>${fmtTime(s.time)}</td>
      <td>${s.isPause ? '—' : fmtPace(s.pace100)}</td>
      <td>${s.isPause ? '—' : (s.swolf ?? '—')}</td>
      <td>${hr}</td>
    </tr>`;
  }).join('');
  $('splitsTable').innerHTML = head + `<tbody>${body}</tbody>`;
}

function renderScores(scores) {
  const rows = [
    ['Общая', scores.overall],
    ['Объём', scores.volume],
    ['Интенсивность', scores.intensity],
    ['Техника', scores.technique],
    ['Восстановление', scores.recovery],
  ];
  const color = (v) => v == null ? 'var(--muted)' : v >= 4 ? 'var(--good)' : v >= 3 ? 'var(--warn)' : 'var(--bad)';
  $('scores').innerHTML = rows.map(([name, v]) => `
    <div class="score-row">
      <div class="score-name">${name}</div>
      <div class="score-bar"><span style="width:${(v ?? 0) / 5 * 100}%;background:${color(v)}"></span></div>
      <div class="score-val" style="color:${color(v)}">${v ?? '—'}</div>
    </div>`).join('');
}

function renderProgram(program) {
  const sets = program.sets.map((s) => `
    <div class="set">
      <div class="set-vol">${s.vol}</div>
      <div class="set-desc">${s.desc}<small>${s.sub}</small></div>
    </div>`).join('');
  $('program').innerHTML =
    `<p class="program-goal">Цель: <b>${program.goal}</b></p>${sets}
     <div class="program-total">Итого ≈ ${program.total} м</div>`;
}

/* ---------- SVG-график пульса: сырой vs скорректированный ---------- */
function renderHRChart(splits) {
  const pts = splits.filter((s) => s.hrRaw != null);
  if (!pts.length) return '<p class="hint">Нет данных пульса</p>';
  const W = 480, H = 160, padX = 8, padY = 16;
  const allHr = pts.flatMap((s) => [s.hrRaw, s.hrCorr]);
  const min = Math.min(...allHr) - 6, max = Math.max(...allHr) + 6;
  const x = (i) => padX + (i / (pts.length - 1 || 1)) * (W - padX * 2);
  const y = (v) => padY + (1 - (v - min) / (max - min)) * (H - padY * 2);
  const line = (key) => pts.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  const dots = (key, col) => pts.map((s, i) =>
    `<circle cx="${x(i).toFixed(1)}" cy="${y(s[key]).toFixed(1)}" r="2.6" fill="${col}"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    <path d="${line('hrRaw')}" fill="none" stroke="var(--raw)" stroke-width="2" opacity="0.85"/>
    <path d="${line('hrCorr')}" fill="none" stroke="var(--corr)" stroke-width="2.4"/>
    ${dots('hrRaw', 'var(--raw)')}${dots('hrCorr', 'var(--corr)')}
  </svg>`;
}

/* ---------- SVG-график SWOLF по отрезкам (паузы серым) ---------- */
function renderSwolfChart(splits) {
  const vals = splits.map((s) => (s.isPause ? Math.min(s.swolf ?? 0, 120) : s.swolf) ?? 0);
  const max = Math.max(...vals, 1);
  const W = 480, H = 150, padY = 14;
  const n = splits.length;
  const bw = (W / n) * 0.62;
  const gap = (W / n);
  const bars = splits.map((s, i) => {
    const v = vals[i];
    const h = (v / max) * (H - padY * 2);
    const cx = gap * i + gap / 2;
    const col = s.isPause ? 'var(--pause)' : (s.isSprint ? 'var(--good)' : 'var(--accent)');
    const label = s.isPause ? '' : `<text x="${cx}" y="${H - padY - h - 4}" text-anchor="middle" font-size="10" fill="var(--muted)">${s.swolf ?? ''}</text>`;
    return `<rect x="${cx - bw / 2}" y="${H - padY - h}" width="${bw}" height="${h}" rx="3" fill="${col}"/>${label}
      <text x="${cx}" y="${H - 2}" text-anchor="middle" font-size="9" fill="var(--muted)">${i + 1}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img">${bars}</svg>`;
}

/* =========================================================================
   Таблица коррекции — редактируемые узлы
   ========================================================================= */
function renderCorrectionTable() {
  const cont = $('correctionTable');
  cont.innerHTML = state.correction.map((node, i) => `
    <div class="corr-node">
      <div class="cn-hr">${node.hr} →</div>
      <input type="number" data-i="${i}" value="${node.d}" step="1" />
    </div>`).join('');
  cont.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', (e) => {
      const i = Number(e.target.dataset.i);
      state.correction[i].d = Number(e.target.value) || 0;
      if (state.raw) analyze();
    });
  });
}

function loadPreset(model) {
  state.model = model;
  state.correction = CORRECTION_PRESETS[model].map((n) => ({ ...n }));
  renderCorrectionTable();
}

/* =========================================================================
   Инициализация и обработчики
   ========================================================================= */
function setData(rows) {
  if (!rows || !rows.length) {
    alert('Не удалось разобрать данные. Проверьте формат: distance,time,strokes,hr');
    return;
  }
  state.raw = rows;
  analyze();
}

function init() {
  loadPreset('huawei_gt5');

  // Тема
  const savedTheme = localStorage.getItem('sc_theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;
  $('themeToggle').textContent = savedTheme === 'dark' ? '🌙' : '☀️';
  $('themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    $('themeToggle').textContent = next === 'dark' ? '🌙' : '☀️';
    localStorage.setItem('sc_theme', next);
    if (state.raw) analyze(); // перерисовать SVG под новую тему
  });

  // Импорт
  $('loadSample').addEventListener('click', () => setData(SAMPLE.map((s) => ({ ...s }))));
  $('emptyLoad').addEventListener('click', () => setData(SAMPLE.map((s) => ({ ...s }))));
  $('toggleCsv').addEventListener('click', () => $('csvBox').classList.toggle('hidden'));
  $('parseCsv').addEventListener('click', () => setData(parseCSV($('csvInput').value)));
  $('fillSampleCsv').addEventListener('click', () => { $('csvInput').value = SAMPLE_CSV; });
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setData(parseCSV(String(r.result)));
    r.readAsText(f);
  });

  // Профиль (сворачивание)
  $('profileToggle').addEventListener('click', () => {
    const p = $('profilePanel');
    const open = p.dataset.open === 'true';
    p.dataset.open = String(!open);
    $('profileToggle').setAttribute('aria-expanded', String(!open));
    $('profileBody').classList.toggle('hidden', open);
  });

  $('watchModel').addEventListener('change', (e) => {
    loadPreset(e.target.value);
    if (state.raw) analyze();
  });
  $('age').addEventListener('change', (e) => {
    state.age = clamp(Number(e.target.value) || 30, 10, 90);
    if (state.raw) analyze();
  });
  $('poolLen').addEventListener('change', (e) => {
    state.poolLen = clamp(Number(e.target.value) || 25, 10, 50);
    if (state.raw) analyze();
  });
}

document.addEventListener('DOMContentLoaded', init);

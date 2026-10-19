'use strict';
// ═══════════════════════════════════════════════════════════════
//  Arduino Web Oscilloscope
//  Web Serial API (Chrome/Edge) · Chart.js 4
// ═══════════════════════════════════════════════════════════════

// ── Configurazione ────────────────────────────────────────────
const CHANNELS = [
  { label: 'CH1', color: '#008184' },
  { label: 'CH2', color: '#FF9900' },
  { label: 'CH3', color: '#FF2B2B' },
  { label: 'CH4', color: '#8E5BD6' },
  { label: 'CH5', color: '#1E88E5' },
  { label: 'CH6', color: '#D4448C' },
];
const NCH = CHANNELS.length;
const MAX_BUFFER = 8192;            // campioni tenuti in memoria per grafico, FFT, XY
const X_MIN = 10, X_MAX = 4000;     // campioni visualizzabili nel frame
const Y_RANGE_MIN = 1e-6, Y_RANGE_MAX = 1e7;
const MAX_LOG = 100;
const MAX_RECORD = 2_000_000;
const ACTIVE_WINDOW = 200;          // un canale resta attivo se ha dati negli ultimi N campioni
const REDRAW_MS = 33, INFO_MS = 200, MEASURE_MS = 300, FFT_MS = 250, XY_MS = 50;
const STORAGE_KEY = 'arduino-oscilloscope.v2';

// ── Utility ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

function fmt(v, digits = 4) {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-4) return v.toExponential(2);
  return v.toFixed(clamp(digits - 1 - Math.floor(Math.log10(a)), 0, 6));
}
function fmtInput(v) { return isNum(v) ? String(Number(v.toPrecision(6))) : '0'; }
function fmtTime(ms) {
  if (!isNum(ms)) return '—';
  const a = Math.abs(ms);
  if (a >= 1000) return `${(ms / 1000).toFixed(a >= 10000 ? 1 : 2)} s`;
  if (a >= 1) return `${ms.toFixed(a >= 100 ? 0 : 1)} ms`;
  return `${(ms * 1000).toFixed(0)} µs`;
}
function fmtFreq(hz) {
  if (!isNum(hz)) return '—';
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${hz.toFixed(hz >= 100 ? 0 : 2)} Hz`;
}
function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function wallTime() {
  const d = new Date();
  return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) +
    '.' + String(d.getMilliseconds()).padStart(3, '0');
}
const isTabActive = id => $(id).classList.contains('active');

// ── Persistenza (localStorage, best effort) ───────────────────
const store = (() => {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { data = {}; }
  let timer = null;
  return {
    get: (k, d) => (k in data ? data[k] : d),
    set(k, v) {
      data[k] = v;
      clearTimeout(timer);
      timer = setTimeout(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* storage non disponibile */ } }, 300);
    },
  };
})();

function saveFormEl(el) {
  const f = store.get('form', {});
  f[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  store.set('form', f);
}
function restoreForm() {
  const f = store.get('form', {});
  document.querySelectorAll('[data-persist]').forEach(el => {
    if (!(el.id in f)) return;
    if (el.type === 'checkbox') { el.checked = !!f[el.id]; return; }
    const prev = el.value;
    el.value = f[el.id];
    if (el.tagName === 'SELECT' && el.value !== String(f[el.id])) el.value = prev;
  });
}
document.addEventListener('change', e => { if (e.target.matches?.('[data-persist]')) saveFormEl(e.target); });
document.addEventListener('input', e => { if (e.target.matches?.('input[type="range"][data-persist]')) saveFormEl(e.target); });

// ── Toast (al posto di alert) ─────────────────────────────────
function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.classList.add('hide'), 3500);
  setTimeout(() => t.remove(), 4000);
}

// ── Tema ──────────────────────────────────────────────────────
let colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  colors = {
    grid: g('--grid'), gridStrong: g('--grid-strong'), muted: g('--muted'), text: g('--text-strong'),
    card: g('--card'), accent: g('--accent'), accentSoft: g('--accent-soft'),
    marker: g('--marker'), trigger: g('--trigger'), cursor: g('--cursor'), fit: g('--fit'),
    math: g('--math'), alarm: g('--warn'), rec: g('--rec'),
  };
}
function applyTheme() {
  const v = $('theme-sel').value;
  if (v === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = v;
  readColors();
  if (chart) applyChartTheme();
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if ($('theme-sel').value === 'auto') applyTheme();
});

// ── Unità (ADC grezzi o Volt) ─────────────────────────────────
const units = { mode: 'adc', k: 1 };
const unitLabel = () => (units.mode === 'v' ? 'V' : 'ADC');

// ═══════════════════════════════════════════════════════════════
//  Stato di acquisizione
// ═══════════════════════════════════════════════════════════════
// Campione: { t: secondi (monotono), v: Array(NCH) di numeri o null }
const buffer = [];
let bufferStart = 0;   // indice assoluto del primo campione nel buffer
let totalCount = 0;    // indice assoluto del prossimo campione (bufferStart + buffer.length)
let paused = false;
let source = 'none';
let latestForLog = null;
let frameCache = null;
const invalidate = () => { frameCache = null; };

const view = Object.assign({ yRange: 512, yOffset: 512, xSamples: 500 }, store.get('view', {}), { logY: false, points: false });
const saveView = () => store.set('view', { yRange: view.yRange, yOffset: view.yOffset, xSamples: view.xSamples });

const decim = { ms: 0, nextMs: -Infinity };
const rate = { lastT: null, dtEma: null, lastHost: 0 };
const chState = CHANNELS.map(() => ({ lastSeen: -1, active: false, name: null }));
const isVisible = i => $(`ch-vis-${i}`).checked;
const rec = { on: false, samples: [] };

function ingest(t, vals) {
  const s = { t, v: vals };
  if (rec.on) recordSample(s);
  if (alarms.enabled) checkAlarms(s);

  if (rate.lastT != null) {
    const dt = t - rate.lastT;
    if (dt > 0) rate.dtEma = rate.dtEma == null ? dt : rate.dtEma * 0.95 + dt * 0.05;
  }
  rate.lastT = t;
  rate.lastHost = performance.now();

  if (paused) return;

  // Decimazione con tolleranza al jitter: si tiene un campione circa ogni decim.ms
  if (decim.ms > 0) {
    const ms = t * 1000;
    if (ms < decim.nextMs - decim.ms * 0.25) return;
    decim.nextMs = Math.max(decim.nextMs + decim.ms, ms + decim.ms * 0.5);
  }

  buffer.push(s);
  totalCount++;
  if (buffer.length > MAX_BUFFER + 1024) {
    const drop = buffer.length - MAX_BUFFER;
    buffer.splice(0, drop);
    bufferStart += drop;
  }

  let newCh = false;
  for (let i = 0; i < NCH; i++) {
    if (vals[i] == null) continue;
    chState[i].lastSeen = totalCount - 1;
    if (!chState[i].active) newCh = true;
  }
  if (newCh) updateChannelActivity();

  trigOnSample(s, totalCount - 1);
  latestForLog = s;
  invalidate();
  requestRedraw();
}

function updateChannelActivity() {
  const win = Math.max(view.xSamples, ACTIVE_WINDOW);
  let changed = false;
  chState.forEach(c => {
    const act = c.lastSeen >= 0 && c.lastSeen >= totalCount - win;
    if (act !== c.active) { c.active = act; changed = true; }
  });
  if (changed) onChannelsChanged();
}

function onChannelsChanged() {
  CHANNELS.forEach((_, i) => {
    $(`ch-lbl-${i}`).hidden = !chState[i].active;
    $(`fft-ch-lbl-${i}`).hidden = !chState[i].active;
  });
  const any = chState.some(c => c.active);
  $('ch-empty').hidden = any;
  $('fft-ch-empty').hidden = any;
  requestRedraw();
}

// Led nel menu degli strumenti per gli interruttori ATTIVO accesi
function updateLeds() {
  document.querySelectorAll('[data-led]').forEach(el => {
    document.querySelector(`.tab-btn[data-tab="${el.dataset.led}"]`)?.classList.toggle('on', el.checked);
  });
}

function clearAll() {
  buffer.length = 0;
  bufferStart = totalCount;
  chState.forEach(c => { c.lastSeen = -1; c.active = false; });
  rate.lastT = null; rate.dtEma = null;
  decim.nextMs = -Infinity;
  trig.frame = null;
  rearmTrigger();
  sel.x0 = sel.x1 = null;
  if (fit.enabled) setFitEnabled(false);
  latestForLog = null;
  $('values-list').replaceChildren();
  invalidate();
  onChannelsChanged();
}

function setSource(src) {
  source = src;
  $('info-source').textContent = { none: '—', serial: 'Seriale', gen: 'Generatore' }[src];
}

// ── Frame visualizzato ────────────────────────────────────────
// Live: ultimi xSamples campioni, t = 0 al primo campione.
// Trigger: frame catturato, t = 0 al punto di trigger (interpolato).
// Alla prima cattura il frame si riempie man mano che arrivano i campioni.
function getFrame() {
  if (frameCache) return frameCache;
  if (trig.enabled) {
    if (trig.frame) return (frameCache = trig.frame);
    if (trig.state === 'capturing') return (frameCache = buildTrigFrame(true));
  }
  const samples = buffer.slice(-view.xSamples);
  return (frameCache = { samples, tRef: samples.length ? samples[0].t : 0, trig: false });
}

// ═══════════════════════════════════════════════════════════════
//  Trigger
// ═══════════════════════════════════════════════════════════════
const trig = {
  enabled: false, mode: 'auto', ch: 0, edge: 'rising', level: 0, pos: 0.25, hold: 0,
  state: 'off', frame: null, trigAbs: -1, trigT: 0, prev: null, prevT: 0, holdTimer: null,
  hyst: 0, outOfRange: false, low: false, high: false, capturedAt: 0, sinceCheck: 0, pct: -1,
};

function trigPrePost() {
  const pre = Math.round(view.xSamples * trig.pos);
  return { pre, post: view.xSamples - pre };
}

function buildTrigFrame(partial) {
  const { pre, post } = trigPrePost();
  const start = Math.max(bufferStart, trig.trigAbs - pre) - bufferStart;
  const fr = { samples: buffer.slice(start, start + view.xSamples), tRef: trig.trigT, trig: true };
  // frame parziale: l'asse X mostra già tutta la durata prevista dopo il trigger
  if (partial && rate.dtEma) fr.xMaxMs = post * rate.dtEma * 1000;
  return fr;
}

// Escursione recente del canale di trigger (livello automatico e isteresi)
function trigRange() {
  let mn = Infinity, mx = -Infinity;
  for (let i = Math.max(0, buffer.length - 500); i < buffer.length; i++) {
    const v = buffer[i].v[trig.ch];
    if (v == null) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  return mn < mx ? { mn, mx } : null;
}

function setTriggerLevel(v) {
  trig.level = v;
  $('trigger-level').value = fmtInput(v);
  saveFormEl($('trigger-level'));
  requestRedraw();
}

function trigLevelTo50() {
  const r = trigRange();
  if (!r) { toast('Nessun dato sul canale di trigger'); return; }
  setTriggerLevel((r.mn + r.mx) / 2);
  rearmTrigger();
}

const autoTimeoutMs = () => Math.max(1000, 2 * view.xSamples * (rate.dtEma || 0.01) * 1000);

function readTriggerSettings() {
  trig.mode = $('trigger-mode').value;
  trig.ch = +$('trigger-channel').value;
  trig.edge = $('trigger-edge').value;
  const lv = parseFloat($('trigger-level').value);
  trig.level = isNum(lv) ? lv : 0;
  trig.pos = parseFloat($('trigger-pos').value);
  trig.hold = parseInt($('trigger-hold').value, 10) || 0;
  rearmTrigger();
  requestRedraw();
}

function rearmTrigger() {
  clearTimeout(trig.holdTimer);
  trig.holdTimer = null;
  Object.assign(trig, { prev: null, low: false, high: false, pct: -1, sinceCheck: 0 });
  const r = trigRange();
  trig.hyst = r ? (r.mx - r.mn) * 0.03 : 0; // isteresi: 3% dell'escursione, contro i falsi trigger da rumore
  trig.outOfRange = !!r && (trig.level <= r.mn || trig.level >= r.mx);
  trig.state = trig.enabled ? 'armed' : 'off';
  invalidate();
  updateTrigUI();
}

function setTriggerEnabled(on) {
  trig.enabled = on;
  trig.frame = null;
  rearmTrigger();
  requestRedraw();
}

function trigOnSample(s, abs) {
  if (trig.state === 'armed') {
    const v = s.v[trig.ch];
    if (v == null) return;

    if (++trig.sinceCheck >= 100) {
      trig.sinceCheck = 0;
      const r = trigRange();
      if (r) {
        trig.hyst = (r.mx - r.mn) * 0.03;
        // il livello non viene mai spostato da solo: si segnala solo se è fuori dal segnale
        const out = trig.level <= r.mn || trig.level >= r.mx;
        if (out !== trig.outOfRange) { trig.outOfRange = out; updateTrigUI(); }
      }
    }
    // AUTO: senza trigger per troppo tempo si torna alla vista libera
    if (trig.mode === 'auto' && trig.frame && performance.now() - trig.capturedAt > autoTimeoutMs()) {
      trig.frame = null;
      invalidate();
      updateTrigUI();
    }

    const p = trig.prev, pT = trig.prevT, L = trig.level, h = trig.hyst;
    trig.prev = v; trig.prevT = s.t;
    if (v < L - h) trig.low = true;
    if (v > L + h) trig.high = true;
    if (p == null) return;
    const up = trig.low && p < L && v >= L;
    const down = trig.high && p > L && v <= L;
    const fire = trig.edge === 'rising' ? up : trig.edge === 'falling' ? down : up || down;
    if (fire) {
      const f = v !== p ? (L - p) / (v - p) : 0;
      trig.trigT = pT + f * (s.t - pT);
      trig.trigAbs = abs;
      Object.assign(trig, { state: 'capturing', low: false, high: false, pct: -1 });
      invalidate();
    }
  }
  if (trig.state === 'capturing') {
    const { post } = trigPrePost();
    const done = abs - trig.trigAbs;
    if (done >= post - 1) captureFrame();
    else {
      const pct = Math.floor((done / post) * 10) * 10;
      if (pct !== trig.pct) { trig.pct = pct; updateTrigUI(); }
    }
  }
}

function captureFrame() {
  trig.frame = buildTrigFrame(false);
  trig.capturedAt = performance.now();
  invalidate();
  requestRedraw();
  if (trig.mode === 'single') { trig.state = 'held'; updateTrigUI(); return; }
  if (trig.hold > 0) {
    trig.state = 'held';
    updateTrigUI();
    trig.holdTimer = setTimeout(() => { trig.holdTimer = null; if (trig.enabled) rearmTrigger(); }, trig.hold);
  } else {
    rearmTrigger();
  }
}

function updateTrigUI() {
  const el = $('trigger-status');
  let text, cls;
  if (!trig.enabled) { text = 'OFF'; cls = 'off'; }
  else if (trig.state === 'held' && trig.mode === 'single') { text = 'STOP · RI-ARMA'; cls = 'warn'; }
  else if (trig.frame) { text = 'TRIGGERATO'; cls = 'ok'; }
  else if (trig.state === 'capturing') { text = `CATTURA ${Math.max(0, trig.pct)}%`; cls = 'warn'; }
  else if (trig.outOfRange) { text = 'LIVELLO FUORI SEGNALE'; cls = 'warn'; }
  else { text = trig.mode === 'auto' ? 'AUTO · LIBERO' : 'IN ATTESA'; cls = 'warn'; }
  el.textContent = text;
  el.className = `badge push ${cls}`;
}

// ═══════════════════════════════════════════════════════════════
//  Generazione dinamica dell'interfaccia per canale
// ═══════════════════════════════════════════════════════════════
const MEASURES = [
  { key: 'vpp', lbl: 'Vpp', unit: '{u}', tip: 'Picco-picco: massimo − minimo' },
  { key: 'mn', lbl: 'Min', unit: '{u}', tip: 'Valore minimo nel frame' },
  { key: 'mx', lbl: 'Max', unit: '{u}', tip: 'Valore massimo nel frame' },
  { key: 'avg', lbl: 'Media', unit: '{u}', tip: 'Valor medio (componente DC)' },
  { key: 'rms', lbl: 'RMS', unit: '{u}', tip: 'RMS totale (DC + AC)' },
  { key: 'acrms', lbl: 'RMS AC', unit: '{u}', tip: 'RMS della sola componente alternata (deviazione standard)' },
  { key: 'freq', lbl: 'Freq', unit: 'Hz', tip: '1 / periodo medio tra i fronti di salita' },
  { key: 'period', lbl: 'Periodo', unit: 'ms', tip: 'Periodo medio tra i fronti di salita al 50%' },
  { key: 'duty', lbl: 'Duty', unit: '%', tip: 'Frazione del periodo sopra il livello al 50%' },
  { key: 'crest', lbl: 'Crest', unit: '×', tip: 'Picco / RMS (sinusoide senza offset ≈ 1.414)' },
  { key: 'slew', lbl: 'Slew', unit: '{u}/ms', tip: 'Massima velocità di variazione' },
  { key: 'cross', lbl: 'Fronti', unit: 'n', tip: 'Attraversamenti del livello al 50% (con isteresi)' },
  { key: 'rise', lbl: 'Salita', unit: 'ms', tip: 'Tempo di salita 10–90%, media su tutti i fronti' },
  { key: 'fall', lbl: 'Discesa', unit: 'ms', tip: 'Tempo di discesa 90–10%, media su tutti i fronti' },
];
const FFT_INFO = [
  { key: 'peakf', lbl: 'Picco freq', unit: 'Hz' },
  { key: 'peaka', lbl: 'Picco amp', unit: '{fft}' },
  { key: 'thd', lbl: 'THD', unit: '%' },
  { key: 'snr', lbl: 'SNR', unit: 'dB' },
  { key: 'fs', lbl: 'Fs', unit: 'Hz' },
  { key: 'df', lbl: 'Risoluz.', unit: 'Hz' },
];
const GEN_PARAMS = [
  { key: 'amp', lbl: 'AMP', min: 0, max: 512, step: 1, val: 256 },
  { key: 'off', lbl: 'OFFSET', min: -1023, max: 1023, step: 1, val: 512 },
  { key: 'freq', lbl: 'FREQ', min: 0.1, max: 100, step: 0.1, val: 1 },
  { key: 'duty', lbl: 'DUTY', min: 1, max: 99, step: 1, val: 50 },
  { key: 'phase', lbl: 'FASE', min: 0, max: 360, step: 1, val: 0 },
  { key: 'noise', lbl: 'RUMORE', min: 0, max: 256, step: 1, val: 0 },
];
const WAVES = [['sine', '∿ Sinusoide'], ['square', '⊓ Quadra'], ['sawtooth', '/ Dente di sega'], ['triangle', '∧ Triangolare'], ['noise', '≋ Rumore'], ['dc', '— DC']];

const cellHtml = (id, lbl, unit, tip = '') =>
  `<div class="meas-cell"${tip ? ` title="${tip}"` : ''}><span class="meas-lbl">${lbl}</span><span class="meas-val" id="${id}">—</span><span class="meas-unit" data-unit="${unit}"></span></div>`;

function buildUi() {
  // I toggle dei canali compaiono solo quando arrivano dati (vedi onChannelsChanged)
  $('ch-toggles').innerHTML = CHANNELS.map((c, i) => `
    <label class="tgl ch" id="ch-lbl-${i}" style="--ch:${c.color}" hidden>
      <input type="checkbox" id="ch-vis-${i}" checked data-persist>
      <span class="ch-dot"></span>${c.label}<span class="ch-name" id="ch-name-${i}"></span>
    </label>`).join('');

  $('stats-rows').innerHTML = CHANNELS.map((c, i) => `
    <div class="stats-grid" id="stats-row-${i}" hidden>
      <span class="schl" style="--ch:${c.color}">${c.label}</span>
      ${['min', 'max', 'avg', 'last'].map(k => `<span id="stat-${k}-${i}">—</span>`).join('')}
    </div>`).join('');

  const chOptions = CHANNELS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
  document.querySelectorAll('.ch-select').forEach(s => { s.innerHTML = chOptions; });
  $('xy-ch-y').value = '1';
  $('math-b').value = '1';
  $('stats-rows').insertAdjacentHTML('beforeend', `
    <div class="stats-grid" id="stats-row-math" hidden>
      <span class="schl" style="--ch:var(--math)">MATH</span>
      ${['min', 'max', 'avg', 'last'].map(k => `<span id="stat-${k}-math">—</span>`).join('')}
    </div>`);

  $('gen-strips').innerHTML = CHANNELS.map((c, i) => `
    <div class="ch-block" id="gen-strip-${i}" style="--ch:${c.color}" hidden>
      <div class="ch-block-head">
        <label class="tgl ch"><input type="checkbox" id="gen-on-${i}" checked data-persist><span class="ch-dot"></span>${c.label}</label>
        <select id="gen-wave-${i}" class="sel push" data-persist aria-label="Forma d'onda ${c.label}">${WAVES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <button class="icon-btn" data-gen-remove="${i}" aria-label="Rimuovi ${c.label}" title="Rimuovi">✕</button>
      </div>
      <div class="gen-params">
        ${GEN_PARAMS.map(p => `
          <div class="gen-param" id="gen-${p.key}-row-${i}">
            <div class="gen-param-row"><label class="lbl" for="gen-${p.key}-${i}">${p.lbl}</label><span class="gen-val" id="gen-${p.key}-v-${i}"></span></div>
            <input type="range" id="gen-${p.key}-${i}" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.val}" data-persist>
          </div>`).join('')}
      </div>
    </div>`).join('');
  $('gen-add-btns').innerHTML = CHANNELS.map((c, i) =>
    `<button class="btn" data-gen-add="${i}" id="gen-add-${i}">+ ${c.label}</button>`).join('');

  $('meas-blocks').innerHTML = CHANNELS.map((c, i) => `
    <div class="ch-block" id="meas-block-${i}" style="--ch:${c.color}" hidden>
      <span class="ch-title">● ${c.label}</span>
      <div class="measure-grid">${MEASURES.map(m => cellHtml(`m-${m.key}-${i}`, m.lbl, m.unit, m.tip)).join('')}</div>
    </div>`).join('');

  $('fft-ch-toggles').innerHTML = CHANNELS.map((c, i) =>
    `<label class="tgl ch" id="fft-ch-lbl-${i}" style="--ch:${c.color}" hidden><input type="checkbox" id="fft-ch-${i}" checked data-persist><span class="ch-dot"></span>${c.label}</label>`).join('') +
    '<span class="muted-text" id="fft-ch-empty">nessun canale con dati</span>';
  $('fft-infos').innerHTML = CHANNELS.map((c, i) => `
    <div class="ch-block" id="fft-info-${i}" style="--ch:${c.color}" hidden>
      <span class="ch-title">● ${c.label}</span>
      <div class="measure-grid">${FFT_INFO.map(m => cellHtml(`fft-${m.key}-${i}`, m.lbl, m.unit)).join('')}</div>
    </div>`).join('');
}

function updateUnitLabels() {
  const fftUnit = $('fft-scale').value === 'db' ? `dB${units.mode === 'v' ? 'V' : ''}` : unitLabel();
  document.querySelectorAll('[data-unit]').forEach(el => {
    el.textContent = el.dataset.unit.replace('{u}', unitLabel()).replace('{fft}', fftUnit);
  });
}

function updateChannelNames() {
  CHANNELS.forEach((c, i) => {
    const name = chState[i].name;
    $(`ch-name-${i}`).textContent = name ? ` · ${name}` : '';
    document.querySelectorAll(`.ch-select option[value="${i}"]`).forEach(o => { o.textContent = name ? `${c.label} · ${name}` : c.label; });
  });
}

// ═══════════════════════════════════════════════════════════════
//  Grafico principale
// ═══════════════════════════════════════════════════════════════
const tickFont = { family: 'Courier New, monospace', size: 11 };
let chart = null, fftChart = null;
let xSpanMs = 1;
let lastStyleKey = '';

const hMarkers = [];   // valori Y dei marker orizzontali
const vCursors = [];   // valori X (ms) dei cursori verticali, max 2
const sel = { x0: null, x1: null };
const selRange = () => [Math.min(sel.x0, sel.x1), Math.max(sel.x0, sel.x1)];

function divisions(n) {
  return axis => {
    if (axis.type !== 'linear') return;
    const { min, max } = axis;
    axis.ticks = Array.from({ length: n + 1 }, (_, i) => ({ value: min + ((max - min) * i) / n }));
  };
}
function stepDecimals(step) { return clamp(1 - Math.floor(Math.log10(step || 1)), 0, 6); }
function fmtAxisTime(v) {
  const useS = xSpanMs >= 5000;
  const val = useS ? v / 1000 : v;
  return val.toFixed(stepDecimals((useS ? xSpanMs / 1000 : xSpanMs) / 10)) + (useS ? 's' : 'ms');
}

function yAxisOptions(log) {
  return {
    type: log ? 'logarithmic' : 'linear',
    afterBuildTicks: divisions(8),
    grid: { color: ctx => (!view.logY && ctx.index === 4 ? colors.gridStrong : colors.grid) },
    border: { color: colors.gridStrong },
    title: { display: true, text: unitLabel(), color: colors.muted, font: tickFont },
    ticks: {
      color: () => colors.muted, font: tickFont,
      callback: v => (view.logY ? fmt(v, 3) : Number(v).toFixed(stepDecimals((view.yRange * 2) / 8))),
    },
  };
}

// Plugin: selezione, marker, cursori, livello e punto di trigger
const overlayPlugin = {
  id: 'overlay',
  afterDraw(c) {
    const { ctx, chartArea: a, scales: { x, y } } = c;
    if (!a) return;
    ctx.save();
    ctx.font = 'bold 10px Courier New, monospace';
    ctx.textBaseline = 'middle';

    if (sel.x0 != null && sel.x1 != null) {
      const p0 = clamp(x.getPixelForValue(Math.min(sel.x0, sel.x1)), a.left, a.right);
      const p1 = clamp(x.getPixelForValue(Math.max(sel.x0, sel.x1)), a.left, a.right);
      ctx.fillStyle = colors.accentSoft;
      ctx.fillRect(p0, a.top, p1 - p0, a.bottom - a.top);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p0, a.top); ctx.lineTo(p0, a.bottom); ctx.moveTo(p1, a.top); ctx.lineTo(p1, a.bottom); ctx.stroke();
    }

    const fr = getFrame();
    if (fr.trig) {
      const px = x.getPixelForValue(0);
      if (px >= a.left && px <= a.right) {
        ctx.strokeStyle = colors.trigger; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = colors.trigger;
        ctx.beginPath(); ctx.moveTo(px - 5, a.top); ctx.lineTo(px + 5, a.top); ctx.lineTo(px, a.top + 7); ctx.closePath(); ctx.fill();
      }
    }

    const hLine = (val, color, label, dash, labelRight) => {
      const py = y.getPixelForValue(val);
      if (!isNum(py) || py < a.top - 1 || py > a.bottom + 1) return;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.left - 10, py - 7); ctx.lineTo(a.left - 10, py + 7); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
      ctx.beginPath(); ctx.moveTo(a.left, py); ctx.lineTo(a.right, py); ctx.stroke(); ctx.setLineDash([]);
      const tw = ctx.measureText(label).width + 8;
      const lx = labelRight ? a.right - tw - 4 : a.left + 4;
      ctx.fillRect(lx, py - 7, tw, 14);
      ctx.fillStyle = '#fff'; ctx.fillText(label, lx + 4, py);
    };
    hMarkers.forEach(v => hLine(v, colors.marker, fmt(v), [6, 3], false));
    if (trig.enabled) hLine(trig.level, colors.trigger, `T ${fmt(trig.level)}`, [4, 4], true);

    if (alarms.enabled) alarms.rules.forEach((r, i) => hLine(r.th, colors.alarm, `A${i + 1}`, [2, 4], true));

    vCursors.forEach((v, i) => {
      const px = x.getPixelForValue(v);
      if (!isNum(px) || px < a.left - 1 || px > a.right + 1) return;
      ctx.strokeStyle = colors.cursor; ctx.lineWidth = 1.5; ctx.setLineDash([6, 3]);
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.setLineDash([]);
      const label = `C${i + 1}`;
      const tw = ctx.measureText(label).width + 8;
      ctx.fillStyle = colors.cursor;
      ctx.fillRect(px - tw / 2, a.bottom - 16, tw, 14);
      ctx.fillStyle = '#fff'; ctx.fillText(label, px - tw / 2 + 4, a.bottom - 9);
    });
    ctx.restore();
  },
};

function createCharts() {
  chart = new Chart($('plot'), {
    type: 'line',
    data: {
      datasets: [
        ...CHANNELS.map(c => ({ label: c.label, data: [], borderColor: c.color, backgroundColor: c.color, borderWidth: 1.5, pointRadius: 0, tension: 0, fill: false })),
        { label: 'fit', data: [], borderColor: () => colors.fit, borderWidth: 2, borderDash: [6, 3], pointRadius: 0, tension: 0, fill: false },
        { label: 'MATH', data: [], borderColor: () => colors.math, backgroundColor: () => colors.math, borderWidth: 1.6, pointRadius: 0, tension: 0, fill: false },
      ],
    },
    options: {
      animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
      events: [], // interazione gestita a mano (pointer events)
      layout: { padding: { top: 6, right: 12, left: 12 } },
      scales: {
        x: {
          type: 'linear', min: 0, max: 1, afterBuildTicks: divisions(10),
          grid: { color: ctx => (ctx.index === 5 ? colors.gridStrong : colors.grid) },
          border: { color: colors.gridStrong },
          ticks: { color: () => colors.muted, font: tickFont, maxRotation: 0, autoSkipPadding: 12, callback: v => fmtAxisTime(v) },
        },
        y: yAxisOptions(false),
      },
      plugins: { legend: { display: false }, tooltip: { enabled: false }, decimation: { enabled: true, algorithm: 'min-max' } },
    },
    plugins: [overlayPlugin],
  });

  fftChart = new Chart($('fft-plot'), {
    type: 'line',
    data: { datasets: CHANNELS.map(c => ({ label: c.label, data: [], borderColor: c.color, backgroundColor: c.color, borderWidth: 1.2, pointRadius: 0, tension: 0, fill: false, hidden: true })) },
    options: {
      animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: {
        x: { type: 'linear', min: 0, max: 1, grid: { color: () => colors.grid }, border: { color: colors.gridStrong },
          title: { display: true, text: 'Hz', color: colors.muted, font: tickFont },
          ticks: { color: () => colors.muted, font: tickFont, maxRotation: 0, callback: v => fmt(v, 3) } },
        y: { grid: { color: () => colors.grid }, border: { color: colors.gridStrong },
          title: { display: true, text: 'dB', color: colors.muted, font: tickFont },
          ticks: { color: () => colors.muted, font: tickFont, maxTicksLimit: 7, callback: v => fmt(v, 3) } },
      },
      plugins: {
        legend: { display: true, onClick: () => {}, labels: { color: colors.text, font: tickFont, boxWidth: 12, filter: (item, data) => !data.datasets[item.datasetIndex].hidden } },
        tooltip: { callbacks: {
          title: items => (items.length ? fmtFreq(items[0].parsed.x) : ''),
          label: ctx => `${ctx.dataset.label}: ${fmt(ctx.parsed.y)} ${fftChart.options.scales.y.title.text}`,
        } },
      },
    },
  });
}

function applyChartTheme() {
  for (const c of [chart, fftChart]) {
    for (const ax of Object.values(c.options.scales)) {
      ax.border.color = colors.gridStrong;
      if (ax.title) ax.title.color = colors.muted;
    }
  }
  fftChart.options.plugins.legend.labels.color = colors.text;
  chart.update('none');
  fftChart.update('none');
  if (xy.enabled) xy.clear = true;
}

// ── Redraw throttled (requestAnimationFrame) ──────────────────
let dirty = false, rafId = null, lastDraw = 0;
function requestRedraw() {
  dirty = true;
  if (rafId === null) rafId = requestAnimationFrame(redrawTick);
}
function redrawTick(ts) {
  rafId = null;
  if (!dirty || !chart) return;
  if (ts - lastDraw < REDRAW_MS) { rafId = requestAnimationFrame(redrawTick); return; }
  lastDraw = ts;
  dirty = false;
  render();
}

function render() {
  updateChannelActivity();
  const fr = getFrame(), S = fr.samples, n = S.length;
  let xmin = 0, xmax = 1;
  if (n >= 2) {
    xmin = (S[0].t - fr.tRef) * 1000;
    xmax = (S[n - 1].t - fr.tRef) * 1000;
    if (xmax <= xmin) xmax = xmin + 1;
  }
  if (fr.xMaxMs > xmax) xmax = fr.xMaxMs;
  xSpanMs = xmax - xmin;

  for (let i = 0; i < NCH; i++) {
    const ds = chart.data.datasets[i];
    if (!(chState[i].active && isVisible(i))) { ds.hidden = true; ds.data = []; continue; }
    const data = [];
    for (const s of S) {
      const v = s.v[i];
      if (v != null && (!view.logY || v > 0)) data.push({ x: (s.t - fr.tRef) * 1000, y: v });
    }
    ds.data = data;
    ds.hidden = false;
    // PUNTI: solo i campioni, senza linea
    ds.pointRadius = view.points ? 2.2 : 0;
    ds.showLine = !view.points;
  }
  chart.data.datasets[NCH].data = fit.enabled ? fit.data : [];
  math.data = math.enabled && chState[math.a].active ? computeMath(S, fr.tRef) : [];
  const mds = chart.data.datasets[NCH + 1];
  mds.data = view.logY ? math.data.filter(p => p.y > 0) : math.data;
  mds.hidden = !mds.data.length;
  mds.pointRadius = view.points ? 2.2 : 0;
  mds.showLine = !view.points;

  const xo = chart.options.scales.x;
  xo.min = xmin; xo.max = xmax;
  if ((chart.options.scales.y.type === 'logarithmic') !== view.logY) chart.options.scales.y = yAxisOptions(view.logY);
  const yo = chart.options.scales.y;
  let lo = view.yOffset - view.yRange, hi = view.yOffset + view.yRange;
  if (view.logY) {
    if (hi <= 0) hi = 1;
    if (lo <= 0) lo = hi / 1000;
  }
  yo.min = lo; yo.max = hi;
  yo.title.text = unitLabel();
  // update('none') non rilegge le opzioni dei dataset: dopo un cambio di stile serve un update completo
  const styleKey = `${view.points}`;
  chart.update(styleKey !== lastStyleKey ? undefined : 'none');
  lastStyleKey = styleKey;

  $('msdiv-display').textContent = n >= 2 ? `${fmtTime(xSpanMs / 10)}/div` : '—';
  $('xsamples-display').textContent = `${view.xSamples} pt`;
  renderStats(fr);
  renderSelectionInfo(fr);
  renderCursorInfo();
}

function renderStats(fr) {
  let any = false;
  for (let i = 0; i < NCH; i++) {
    const row = $(`stats-row-${i}`);
    const show = chState[i].active && isVisible(i);
    row.hidden = !show;
    if (!show) continue;
    any = true;
    let mn = Infinity, mx = -Infinity, sum = 0, cnt = 0, last = null;
    for (const s of fr.samples) {
      const v = s.v[i];
      if (v == null) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      sum += v; cnt++; last = v;
    }
    $(`stat-min-${i}`).textContent = cnt ? fmt(mn) : '—';
    $(`stat-max-${i}`).textContent = cnt ? fmt(mx) : '—';
    $(`stat-avg-${i}`).textContent = cnt ? fmt(sum / cnt) : '—';
    $(`stat-last-${i}`).textContent = cnt ? fmt(last) : '—';
  }
  const mrow = $('stats-row-math');
  mrow.hidden = !math.data.length;
  if (math.data.length) {
    any = true;
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const p of math.data) { if (p.y < mn) mn = p.y; if (p.y > mx) mx = p.y; sum += p.y; }
    $('stat-min-math').textContent = fmt(mn);
    $('stat-max-math').textContent = fmt(mx);
    $('stat-avg-math').textContent = fmt(sum / math.data.length);
    $('stat-last-math').textContent = fmt(math.data[math.data.length - 1].y);
  }
  $('stats-empty').hidden = any;
}

function renderSelectionInfo(fr) {
  const box = $('selection-info');
  if (sel.x0 == null || sel.x1 == null) { box.hidden = true; return; }
  const [a, b] = selRange();
  box.hidden = false;
  $('sel-duration').textContent = `Δt ${fmtTime(b - a)}`;
  const out = $('sel-avg');
  out.replaceChildren();
  for (let i = 0; i < NCH; i++) {
    if (!(chState[i].active && isVisible(i))) continue;
    const vals = [];
    for (const s of fr.samples) {
      const x = (s.t - fr.tRef) * 1000;
      if (x >= a && x <= b && s.v[i] != null) vals.push(s.v[i]);
    }
    if (!vals.length) continue;
    const span = document.createElement('span');
    span.style.color = CHANNELS[i].color;
    span.textContent = `${CHANNELS[i].label} μ ${fmt(mean(vals))} pp ${fmt(Math.max(...vals) - Math.min(...vals))}`;
    out.appendChild(span);
  }
  if (!out.childElementCount) out.textContent = '—';
}

function renderCursorInfo() {
  const parts = [];
  if (vCursors.length === 2) {
    const dt = Math.abs(vCursors[1] - vCursors[0]);
    parts.push(`Δt ${fmtTime(dt)}`, `1/Δt ${dt > 0 ? fmtFreq(1000 / dt) : '—'}`);
  } else if (vCursors.length === 1) {
    parts.push(`C1 ${fmtTime(vCursors[0])}`);
  }
  if (hMarkers.length >= 2) parts.push(`ΔY ${fmt(Math.abs(hMarkers[1] - hMarkers[0]))} ${unitLabel()}`);
  const box = $('cursor-info');
  box.hidden = !parts.length;
  box.textContent = `CURSORI   ${parts.join('   ·   ')}`;
}

// ── Zoom / offset / autoscale ─────────────────────────────────
function setXSamples(n) {
  view.xSamples = clamp(Math.round(n), X_MIN, X_MAX);
  saveView();
  invalidate();
  if (trig.enabled) rearmTrigger();
  requestRedraw();
}
function zoomY(f) { view.yRange = clamp(view.yRange * f, Y_RANGE_MIN, Y_RANGE_MAX); saveView(); requestRedraw(); }
function shiftY(dir) { view.yOffset += (dir * view.yRange) / 4; saveView(); requestRedraw(); }
function autoscale() {
  let mn = Infinity, mx = -Infinity;
  for (const s of getFrame().samples) {
    for (let i = 0; i < NCH; i++) {
      const v = s.v[i];
      if (v == null || !(chState[i].active && isVisible(i))) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  if (!isNum(mn)) { toast('Nessun dato da scalare'); return; }
  const span = mx - mn;
  view.yOffset = (mx + mn) / 2;
  view.yRange = clamp(span > 0 ? (span / 2) * 1.15 : Math.max(Math.abs(mx) * 0.1, 1e-3), Y_RANGE_MIN, Y_RANGE_MAX);
  saveView();
  requestRedraw();
}

function setPaused(p) {
  if (!p && fit.enabled) { fit.pausedBefore = false; setFitEnabled(false); return; }
  paused = p;
  const btn = $('pause-btn');
  btn.textContent = p ? '▶' : '⏸';
  btn.setAttribute('aria-pressed', String(p));
  btn.setAttribute('aria-label', p ? 'Riprendi' : 'Pausa');
  if (!p) decim.nextMs = -Infinity;
  invalidate();
  requestRedraw();
}

// ── Interazione col grafico (pointer events: mouse, touch, penna) ──
const drag = { type: null, idx: -1, x: 0, y: 0, moved: false, isNew: false };
function canvasPos(e) {
  const r = chart.canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function hitTest(px, py) {
  const a = chart.chartArea, xs = chart.scales.x, ys = chart.scales.y;
  const zone = px < a.left ? 'ymargin' : py > a.bottom ? 'xmargin' : (px <= a.right && py >= a.top ? 'plot' : 'none');
  return {
    zone,
    trigHit: trig.enabled && Math.abs(ys.getPixelForValue(trig.level) - py) < 7,
    h: hMarkers.findIndex(v => Math.abs(ys.getPixelForValue(v) - py) < 7),
    v: vCursors.findIndex(v => Math.abs(xs.getPixelForValue(v) - px) < 6),
  };
}
function pointerValues(x, y) {
  const a = chart.chartArea;
  return {
    xv: chart.scales.x.getValueForPixel(clamp(x, a.left, a.right)),
    yv: chart.scales.y.getValueForPixel(clamp(y, a.top, a.bottom)),
  };
}

function wirePlotPointer() {
  const cv = chart.canvas;
  cv.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !chart.chartArea) return;
    const { x, y } = canvasPos(e);
    const hit = hitTest(x, y);
    const { xv, yv } = pointerValues(x, y);
    Object.assign(drag, { type: null, idx: -1, x, y, moved: false, isNew: false });
    const onLineZone = hit.zone === 'ymargin' || hit.zone === 'plot';
    if (onLineZone && hit.trigHit) drag.type = 'trig';
    else if (onLineZone && hit.h >= 0) Object.assign(drag, { type: 'h', idx: hit.h });
    else if (hit.zone === 'ymargin') {
      hMarkers.push(yv);
      Object.assign(drag, { type: 'h', idx: hMarkers.length - 1, isNew: true });
    } else if (hit.zone === 'xmargin' || (hit.zone === 'plot' && hit.v >= 0)) {
      if (hit.v >= 0) Object.assign(drag, { type: 'v', idx: hit.v });
      else {
        let idx;
        if (vCursors.length < 2) { vCursors.push(xv); idx = vCursors.length - 1; }
        else { idx = Math.abs(vCursors[0] - xv) <= Math.abs(vCursors[1] - xv) ? 0 : 1; vCursors[idx] = xv; }
        Object.assign(drag, { type: 'v', idx, isNew: true });
      }
    } else if (hit.zone === 'plot') {
      drag.type = 'sel';
      sel.x0 = xv; sel.x1 = null;
    } else return;
    cv.setPointerCapture(e.pointerId);
    e.preventDefault();
    requestRedraw();
  });

  cv.addEventListener('pointermove', e => {
    if (!chart.chartArea) return;
    const { x, y } = canvasPos(e);
    if (!drag.type) {
      const hit = hitTest(x, y);
      cv.style.cursor = (hit.zone === 'ymargin' || hit.zone === 'plot') && (hit.trigHit || hit.h >= 0) ? 'ns-resize'
        : hit.v >= 0 && hit.zone !== 'ymargin' ? 'ew-resize' : 'crosshair';
      return;
    }
    if (Math.abs(x - drag.x) > 3 || Math.abs(y - drag.y) > 3) drag.moved = true;
    const { xv, yv } = pointerValues(x, y);
    if (drag.type === 'trig') { trig.level = yv; $('trigger-level').value = fmtInput(yv); rearmTrigger(); }
    else if (drag.type === 'h') hMarkers[drag.idx] = yv;
    else if (drag.type === 'v') vCursors[drag.idx] = xv;
    else if (drag.type === 'sel') sel.x1 = xv;
    requestRedraw();
  });

  const endDrag = cancelled => {
    if (!drag.type) return;
    const click = !drag.moved && !cancelled;
    if (drag.type === 'trig') { saveFormEl($('trigger-level')); rearmTrigger(); }
    else if (drag.type === 'h' && click && !drag.isNew) hMarkers.splice(drag.idx, 1);
    else if (drag.type === 'v' && click && !drag.isNew) vCursors.splice(drag.idx, 1);
    else if (drag.type === 'sel') {
      if (!drag.moved) sel.x0 = sel.x1 = null;
      if (fit.enabled) runFit();
    }
    drag.type = null;
    requestRedraw();
  };
  cv.addEventListener('pointerup', () => endDrag(false));
  cv.addEventListener('pointercancel', () => endDrag(true));

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const d = e.deltaY || e.deltaX;
    if (!d) return;
    const f = d > 0 ? 1.25 : 0.8;
    const { x } = canvasPos(e);
    if (e.shiftKey || (chart.chartArea && x < chart.chartArea.left)) zoomY(f);
    else setXSamples(view.xSamples * f);
  }, { passive: false });
}

// ═══════════════════════════════════════════════════════════════
//  Fit
// ═══════════════════════════════════════════════════════════════
const fit = { enabled: false, pausedBefore: false, data: [] };

function linReg(pts) {
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const det = n * sxx - sx * sx;
  if (Math.abs(det) < 1e-12) return null;
  const a = (n * sxy - sx * sy) / det;
  return { a, b: (sy - a * sx) / n };
}
function solve3(A, b) {
  // eliminazione di Gauss con pivot parziale
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < 3; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let k = r + 1; k < 3; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}
function sinFitAt(pts, f) {
  const w = 2 * Math.PI * f;
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
  for (const p of pts) {
    const r = [Math.sin(w * p.x), Math.cos(w * p.x), 1];
    for (let i = 0; i < 3; i++) { b[i] += r[i] * p.y; for (let j = 0; j < 3; j++) A[i][j] += r[i] * r[j]; }
  }
  const c = solve3(A, b);
  if (!c) return null;
  let sse = 0;
  for (const p of pts) { const e = p.y - (c[0] * Math.sin(w * p.x) + c[1] * Math.cos(w * p.x) + c[2]); sse += e * e; }
  return { s: c[0], c: c[1], d: c[2], sse, f };
}
function fitSinusoidal(pts) {
  const t = pts.map(p => p.x), v = pts.map(p => p.y);
  const mn = Math.min(...v), mx = Math.max(...v);
  const span = t[t.length - 1] - t[0];
  let f0 = span > 0 ? 1 / span : 1;
  if (mx > mn) {
    const { rising } = crossings(t, v, (mn + mx) / 2, (mx - mn) * 0.1);
    if (rising.length >= 2) f0 = (rising.length - 1) / (rising[rising.length - 1] - rising[0]);
  }
  let best = null;
  const scan = (center, step, k) => {
    for (let i = -k; i <= k; i++) {
      const r = sinFitAt(pts, center * (1 + i * step));
      if (r && (!best || r.sse < best.sse)) best = r;
    }
  };
  scan(f0, 0.01, 20);
  if (best) scan(best.f, 0.0005, 10);
  if (!best) return null;
  const { s, c, d, f } = best;
  const amp = Math.hypot(s, c), phi = Math.atan2(c, s), w = 2 * Math.PI * f;
  return { fn: x => amp * Math.sin(w * x + phi) + d, label: `y = ${fmt(amp)}·sin(2π·${fmt(f)}·t ${phi >= 0 ? '+' : '−'} ${fmt(Math.abs(phi))}) + ${fmt(d)}   (f = ${fmtFreq(f)})` };
}
const FITS = {
  horizontal: pts => { const a = mean(pts.map(p => p.y)); return { fn: () => a, label: `y = ${fmt(a)}` }; },
  linear: pts => {
    const r = linReg(pts);
    if (!r) return null;
    return { fn: x => r.a * x + r.b, label: `y = ${fmt(r.a)}·t ${r.b >= 0 ? '+' : '−'} ${fmt(Math.abs(r.b))}` };
  },
  exponential: pts => {
    const v = pts.filter(p => p.y > 0);
    const r = v.length >= 3 && linReg(v.map(p => ({ x: p.x, y: Math.log(p.y) })));
    if (!r) return null;
    const A = Math.exp(r.b), B = r.a;
    return { fn: x => A * Math.exp(B * x), label: `y = ${fmt(A)}·e^(${fmt(B)}·t)`, n: v.length };
  },
  power: pts => {
    const v = pts.filter(p => p.x > 0 && p.y > 0);
    const r = v.length >= 3 && linReg(v.map(p => ({ x: Math.log(p.x), y: Math.log(p.y) })));
    if (!r) return null;
    const A = Math.exp(r.b), B = r.a;
    return { fn: x => (x > 0 ? A * Math.pow(x, B) : NaN), label: `y = ${fmt(A)}·t^${fmt(B)}`, n: v.length };
  },
  logarithmic: pts => {
    const v = pts.filter(p => p.x > 0);
    const r = v.length >= 3 && linReg(v.map(p => ({ x: Math.log(p.x), y: p.y })));
    if (!r) return null;
    return { fn: x => (x > 0 ? r.a * Math.log(x) + r.b : NaN), label: `y = ${fmt(r.a)}·ln(t) ${r.b >= 0 ? '+' : '−'} ${fmt(Math.abs(r.b))}`, n: v.length };
  },
  sinusoidal: fitSinusoidal,
};
const FIT_ERRORS = {
  exponential: 'Fit esponenziale non applicabile: servono almeno 3 valori y > 0.',
  power: 'Fit di potenza non applicabile: servono almeno 3 punti con t > 0 e y > 0.',
  logarithmic: 'Fit logaritmico non applicabile: servono almeno 3 punti con t > 0.',
};
function computeR2(pts, fn) {
  const m = mean(pts.map(p => p.y));
  let sT = 0, sR = 0;
  for (const p of pts) {
    const f = fn(p.x);
    if (!isNum(f)) continue;
    sT += (p.y - m) ** 2;
    sR += (p.y - f) ** 2;
  }
  return sT < 1e-15 ? 1 : 1 - sR / sT;
}

function runFit() {
  if (!fit.enabled) return;
  const fr = getFrame();
  const ci = +$('analysis-channel').value, type = $('analysis-fit').value;
  let pts = [];
  for (const s of fr.samples) if (s.v[ci] != null) pts.push({ x: s.t - fr.tRef, y: s.v[ci] });
  if (sel.x0 != null && sel.x1 != null) {
    const [a, b] = selRange();
    pts = pts.filter(p => p.x * 1000 >= a && p.x * 1000 <= b);
  }
  $('analysis-result').hidden = false;
  const fail = msg => {
    $('analysis-formula').textContent = msg;
    $('analysis-r2').textContent = '—';
    $('analysis-n').textContent = String(pts.length);
    fit.data = [];
    requestRedraw();
  };
  if (pts.length < 3) return fail('Dati insufficienti: servono almeno 3 punti sul canale scelto.');
  const r = FITS[type](pts);
  if (!r) return fail(FIT_ERRORS[type] || 'Fit non riuscito (dati degeneri).');
  $('analysis-formula').textContent = r.label;
  $('analysis-r2').textContent = computeR2(pts, r.fn).toFixed(4);
  $('analysis-n').textContent = String(r.n ?? pts.length);
  fit.data = pts.map(p => ({ x: p.x * 1000, y: r.fn(p.x) })).filter(p => isNum(p.y));
  requestRedraw();
}

function setFitEnabled(on) {
  if (on === fit.enabled) return;
  fit.enabled = on;
  $('analysis-enabled').checked = on;
  updateLeds();
  $('analysis-paused').hidden = !on;
  if (on) {
    fit.pausedBefore = paused;
    setPaused(true);
    runFit();
  } else {
    $('analysis-result').hidden = true;
    fit.data = [];
    setPaused(fit.pausedBefore);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Misure automatiche
// ═══════════════════════════════════════════════════════════════
function interpCross(t, v, i, level, up) {
  let j = i;
  while (j > 0 && (up ? v[j - 1] >= level : v[j - 1] <= level)) j--;
  if (j === 0) return t[i];
  const a = j - 1, b = j;
  const f = v[b] !== v[a] ? (level - v[a]) / (v[b] - v[a]) : 0;
  return t[a] + f * (t[b] - t[a]);
}
// Attraversamenti del livello `mid` con isteresi; tempi interpolati
function crossings(t, v, mid, hyst) {
  const hi = mid + hyst / 2, lo = mid - hyst / 2;
  const rising = [], falling = [];
  let high = null;
  for (let i = 0; i < v.length; i++) {
    if (high === null) { if (v[i] >= hi) high = true; else if (v[i] <= lo) high = false; }
    else if (!high && v[i] >= hi) { high = true; rising.push(interpCross(t, v, i, mid, true)); }
    else if (high && v[i] <= lo) { high = false; falling.push(interpCross(t, v, i, mid, false)); }
  }
  return { rising, falling };
}
// Tempo medio di transizione tra due livelli (salita: lo→hi, discesa: hi→lo), in ms
function avgTransition(t, v, from, to, up) {
  const lerp = (i, L) => t[i - 1] + ((L - v[i - 1]) / (v[i] - v[i - 1])) * (t[i] - t[i - 1]);
  const durations = [];
  let start = null;
  for (let i = 1; i < v.length; i++) {
    const p = v[i - 1], c = v[i];
    const crossFrom = up ? p < from && c >= from : p > from && c <= from;
    const crossTo = up ? p < to && c >= to : p > to && c <= to;
    if (crossFrom) start = lerp(i, from);
    if (start != null && crossTo) { durations.push((lerp(i, to) - start) * 1000); start = null; }
    else if (start != null && !crossFrom && (up ? c < from : c > from)) start = null;
  }
  return durations.length ? mean(durations) : null;
}

function computeMeasurements(samples, ci) {
  const t = [], v = [];
  for (const s of samples) { const x = s.v[ci]; if (x != null) { t.push(s.t); v.push(x); } }
  const n = v.length;
  if (n < 4) return null;
  let mn = Infinity, mx = -Infinity, sum = 0, sum2 = 0;
  for (const x of v) { if (x < mn) mn = x; if (x > mx) mx = x; sum += x; sum2 += x * x; }
  const avg = sum / n, rms = Math.sqrt(sum2 / n), vpp = mx - mn;
  const acrms = Math.sqrt(Math.max(0, sum2 / n - avg * avg));
  const crest = rms > 0 ? Math.max(Math.abs(mn), Math.abs(mx)) / rms : null;
  let slew = 0;
  for (let i = 1; i < n; i++) {
    const dt = (t[i] - t[i - 1]) * 1000;
    if (dt > 0) slew = Math.max(slew, Math.abs(v[i] - v[i - 1]) / dt);
  }
  const m = { vpp, mn, mx, avg, rms, acrms, crest, slew, freq: null, period: null, duty: null, cross: 0, rise: null, fall: null };
  if (vpp > 0) {
    const { rising, falling } = crossings(t, v, (mn + mx) / 2, vpp * 0.1);
    m.cross = rising.length + falling.length;
    if (rising.length >= 2) {
      const t0 = rising[0], t1 = rising[rising.length - 1];
      m.period = ((t1 - t0) / (rising.length - 1)) * 1000;
      m.freq = m.period > 0 ? 1000 / m.period : null;
      let highT = 0, fi = 0;
      for (let k = 0; k < rising.length - 1; k++) {
        while (fi < falling.length && falling[fi] <= rising[k]) fi++;
        if (fi < falling.length && falling[fi] < rising[k + 1]) highT += falling[fi] - rising[k];
      }
      m.duty = t1 > t0 ? (highT / (t1 - t0)) * 100 : null;
    }
    const lo = mn + vpp * 0.1, hi = mn + vpp * 0.9;
    m.rise = avgTransition(t, v, lo, hi, true);
    m.fall = avgTransition(t, v, hi, lo, false);
  }
  return m;
}

function runMeasure() {
  const fr = getFrame();
  let any = false;
  for (let i = 0; i < NCH; i++) {
    const block = $(`meas-block-${i}`);
    block.hidden = !chState[i].active;
    if (!chState[i].active) continue;
    any = true;
    const m = computeMeasurements(fr.samples, i);
    for (const def of MEASURES) {
      const val = m ? m[def.key] : null;
      $(`m-${def.key}-${i}`).textContent = def.key === 'cross' ? (m ? String(val) : '—') : fmt(val);
    }
  }
  $('meas-empty-hint').hidden = any;
}

// ═══════════════════════════════════════════════════════════════
//  FFT
// ═══════════════════════════════════════════════════════════════
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wRe = Math.cos(ang), wIm = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cRe = 1, cIm = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const vRe = re[b] * cRe - im[b] * cIm, vIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - vRe; im[b] = im[a] - vIm;
        re[a] += vRe; im[a] += vIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}
function windowFn(type, k, n) {
  const x = (2 * Math.PI * k) / (n - 1);
  switch (type) {
    case 'hanning': return 0.5 - 0.5 * Math.cos(x);
    case 'hamming': return 0.54 - 0.46 * Math.cos(x);
    case 'blackman': return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    case 'flat-top': return 0.21557895 - 0.41663158 * Math.cos(x) + 0.277263158 * Math.cos(2 * x) - 0.083578947 * Math.cos(3 * x) + 0.006947368 * Math.cos(4 * x);
    default: return 1;
  }
}

// Ampiezze (picco) per bin 0..N/2, corrette per il guadagno coerente della finestra
function computeSpectrum(ci, size, winType) {
  const src = [];
  for (let i = buffer.length - 1; i >= 0 && src.length < size; i--) if (buffer[i].v[ci] != null) src.push(buffer[i]);
  if (src.length < 32) return null;
  src.reverse();
  let n = 1;
  while (n * 2 <= src.length) n *= 2;
  const seg = src.slice(-n);
  const T = seg[n - 1].t - seg[0].t;
  if (T <= 0) return null;
  const fs = (n - 1) / T;

  // Ricampionamento lineare su griglia uniforme (corregge il jitter dei timestamp)
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let k = 0, j = 0; k < n; k++) {
    const tk = seg[0].t + k / fs;
    while (j < n - 2 && seg[j + 1].t < tk) j++;
    const a = seg[j], b = seg[j + 1];
    const f = b.t > a.t ? clamp((tk - a.t) / (b.t - a.t), 0, 1) : 0;
    re[k] = a.v[ci] + f * (b.v[ci] - a.v[ci]);
  }
  // Prima si toglie la media, poi si applica la finestra
  let m = 0;
  for (let k = 0; k < n; k++) m += re[k];
  m /= n;
  let sumW = 0;
  for (let k = 0; k < n; k++) { const w = windowFn(winType, k, n); sumW += w; re[k] = (re[k] - m) * w; }
  fftInPlace(re, im);
  const half = n / 2, amps = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) amps[k] = ((k === 0 || k === half ? 1 : 2) * Math.hypot(re[k], im[k])) / sumW;
  return { amps, fs, n, df: fs / n };
}

function spectrumStats(sp) {
  const A = sp.amps, half = A.length - 1, band = 3;
  let kp = 1;
  for (let k = 2; k < half; k++) if (A[k] > A[kp]) kp = k;
  // Interpolazione parabolica del picco (su scala log)
  let delta = 0;
  if (kp > 1 && kp < half - 1 && A[kp - 1] > 0 && A[kp + 1] > 0 && A[kp] > 0) {
    const a = Math.log(A[kp - 1]), b = Math.log(A[kp]), c = Math.log(A[kp + 1]);
    const den = a - 2 * b + c;
    if (den !== 0) delta = clamp((0.5 * (a - c)) / den, -0.5, 0.5);
  }
  const P = k => A[k] * A[k];
  const bandPower = c => { let s = 0; for (let k = Math.max(1, c - band); k <= Math.min(half, c + band); k++) s += P(k); return s; };
  const used = new Set();
  const mark = c => { for (let k = Math.max(1, c - band); k <= Math.min(half, c + band); k++) used.add(k); };
  const p1 = bandPower(kp);
  mark(kp);
  let ph = 0;
  for (let h = 2; h <= 10; h++) {
    const center = Math.round(h * (kp + delta));
    if (center + band > half) break;
    let kh = center;
    for (let k = center - 2; k <= center + 2; k++) if (k > 0 && k <= half && A[k] > A[kh]) kh = k;
    if ([...Array(2 * band + 1)].some((_, i) => used.has(kh - band + i))) continue;
    ph += bandPower(kh);
    mark(kh);
  }
  let noise = 0;
  for (let k = 1; k <= half; k++) if (!used.has(k)) noise += P(k);
  return {
    peakf: (kp + delta) * sp.df,
    peaka: A[kp],
    thd: p1 > 0 ? Math.sqrt(ph / p1) * 100 : null,
    snr: noise > 0 && p1 > 0 ? 10 * Math.log10(p1 / noise) : null,
    fs: sp.fs,
    df: sp.df,
  };
}

function runFFT() {
  const winType = $('fft-window').value, size = +$('fft-size').value, db = $('fft-scale').value === 'db';
  const toY = a => (db ? 20 * Math.log10(Math.max(a, 1e-12)) : a);
  let maxF = 0;
  for (let i = 0; i < NCH; i++) {
    const ds = fftChart.data.datasets[i];
    const panel = $(`fft-info-${i}`);
    const sp = chState[i].active && $(`fft-ch-${i}`).checked ? computeSpectrum(i, size, winType) : null;
    panel.hidden = !sp;
    if (!sp) { ds.hidden = true; ds.data = []; continue; }
    const data = [];
    for (let k = 1; k < sp.amps.length; k++) data.push({ x: k * sp.df, y: toY(sp.amps[k]) });
    ds.data = data;
    ds.hidden = false;
    maxF = Math.max(maxF, sp.fs / 2);
    const st = spectrumStats(sp);
    $(`fft-peakf-${i}`).textContent = fmt(st.peakf);
    $(`fft-peaka-${i}`).textContent = fmt(toY(st.peaka));
    $(`fft-thd-${i}`).textContent = st.thd != null ? st.thd.toFixed(2) : '—';
    $(`fft-snr-${i}`).textContent = st.snr != null ? st.snr.toFixed(1) : '—';
    $(`fft-fs-${i}`).textContent = fmt(st.fs);
    $(`fft-df-${i}`).textContent = fmt(st.df);
  }
  fftChart.options.scales.x.max = maxF || 1;
  fftChart.options.scales.y.title.text = db ? `dB${units.mode === 'v' ? 'V' : ''}` : unitLabel();
  fftChart.update('none');
}

function clearFFT() {
  fftChart.data.datasets.forEach(ds => { ds.data = []; ds.hidden = true; });
  fftChart.update('none');
  CHANNELS.forEach((_, i) => { $(`fft-info-${i}`).hidden = true; });
}

// ═══════════════════════════════════════════════════════════════
//  XY
// ═══════════════════════════════════════════════════════════════
const xy = { enabled: false, clear: true, size: 0 };

function runXY() {
  const cv = $('xy-plot'), ctx = cv.getContext('2d');
  const size = Math.round(cv.parentElement.getBoundingClientRect().width);
  if (!size) return;
  const dpr = window.devicePixelRatio || 1;
  if (xy.size !== size * dpr) {
    xy.size = size * dpr;
    cv.width = cv.height = size * dpr;
    xy.clear = true;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = size, H = size;
  const cx = +$('xy-ch-x').value, cy = +$('xy-ch-y').value;
  const nPoints = +$('xy-points').value, persist = parseFloat($('xy-persist').value);
  const trace = $('xy-trace').checked, fixed = $('xy-scale').value === 'fixed';

  const pairs = [];
  for (let i = buffer.length - 1; i >= 0 && pairs.length < nPoints; i--) {
    const s = buffer[i];
    if (s.v[cx] != null && s.v[cy] != null) pairs.push(s);
  }
  pairs.reverse();

  if (persist > 0 && !xy.clear) {
    ctx.fillStyle = withAlpha(colors.card, 1 - persist);
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.fillStyle = colors.card;
    ctx.fillRect(0, 0, W, H);
  }
  xy.clear = false;

  ctx.strokeStyle = colors.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 8; i++) {
    const p = (W / 8) * i;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
  }
  ctx.strokeStyle = colors.gridStrong; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

  if (pairs.length < 2) return;
  const xs = pairs.map(s => s.v[cx]), ys = pairs.map(s => s.v[cy]);
  let xMin, xMax, yMin, yMax;
  if (fixed) {
    xMin = yMin = view.yOffset - view.yRange;
    xMax = yMax = view.yOffset + view.yRange;
  } else {
    xMin = Math.min(...xs); xMax = Math.max(...xs);
    yMin = Math.min(...ys); yMax = Math.max(...ys);
  }
  const xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
  const px = v => ((v - xMin) / xSpan) * (W - 20) + 10;
  const py = v => H - (((v - yMin) / ySpan) * (H - 20) + 10);
  const color = CHANNELS[cy].color;

  if (trace) {
    ctx.beginPath();
    ctx.strokeStyle = withAlpha(color, 0.8);
    ctx.lineWidth = 1;
    pairs.forEach((s, i) => (i === 0 ? ctx.moveTo(px(s.v[cx]), py(s.v[cy])) : ctx.lineTo(px(s.v[cx]), py(s.v[cy]))));
    ctx.stroke();
  }
  pairs.forEach((s, i) => {
    ctx.fillStyle = withAlpha(color, 0.3 + (0.7 * i) / pairs.length);
    ctx.beginPath();
    ctx.arc(px(s.v[cx]), py(s.v[cy]), 1.5, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.font = 'bold 9px Courier New, monospace';
  ctx.fillStyle = colors.muted;
  ctx.fillText(`${CHANNELS[cx].label} →`, W - 40, H / 2 - 4);
  ctx.save(); ctx.translate(12, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`${CHANNELS[cy].label} →`, -18, 0); ctx.restore();
  ctx.fillText(fmt(xMin, 3), 4, H - 4);
  ctx.fillText(fmt(xMax, 3), W - 40, H - 4);
  ctx.fillText(fmt(yMax, 3), W / 2 + 4, 12);
  ctx.fillText(fmt(yMin, 3), W / 2 + 4, H - 14);

  // Statistiche
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sx2 += (xs[i] - mx) ** 2; sy2 += (ys[i] - my) ** 2; }
  const corr = sx2 > 0 && sy2 > 0 ? sxy / Math.sqrt(sx2 * sy2) : 0;

  // Fase dalla figura di Lissajous: sin(Δφ) = y0 / A, con y0 = y all'attraversamento della media di x
  const dyMin = Math.min(...ys), dyMax = Math.max(...ys), dySpan = dyMax - dyMin;
  let y0sum = 0, y0count = 0, xCross = 0, yCross = 0;
  for (let i = 1; i < n; i++) {
    if ((xs[i - 1] - mx) * (xs[i] - mx) < 0) {
      const f = (mx - xs[i - 1]) / (xs[i] - xs[i - 1]);
      y0sum += Math.abs(ys[i - 1] + f * (ys[i] - ys[i - 1]) - (dyMin + dySpan / 2));
      y0count++;
      xCross++;
    }
    if ((ys[i - 1] - my) * (ys[i] - my) < 0) yCross++;
  }
  let phase = null;
  if (y0count > 0 && dySpan > 0) phase = (Math.asin(clamp((2 * (y0sum / y0count)) / dySpan, 0, 1)) * 180) / Math.PI;

  $('xy-phase').textContent = phase != null ? phase.toFixed(1) : '—';
  $('xy-ratio').textContent = yCross > 0 ? (xCross / yCross).toFixed(2) : '—';
  $('xy-xrange').textContent = fmt(Math.max(...xs) - Math.min(...xs));
  $('xy-yrange').textContent = fmt(dySpan);
  $('xy-corr').textContent = corr.toFixed(3);
}

function clearXY() {
  const cv = $('xy-plot');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  ['xy-phase', 'xy-ratio', 'xy-xrange', 'xy-yrange', 'xy-corr'].forEach(id => { $(id).textContent = '—'; });
  xy.clear = true;
}

// ═══════════════════════════════════════════════════════════════
//  Matematica (canale calcolato MATH)
// ═══════════════════════════════════════════════════════════════
const math = { enabled: false, op: 'sub', a: 0, b: 1, n: 10, fc: 5, gain: 1, data: [] };
const MATH_BINARY = new Set(['add', 'sub', 'mul', 'div']);

function mathUnit() {
  const u = unitLabel();
  const base = { add: u, sub: u, mul: `${u}²`, div: 'rapporto', deriv: `${u}/s`, integ: `${u}·s`, avg: u, lowpass: u, abs: u }[math.op];
  return math.gain !== 1 ? `${base} × ${fmt(math.gain)}` : base;
}
function mathLabel() {
  const A = CHANNELS[math.a].label, B = CHANNELS[math.b].label;
  return {
    add: `${A} + ${B}`, sub: `${A} − ${B}`, mul: `${A} × ${B}`, div: `${A} ÷ ${B}`,
    deriv: `d${A}/dt`, integ: `∫${A} dt`, abs: `|${A}|`,
    avg: `media mobile di ${A} su ${math.n} campioni`,
    lowpass: `${A} filtrato passa-basso a ${fmt(math.fc)} Hz`,
  }[math.op];
}

function readMath() {
  math.enabled = $('math-enabled').checked;
  math.op = $('math-op').value;
  math.a = +$('math-a').value;
  math.b = +$('math-b').value;
  math.n = clamp(parseInt($('math-n').value, 10) || 1, 1, 1000);
  math.fc = Math.max(0.001, parseFloat($('math-fc').value) || 1);
  const g = parseFloat($('math-gain').value);
  math.gain = isNum(g) ? g : 1;
  $('math-b-field').hidden = !MATH_BINARY.has(math.op);
  $('math-n-field').hidden = math.op !== 'avg';
  $('math-fc-field').hidden = math.op !== 'lowpass';
  $('math-label').textContent = `MATH = ${mathLabel()}`;
  $('math-unit').textContent = mathUnit();
  requestRedraw();
}

// Calcolato sul frame visualizzato: segue pausa, trigger e zoom
function computeMath(samples, tRef) {
  const out = [], g = math.gain;
  const push = (t, y) => { if (isNum(y)) out.push({ x: (t - tRef) * 1000, y: y * g }); };
  if (MATH_BINARY.has(math.op)) {
    for (const s of samples) {
      const a = s.v[math.a], b = s.v[math.b];
      if (a == null || b == null) continue;
      push(s.t, math.op === 'add' ? a + b : math.op === 'sub' ? a - b : math.op === 'mul' ? a * b : b !== 0 ? a / b : NaN);
    }
    return out;
  }
  const t = [], v = [];
  for (const s of samples) if (s.v[math.a] != null) { t.push(s.t); v.push(s.v[math.a]); }
  const n = v.length;
  if (!n) return out;
  switch (math.op) {
    case 'abs':
      for (let i = 0; i < n; i++) push(t[i], Math.abs(v[i]));
      break;
    case 'deriv':
      for (let i = 1; i < n - 1; i++) {
        const dt = t[i + 1] - t[i - 1];
        if (dt > 0) push(t[i], (v[i + 1] - v[i - 1]) / dt);
      }
      break;
    case 'integ': {
      let acc = 0;
      push(t[0], 0);
      for (let i = 1; i < n; i++) { acc += ((v[i] + v[i - 1]) / 2) * (t[i] - t[i - 1]); push(t[i], acc); }
      break;
    }
    case 'avg': {
      const pre = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + v[i];
      const half = Math.floor((math.n - 1) / 2);
      for (let i = 0; i < n; i++) {
        const lo = Math.max(0, i - half), hi = Math.min(n - 1, lo + math.n - 1);
        push(t[i], (pre[hi + 1] - pre[lo]) / (hi - lo + 1));
      }
      break;
    }
    case 'lowpass': {
      const rc = 1 / (2 * Math.PI * math.fc);
      let y = v[0];
      push(t[0], y);
      for (let i = 1; i < n; i++) {
        const dt = t[i] - t[i - 1];
        y += (dt / (rc + dt)) * (v[i] - y);
        push(t[i], y);
      }
      break;
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
//  Allarmi soglia
// ═══════════════════════════════════════════════════════════════
const MAX_ALARMS = 8, MAX_ALARM_LOG = 200;
const alarms = { enabled: false, rules: [], log: [], dirty: true, sinceCheck: 0, audio: null, lastToast: 0, lastBeep: 0 };
let alarmSeq = 0;

const saveAlarms = () => store.set('alarms', alarms.rules.map(r => ({ ch: r.ch, cond: r.cond, th: r.th })));

function addAlarmRule(init = {}) {
  if (alarms.rules.length >= MAX_ALARMS) { toast(`Massimo ${MAX_ALARMS} regole`); return; }
  const r = { id: ++alarmSeq, ch: init.ch ?? 0, cond: init.cond ?? 'above', th: init.th ?? 700, count: 0, active: false, hyst: 0 };
  alarms.rules.push(r);
  const chOptions = CHANNELS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('');
  $('alarm-rules').insertAdjacentHTML('beforeend', `
    <div class="ch-block alarm-rule" id="alarm-rule-${r.id}" data-id="${r.id}" style="--ch:${CHANNELS[r.ch].color}">
      <div class="fields">
        <div class="field"><span class="lbl">REGOLA</span><span class="readout alarm-name"></span></div>
        <div class="field"><label class="lbl" for="alarm-ch-${r.id}">CANALE</label><select id="alarm-ch-${r.id}" class="sel ch-select">${chOptions}</select></div>
        <div class="field"><label class="lbl" for="alarm-cond-${r.id}">CONDIZIONE</label>
          <select id="alarm-cond-${r.id}" class="sel"><option value="above">Sopra la soglia (&gt;)</option><option value="below">Sotto la soglia (&lt;)</option></select></div>
        <div class="field"><label class="lbl" for="alarm-th-${r.id}">SOGLIA</label><input type="number" step="any" id="alarm-th-${r.id}" class="txt num"></div>
        <div class="field"><span class="lbl">EVENTI</span><span class="readout" id="alarm-count-${r.id}">0</span></div>
        <button class="icon-btn push" data-alarm-remove="${r.id}" aria-label="Rimuovi regola" title="Rimuovi regola">✕</button>
      </div>
    </div>`);
  $(`alarm-ch-${r.id}`).value = String(r.ch);
  $(`alarm-cond-${r.id}`).value = r.cond;
  $(`alarm-th-${r.id}`).value = fmtInput(r.th);
  updateAlarmHyst();
  updateChannelNames();
  renderAlarmUi();
  saveAlarms();
  requestRedraw();
}

function removeAlarmRule(id) {
  alarms.rules = alarms.rules.filter(r => r.id !== id);
  $(`alarm-rule-${id}`).remove();
  renderAlarmUi();
  saveAlarms();
  requestRedraw();
}

function readAlarmRule(id) {
  const r = alarms.rules.find(x => x.id === id);
  if (!r) return;
  r.ch = +$(`alarm-ch-${id}`).value;
  r.cond = $(`alarm-cond-${id}`).value;
  const th = parseFloat($(`alarm-th-${id}`).value);
  if (isNum(th)) r.th = th;
  r.active = false;
  $(`alarm-rule-${id}`).style.setProperty('--ch', CHANNELS[r.ch].color);
  updateAlarmHyst();
  alarms.dirty = true;
  saveAlarms();
  requestRedraw();
}

// Isteresi: 2% dell'escursione recente del canale, così il rumore non genera raffiche di eventi
function updateAlarmHyst() {
  for (const r of alarms.rules) {
    let mn = Infinity, mx = -Infinity;
    for (let i = Math.max(0, buffer.length - 500); i < buffer.length; i++) {
      const v = buffer[i].v[r.ch];
      if (v == null) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    r.hyst = mn < mx ? (mx - mn) * 0.02 : 0;
  }
}

function checkAlarms(s) {
  if (++alarms.sinceCheck >= 100) { alarms.sinceCheck = 0; updateAlarmHyst(); }
  for (const r of alarms.rules) {
    const v = s.v[r.ch];
    if (v == null) continue;
    if (!r.active) {
      if (r.cond === 'above' ? v > r.th : v < r.th) { r.active = true; r.count++; fireAlarm(r, v); }
    } else if (r.cond === 'above' ? v < r.th - r.hyst : v > r.th + r.hyst) {
      r.active = false;
      alarms.dirty = true;
    }
  }
}

function alarmText(r) {
  const idx = alarms.rules.indexOf(r) + 1;
  const name = chState[r.ch].name ? ` ${chState[r.ch].name}` : '';
  return `A${idx} · ${CHANNELS[r.ch].label}${name} ${r.cond === 'above' ? '>' : '<'} ${fmt(r.th)}`;
}

function fireAlarm(r, v) {
  alarms.log.unshift({ time: wallTime(), text: alarmText(r), value: v, ch: r.ch });
  if (alarms.log.length > MAX_ALARM_LOG) alarms.log.pop();
  alarms.dirty = true;
  const now = performance.now();
  if ($('alarm-sound').checked && now - alarms.lastBeep > 250) { alarms.lastBeep = now; beep(); }
  if (now - alarms.lastToast > 1500) { alarms.lastToast = now; toast(`Allarme ${alarmText(r)} (valore ${fmt(v)})`, 'warn'); }
}

function beep() {
  try {
    alarms.audio = alarms.audio || new AudioContext();
    const ctx = alarms.audio, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.2);
  } catch { /* audio non disponibile */ }
}

function renderAlarmUi() {
  alarms.dirty = false;
  const firing = alarms.enabled && alarms.rules.some(r => r.active);
  alarms.rules.forEach((r, i) => {
    const block = $(`alarm-rule-${r.id}`);
    block.classList.toggle('firing', alarms.enabled && r.active);
    block.querySelector('.alarm-name').textContent = `A${i + 1}`;
    $(`alarm-count-${r.id}`).textContent = String(r.count);
  });
  $('alarm-empty').hidden = alarms.rules.length > 0;
  const st = $('alarm-status');
  const total = alarms.rules.reduce((a, r) => a + r.count, 0);
  if (!alarms.enabled) { st.textContent = 'OFF'; st.className = 'badge off push'; }
  else if (firing) { st.textContent = `ALLARME · ${total} eventi`; st.className = 'badge warn push'; }
  else { st.textContent = `IN ASCOLTO · ${total} eventi`; st.className = 'badge ok push'; }
  document.querySelector('.tab-btn[data-tab="tab-alarm"]').classList.toggle('alert', firing);

  $('alarm-log').replaceChildren(...alarms.log.map(ev => {
    const row = document.createElement('div');
    row.className = 'event';
    row.style.setProperty('--ch', CHANNELS[ev.ch].color);
    const tm = document.createElement('span');
    tm.className = 'event-time';
    tm.textContent = ev.time;
    const tx = document.createElement('span');
    tx.textContent = ev.text;
    const val = document.createElement('span');
    val.className = 'event-val';
    val.textContent = `valore ${fmt(ev.value)}`;
    row.append(tm, tx, val);
    return row;
  }));
  $('alarm-log-empty').hidden = alarms.log.length > 0;
}

function setAlarmsEnabled(on) {
  alarms.enabled = on;
  alarms.rules.forEach(r => { r.active = false; });
  updateAlarmHyst();
  renderAlarmUi();
  requestRedraw();
}

// ═══════════════════════════════════════════════════════════════
//  Generatore di segnali
// ═══════════════════════════════════════════════════════════════
const gen = {
  on: false, rate: 250, t0: 0, nextT: 0, timer: null,
  ch: CHANNELS.map(() => ({ shown: false, on: true, wave: 'sine', amp: 256, off: 512, freq: 1, duty: 50, phase: 0, noise: 0 })),
};

function readGenCh(i) {
  const c = gen.ch[i];
  const g = k => parseFloat($(`gen-${k}-${i}`).value);
  c.on = $(`gen-on-${i}`).checked;
  c.wave = $(`gen-wave-${i}`).value;
  c.amp = g('amp'); c.off = g('off'); c.freq = Math.max(0.01, g('freq'));
  c.duty = g('duty'); c.phase = g('phase'); c.noise = g('noise');
  $(`gen-amp-v-${i}`).textContent = Math.round(c.amp);
  $(`gen-off-v-${i}`).textContent = Math.round(c.off);
  $(`gen-freq-v-${i}`).textContent = `${c.freq.toFixed(1)} Hz`;
  $(`gen-duty-v-${i}`).textContent = `${c.duty}%`;
  $(`gen-phase-v-${i}`).textContent = `${c.phase}°`;
  $(`gen-noise-v-${i}`).textContent = Math.round(c.noise);
  const periodic = c.wave !== 'dc' && c.wave !== 'noise';
  $(`gen-freq-row-${i}`).hidden = !periodic;
  $(`gen-phase-row-${i}`).hidden = !periodic;
  $(`gen-duty-row-${i}`).hidden = c.wave !== 'square';
  $(`gen-strip-${i}`).classList.toggle('off', !c.on);
  $(`gen-freq-v-${i}`).style.color = periodic && c.freq > gen.rate / 2 ? 'var(--warn)' : '';
}

function setGenShown(i, shown) {
  gen.ch[i].shown = shown;
  $(`gen-strip-${i}`).hidden = !shown;
  $(`gen-add-${i}`).hidden = shown;
  store.set('genShown', gen.ch.map(c => c.shown));
}

function genValue(c, t) {
  const ph = t * c.freq + c.phase / 360, x = ph - Math.floor(ph);
  let y;
  switch (c.wave) {
    case 'sine': y = Math.sin(2 * Math.PI * x); break;
    case 'square': y = x < c.duty / 100 ? 1 : -1; break;
    case 'sawtooth': y = 2 * x - 1; break;
    case 'triangle': y = x < 0.5 ? 4 * x - 1 : 3 - 4 * x; break;
    case 'noise': y = Math.random() * 2 - 1; break;
    default: y = 0;
  }
  let val = c.off + c.amp * y;
  if (c.noise > 0) val += (Math.random() * 2 - 1) * c.noise;
  return val;
}

// Campioni a passo fisso sul tempo reale: niente deriva se setInterval ritarda
function genTick() {
  const now = performance.now() / 1000;
  if (now - gen.nextT > 2) gen.nextT = now; // scheda in background a lungo: salta
  const dt = 1 / gen.rate;
  let count = 0;
  while (gen.nextT <= now && count < 5000) {
    const t = gen.nextT;
    const vals = gen.ch.map(c => (c.shown && c.on ? genValue(c, t - gen.t0) * units.k : null));
    if (vals.some(v => v != null)) ingest(t, vals);
    gen.nextT += dt;
    count++;
  }
}

function setGenEnabled(on) {
  $('gen-enabled').checked = on;
  updateLeds();
  if (on === gen.on) return;
  if (on) {
    if (serial.port) { closePort(); toast('Seriale disconnessa: ora la sorgente è il generatore', 'warn'); }
    serial.labels.clear();
    chState.forEach(c => { c.name = null; });
    updateChannelNames();
    clearAll();
    gen.on = true;
    gen.t0 = gen.nextT = performance.now() / 1000;
    gen.timer = setInterval(genTick, 10);
    setSource('gen');
  } else {
    clearInterval(gen.timer);
    gen.timer = null;
    gen.on = false;
    setSource(serial.port ? 'serial' : 'none');
  }
}

// ═══════════════════════════════════════════════════════════════
//  Web Serial
// ═══════════════════════════════════════════════════════════════
const serial = { port: null, reader: null, pipe: null, loop: null, closing: false, buf: '', labels: new Map() };
const tsState = { devBase: null, lastT: -Infinity, lastChunk: null, dtEst: 0.01 };

function resetTimestamps() {
  Object.assign(tsState, { devBase: null, lastT: -Infinity, lastChunk: null, dtEst: 0.01 });
}

function channelForLabel(name) {
  if (serial.labels.has(name)) return serial.labels.get(name);
  if (serial.labels.size >= NCH) return -1;
  const ci = serial.labels.size;
  serial.labels.set(name, ci);
  chState[ci].name = name;
  updateChannelNames();
  return ci;
}

// Formati: "1,2,3" · "1 2 3" · "1;2;3" · "a:1,b:2" (Serial Plotter) · prima colonna = timestamp (opzionale)
function parseLine(line, tsMode) {
  line = line.trim();
  if (!line) return null;
  const tokens = line.split(/[\s,;]+/).filter(Boolean);
  const vals = new Array(NCH).fill(null);
  let dev = null, any = false;
  if (tokens.some(tk => tk.includes(':'))) {
    for (const tk of tokens) {
      const c = tk.lastIndexOf(':');
      if (c <= 0) continue;
      const num = parseFloat(tk.slice(c + 1));
      if (!isNum(num)) continue;
      const ci = channelForLabel(tk.slice(0, c));
      if (ci < 0) continue;
      vals[ci] = num * units.k;
      any = true;
    }
  } else {
    const nums = tokens.map(parseFloat);
    let idx = 0;
    if (tsMode !== 'none') {
      if (!isNum(nums[0]) || nums.length < 2) return null;
      dev = tsMode === 'us' ? nums[0] / 1e6 : nums[0] / 1e3;
      idx = 1;
    }
    for (let ci = 0; ci < NCH && idx < nums.length; ci++, idx++) {
      if (isNum(nums[idx])) { vals[ci] = nums[idx] * units.k; any = true; }
    }
  }
  return any ? { vals, dev } : null;
}

function deviceToSession(sec) {
  if (tsState.devBase == null) tsState.devBase = performance.now() / 1000 - sec;
  let t = sec + tsState.devBase;
  if (t < tsState.lastT - 0.001) {
    // reset della scheda o overflow di micros(): si riallinea la base
    tsState.devBase = tsState.lastT + tsState.dtEst - sec;
    t = sec + tsState.devBase;
  }
  return t;
}

function onSerialChunk(text) {
  serial.buf += text;
  const lines = serial.buf.split(/\r?\n/);
  serial.buf = lines.pop();
  if (serial.buf.length > 4096) serial.buf = ''; // riga senza terminatore: probabilmente baud errato
  const tsMode = $('ts-mode').value;
  const parsed = [];
  for (const l of lines) { const p = parseLine(l, tsMode); if (p) parsed.push(p); }
  if (!parsed.length) return;

  // Senza timestamp della scheda: le righe arrivate nello stesso blocco vengono
  // distribuite uniformemente nel tempo trascorso dal blocco precedente.
  const now = performance.now() / 1000, k = parsed.length;
  const gap = tsState.lastChunk == null ? null : now - tsState.lastChunk;
  let dt = tsState.dtEst;
  if (gap != null && gap > 0 && gap < 0.5) { dt = gap / k; tsState.dtEst = tsState.dtEst * 0.8 + dt * 0.2; }
  tsState.lastChunk = now;

  parsed.forEach((p, i) => {
    let t = p.dev != null ? deviceToSession(p.dev) : now - (k - 1 - i) * dt;
    if (p.dev != null && isFinite(tsState.lastT) && t > tsState.lastT && t - tsState.lastT < 1) {
      tsState.dtEst = tsState.dtEst * 0.9 + (t - tsState.lastT) * 0.1;
    }
    if (t <= tsState.lastT) t = tsState.lastT + 1e-6;
    tsState.lastT = t;
    ingest(t, p.vals);
  });
}

function updateConnUI() {
  const on = !!serial.port;
  const btn = $('conn-btn');
  btn.textContent = on ? '🔌 Disconnetti' : '🔌 Connetti seriale';
  btn.classList.toggle('connected', on);
  const st = $('conn-status');
  st.textContent = on ? '● connesso' : '● disconnesso';
  st.classList.toggle('connected', on);
  $('tx-input').disabled = !on;
  $('tx-send').disabled = !on;
}

async function connectSerial() {
  let port;
  try { port = await navigator.serial.requestPort(); }
  catch (e) { if (e.name !== 'NotFoundError') toast(`Errore: ${e.message}`, 'error'); return; }
  await openPort(port);
}

async function openPort(port) {
  try { await port.open({ baudRate: +$('baud-sel').value, bufferSize: 65536 }); }
  catch (e) { toast(`Impossibile aprire la porta: ${e.message}`, 'error'); return; }
  if (gen.on) { setGenEnabled(false); toast('Generatore disattivato: ora la sorgente è la seriale', 'warn'); }
  serial.port = port;
  serial.buf = '';
  serial.labels.clear();
  chState.forEach(c => { c.name = null; });
  updateChannelNames();
  resetTimestamps();
  clearAll();
  setSource('serial');
  updateConnUI();
  serial.loop = readLoop(port);
}

async function readLoop(port) {
  const decoder = new TextDecoderStream();
  serial.pipe = port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  serial.reader = reader;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) onSerialChunk(value);
    }
  } catch (e) {
    if (!serial.closing) toast(`Connessione seriale persa: ${e.message}`, 'error');
  } finally {
    reader.releaseLock();
  }
  if (!serial.closing) { serial.loop = null; await closePort(); }
}

async function closePort() {
  if (!serial.port || serial.closing) return;
  serial.closing = true;
  const port = serial.port;
  try { await serial.reader?.cancel(); } catch { /* già chiuso */ }
  await serial.pipe;
  if (serial.loop) await serial.loop;
  try { await port.close(); } catch (e) { console.warn('Chiusura porta:', e); }
  Object.assign(serial, { port: null, reader: null, pipe: null, loop: null, buf: '', closing: false });
  updateConnUI();
  setSource(gen.on ? 'gen' : 'none');
}

async function sendSerial() {
  const port = serial.port;
  if (!port?.writable) return;
  const eol = { lf: '\n', crlf: '\r\n', none: '' }[$('tx-eol').value];
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode($('tx-input').value + eol));
    $('tx-input').select();
  } catch (e) {
    toast(`Invio fallito: ${e.message}`, 'error');
  } finally {
    writer.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════════════
//  Registrazione, CSV, log
// ═══════════════════════════════════════════════════════════════
function recordSample(s) {
  if (rec.samples.length >= MAX_RECORD) {
    setRec(false);
    toast('Registrazione fermata: raggiunto il limite di 2 milioni di campioni', 'warn');
    return;
  }
  rec.samples.push(s);
}
function setRec(on) {
  rec.on = on;
  if (on) rec.samples = [];
  $('rec-btn').setAttribute('aria-pressed', String(on));
  $('rec-btn').textContent = on ? '■ STOP' : '● REC';
  updateRecStatus();
}
function updateRecStatus() {
  const n = rec.samples.length, el = $('rec-status');
  const dur = n >= 2 ? (rec.samples[n - 1].t - rec.samples[0].t) * 1000 : 0;
  el.textContent = n ? `${fmtTime(dur)} · ${n} campioni` : rec.on ? 'in attesa di dati…' : '—';
  el.classList.toggle('on', rec.on);
  $('download-rec').disabled = !n;
}

function csvEscape(s) { return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function downloadCsv(samples, prefix) {
  if (!samples.length) { toast('Nessun dato da esportare'); return; }
  const used = CHANNELS.map((_, i) => samples.some(s => s.v[i] != null));
  const idx = used.map((u, i) => (u ? i : -1)).filter(i => i >= 0);
  const header = ['time_ms', ...idx.map(i => csvEscape(`${CHANNELS[i].label}${chState[i].name ? ` ${chState[i].name}` : ''} [${unitLabel()}]`))].join(',');
  const t0 = samples[0].t;
  const rows = samples.map(s => [((s.t - t0) * 1000).toFixed(3), ...idx.map(i => s.v[i] ?? '')].join(','));
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${prefix}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function appendLog(s) {
  const list = $('values-list');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 30;
  const entry = document.createElement('div');
  entry.className = 'ventry';
  const time = document.createElement('span');
  time.className = 'vtime';
  time.textContent = wallTime();
  const chips = document.createElement('span');
  chips.className = 'vchips';
  s.v.forEach((v, i) => {
    if (v == null) return;
    const chip = document.createElement('span');
    chip.className = 'vchip';
    chip.style.borderColor = CHANNELS[i].color;
    chip.textContent = `${CHANNELS[i].label}: ${fmt(v)}`;
    chips.appendChild(chip);
  });
  entry.append(time, chips);
  list.appendChild(entry);
  while (list.childElementCount > MAX_LOG) list.firstElementChild.remove();
  if (atBottom) list.scrollTop = list.scrollHeight;
}

function infoTick() {
  if (latestForLog) { appendLog(latestForLog); latestForLog = null; }
  const live = rate.dtEma && performance.now() - rate.lastHost < 2000;
  $('info-freq').textContent = live ? fmtFreq(1 / rate.dtEma) : '—';
  $('info-delay').textContent = live ? fmtTime(rate.dtEma * 1000) : '—';
  $('info-buffer').textContent = `${buffer.length}/${MAX_BUFFER}`;
  updateRecStatus();
  if (alarms.dirty) renderAlarmUi();
}

// ═══════════════════════════════════════════════════════════════
//  Impostazioni lette dal DOM
// ═══════════════════════════════════════════════════════════════
function applyUnits(initial = false) {
  const mode = $('units-sel').value;
  const vref = parseFloat($('vref-input').value), bits = +$('bits-sel').value;
  const k = mode === 'v' && vref > 0 ? vref / (2 ** bits - 1) : 1;
  const r = k / units.k;
  units.mode = mode;
  if (!initial && r !== 1 && isNum(r)) {
    const seen = new Set();
    const scale = s => {
      if (seen.has(s)) return;
      seen.add(s);
      for (let i = 0; i < NCH; i++) if (s.v[i] != null) s.v[i] *= r;
    };
    buffer.forEach(scale);
    rec.samples.forEach(scale);
    trig.frame?.samples.forEach(scale);
    view.yRange *= r; view.yOffset *= r;
    for (let i = 0; i < hMarkers.length; i++) hMarkers[i] *= r;
    trig.level *= r;
    trig.prev = null;
    $('trigger-level').value = fmtInput(trig.level);
    saveFormEl($('trigger-level'));
    alarms.rules.forEach(rule => { rule.th *= r; $(`alarm-th-${rule.id}`).value = fmtInput(rule.th); });
    saveAlarms();
    saveView();
    if (fit.enabled) runFit();
  }
  units.k = k;
  updateUnitLabels();
  if ($('math-unit')) $('math-unit').textContent = mathUnit();
  invalidate();
  requestRedraw();
}

function applyDecimation() {
  decim.ms = +$('decim-slider').value;
  decim.nextMs = -Infinity;
  $('decim-display').textContent = decim.ms ? `${decim.ms} ms` : 'OFF';
}

function activateTab(btn, focus = false) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    const on = b === btn;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(b.dataset.tab).classList.toggle('active', on);
  });
  if (focus) btn.focus();
  store.set('tab', btn.dataset.tab);
  // aggiornamento immediato del pannello appena aperto
  if (btn.dataset.tab === 'tab-measure') runMeasure();
  if (btn.dataset.tab === 'tab-fft' && $('fft-enabled').checked) runFFT();
  if (btn.dataset.tab === 'tab-xy' && xy.enabled) { xy.clear = true; runXY(); }
}

// ═══════════════════════════════════════════════════════════════
//  Eventi
// ═══════════════════════════════════════════════════════════════
function wireEvents() {
  // Tab (click + frecce)
  const tabs = [...document.querySelectorAll('.tab-btn')];
  tabs.forEach((b, i) => {
    b.setAttribute('aria-controls', b.dataset.tab);
    b.addEventListener('click', () => activateTab(b));
    b.addEventListener('keydown', e => {
      const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      activateTab(tabs[(i + step + tabs.length) % tabs.length], true);
    });
  });
  document.addEventListener('change', updateLeds);

  // Icone info: un popover per card, chiuso da click esterno o Esc
  const closeInfos = except => document.querySelectorAll('.info-btn[aria-expanded="true"]').forEach(b => {
    if (b === except) return;
    b.setAttribute('aria-expanded', 'false');
    $(b.getAttribute('aria-controls')).hidden = true;
  });
  document.querySelectorAll('.info-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pop = $(btn.getAttribute('aria-controls'));
      closeInfos(btn);
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.info-pop')) closeInfos(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeInfos(); });

  $('theme-sel').addEventListener('change', applyTheme);

  // Canali / visualizzazione
  CHANNELS.forEach((_, i) => $(`ch-vis-${i}`).addEventListener('change', requestRedraw));
  $('points-toggle').addEventListener('change', e => { view.points = e.target.checked; requestRedraw(); });
  $('log-scale-toggle').addEventListener('change', e => { view.logY = e.target.checked; requestRedraw(); });

  // Controlli
  $('y-zoom-in').addEventListener('click', () => zoomY(0.5));
  $('y-zoom-out').addEventListener('click', () => zoomY(2));
  $('y-offset-up').addEventListener('click', () => shiftY(1));
  $('y-offset-down').addEventListener('click', () => shiftY(-1));
  $('x-zoom-in').addEventListener('click', () => setXSamples(view.xSamples / 2));
  $('x-zoom-out').addEventListener('click', () => setXSamples(view.xSamples * 2));
  $('autoscale-btn').addEventListener('click', autoscale);
  $('clear-btn').addEventListener('click', clearAll);
  $('pause-btn').addEventListener('click', () => setPaused(!paused));
  $('decim-slider').addEventListener('input', applyDecimation);

  // Trigger
  $('trigger-enabled').addEventListener('change', e => setTriggerEnabled(e.target.checked));
  ['trigger-mode', 'trigger-channel', 'trigger-edge', 'trigger-level', 'trigger-pos', 'trigger-hold'].forEach(id =>
    $(id).addEventListener('change', () => {
      if (id !== 'trigger-level' && id !== 'trigger-hold') trig.frame = null;
      readTriggerSettings();
    }));
  $('trigger-50').addEventListener('click', trigLevelTo50);
  $('trigger-status').addEventListener('click', () => { if (trig.enabled) rearmTrigger(); });

  // Generatore
  $('gen-enabled').addEventListener('change', e => setGenEnabled(e.target.checked));
  $('gen-rate').addEventListener('change', e => {
    gen.rate = +e.target.value;
    gen.nextT = performance.now() / 1000;
    gen.ch.forEach((_, i) => readGenCh(i));
  });
  CHANNELS.forEach((_, i) => {
    $(`gen-strip-${i}`).addEventListener('input', () => readGenCh(i));
    $(`gen-strip-${i}`).addEventListener('change', () => readGenCh(i));
  });
  $('gen-strips').addEventListener('click', e => {
    const b = e.target.closest('[data-gen-remove]');
    if (b) setGenShown(+b.dataset.genRemove, false);
  });
  $('gen-add-btns').addEventListener('click', e => {
    const b = e.target.closest('[data-gen-add]');
    if (!b) return;
    const i = +b.dataset.genAdd;
    $(`gen-on-${i}`).checked = true;
    readGenCh(i);
    setGenShown(i, true);
  });

  // Fit
  $('analysis-enabled').addEventListener('change', e => setFitEnabled(e.target.checked));
  $('analysis-fit').addEventListener('change', runFit);
  $('analysis-channel').addEventListener('change', runFit);

  // Misure / FFT / XY
  $('measure-now').addEventListener('click', runMeasure);

  // Matematica
  ['math-enabled', 'math-op', 'math-a', 'math-b', 'math-n', 'math-fc', 'math-gain'].forEach(id => $(id).addEventListener('change', readMath));

  // Allarmi
  $('alarm-enabled').addEventListener('change', e => setAlarmsEnabled(e.target.checked));
  $('alarm-add').addEventListener('click', () => {
    // nuova regola sul primo canale attivo, soglia all'80% della sua escursione
    const ch = Math.max(0, chState.findIndex(c => c.active));
    let mn = Infinity, mx = -Infinity;
    for (const smp of getFrame().samples) { const v = smp.v[ch]; if (v == null) continue; if (v < mn) mn = v; if (v > mx) mx = v; }
    addAlarmRule({ ch, th: mn < mx ? mn + (mx - mn) * 0.8 : 700 * units.k });
  });
  $('alarm-sound').addEventListener('change', e => { if (e.target.checked) beep(); });
  $('alarm-clear').addEventListener('click', () => {
    alarms.log = [];
    alarms.rules.forEach(r => { r.count = 0; });
    renderAlarmUi();
  });
  $('alarm-rules').addEventListener('change', e => {
    const block = e.target.closest('.alarm-rule');
    if (block) readAlarmRule(+block.dataset.id);
  });
  $('alarm-rules').addEventListener('click', e => {
    const b = e.target.closest('[data-alarm-remove]');
    if (b) removeAlarmRule(+b.dataset.alarmRemove);
  });
  $('fft-enabled').addEventListener('change', e => { if (e.target.checked) runFFT(); else clearFFT(); });
  ['fft-window', 'fft-size', 'fft-scale'].forEach(id => $(id).addEventListener('change', () => {
    updateUnitLabels();
    if ($('fft-enabled').checked) runFFT();
  }));
  CHANNELS.forEach((_, i) => $(`fft-ch-${i}`).addEventListener('change', () => { if ($('fft-enabled').checked) runFFT(); }));
  $('xy-enabled').addEventListener('change', e => { xy.enabled = e.target.checked; if (xy.enabled) { xy.clear = true; runXY(); } else clearXY(); });
  ['xy-ch-x', 'xy-ch-y', 'xy-points', 'xy-persist', 'xy-scale', 'xy-trace'].forEach(id =>
    $(id).addEventListener('change', () => { xy.clear = true; if (xy.enabled) runXY(); }));
  new ResizeObserver(() => { if (xy.enabled) runXY(); }).observe($('xy-plot').parentElement);

  // Setup
  ['units-sel', 'vref-input', 'bits-sel'].forEach(id => $(id).addEventListener('change', () => applyUnits()));
  $('ts-mode').addEventListener('change', () => { resetTimestamps(); clearAll(); });

  // Seriale
  if ('serial' in navigator) {
    $('conn-btn').addEventListener('click', () => (serial.port ? closePort() : connectSerial()));
    navigator.serial.addEventListener('disconnect', e => {
      if (e.target === serial.port) { toast('Dispositivo scollegato', 'warn'); closePort(); }
    });
    $('baud-sel').addEventListener('change', async () => {
      if (!serial.port) return;
      const port = serial.port;
      await closePort();
      await openPort(port);
    });
  } else {
    $('no-serial-warn').hidden = false;
    $('conn-btn').disabled = true;
  }
  $('tx-send').addEventListener('click', sendSerial);
  $('tx-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendSerial(); });

  // Registrazione / CSV
  $('rec-btn').addEventListener('click', () => setRec(!rec.on));
  $('download-rec').addEventListener('click', () => downloadCsv(rec.samples, 'registrazione'));
  $('download-csv').addEventListener('click', () => downloadCsv(buffer, 'buffer'));
  window.addEventListener('beforeunload', e => { if (rec.samples.length) { e.preventDefault(); e.returnValue = ''; } });

  // Scorciatoie da tastiera
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.matches('input[type="text"], input[type="number"], select, textarea')) return;
    if ((e.key === ' ' || e.key === 'Enter') && t.matches('button, input, [role="tab"]')) return;
    if (e.key.startsWith('Arrow') && t.matches('[role="tab"]')) return;
    const actions = {
      ' ': () => setPaused(!paused),
      a: autoscale, A: autoscale,
      c: clearAll, C: clearAll,
      r: () => setRec(!rec.on), R: () => setRec(!rec.on),
      t: () => trig.enabled && rearmTrigger(), T: () => trig.enabled && rearmTrigger(),
      '+': () => zoomY(0.5), '=': () => zoomY(0.5), '-': () => zoomY(2),
      ']': () => setXSamples(view.xSamples / 2), '[': () => setXSamples(view.xSamples * 2),
      ArrowUp: () => shiftY(1), ArrowDown: () => shiftY(-1),
    };
    if (t.matches('input[type="range"]') && e.key.startsWith('Arrow')) return;
    const fn = actions[e.key];
    if (fn) { e.preventDefault(); fn(); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestRedraw(); });
}

// ═══════════════════════════════════════════════════════════════
//  Avvio
// ═══════════════════════════════════════════════════════════════
function init() {
  buildUi();
  restoreForm();
  applyTheme();
  createCharts();
  wirePlotPointer();
  wireEvents();

  // Stato iniziale dai controlli (eventualmente ripristinati)
  view.points = $('points-toggle').checked;
  view.logY = $('log-scale-toggle').checked;
  view.xSamples = clamp(view.xSamples, X_MIN, X_MAX);
  applyUnits(true);
  applyDecimation();
  readTriggerSettings();
  gen.rate = +$('gen-rate').value;
  const shown = store.get('genShown', [true]);
  CHANNELS.forEach((_, i) => { readGenCh(i); setGenShown(i, !!shown[i]); });
  xy.enabled = $('xy-enabled').checked;
  readMath();
  store.get('alarms', []).forEach(r => addAlarmRule(r));
  setAlarmsEnabled($('alarm-enabled').checked);
  const tabBtn = document.querySelector(`.tab-btn[data-tab="${store.get('tab', 'tab-trigger')}"]`) || document.querySelector('.tab-btn');
  activateTab(tabBtn);
  setSource('none');
  updateConnUI();
  onChannelsChanged();
  updateLeds();

  setInterval(infoTick, INFO_MS);
  setInterval(() => {
    if (!document.hidden && isTabActive('tab-measure') && $('measure-auto').checked) runMeasure();
  }, MEASURE_MS);
  setInterval(() => {
    if (!document.hidden && isTabActive('tab-fft') && $('fft-enabled').checked) runFFT();
  }, FFT_MS);
  setInterval(() => {
    if (!document.hidden && isTabActive('tab-xy') && xy.enabled) runXY();
  }, XY_MS);
  render();
}

init();

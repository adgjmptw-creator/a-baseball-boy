// やきゅう フォームチェック — 画面の流れ（ホーム → 入力 → 解析中 → 結果）
// 動画・骨格データはメモリ(Blob URL)にだけ置き、どこにも送信しない。
import { drawSkeleton, fitCanvasToVideo, drawFrameWithSkeleton } from './overlay.js';

const $ = (id) => document.getElementById(id);
const MAX_RECORD_SEC = 15;
const MAX_FRAMES = 300;
const MODE_LABEL = { pitch: '⚾ なげる', bat: '🏏 うつ' };
const MODE_KEY = 'abb:lastMode';
const NET_MSG = 'インターネットに つないで もういちど ためしてね';

const CHEERS = [
  'がんばって しらべているよ！',
  'フォームを コマおくりで みているよ 👀',
  'ナイス どうが！ もうすこし まってね',
  'AIが ぼうしの かたむきまで チェック中…',
  'いいね その チョーシ！ ⚾',
  'もうすぐ けっかが でるよ ✨',
  'ほねの うごきを おいかけているよ 🦴',
];

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------- state
const state = {
  mode: 'pitch',
  clip: null,            // { blob, url, hintMs }
  stream: null,
  recorder: null,
  recTimer: null,
  recStart: 0,
  run: 0,                // 解析ラン番号（キャンセル用）
  cancelled: false,
  cheerTimer: null,
  video: null,           // 結果画面でも使いまわす非表示 video
  frames: [],
  meta: null,
  result: null,
  feedback: null,
  thumbs: [],            // [{moment, canvas}]
  lock: Promise.resolve(),
};

function safeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } }

// ---------------------------------------------------------------- screens
const SCREENS = ['home', 'input', 'analyzing', 'fail', 'result'];
function showScreen(name) {
  for (const s of SCREENS) $('screen-' + s).hidden = s !== name;
  window.scrollTo(0, 0);
  const h = $('screen-' + name).querySelector('h1, h2');
  if (h) h.focus({ preventScroll: true });
}

function showInputPanel(which) {
  $('input-choose').hidden = which !== 'choose';
  $('input-camera').hidden = which !== 'camera';
  $('input-review').hidden = which !== 'review';
}

function setInputError(msg) {
  const el = $('input-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------------------------------------------------------------- home
function setupHome() {
  const last = safeGet(MODE_KEY);
  for (const btn of document.querySelectorAll('[data-mode]')) {
    if (btn.dataset.mode === last) btn.querySelector('.last-badge').hidden = false;
    btn.addEventListener('click', () => openInput(btn.dataset.mode));
  }
}

function goHome() {
  cleanupAll();
  showScreen('home');
}

// ---------------------------------------------------------------- input
function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof window.MediaRecorder !== 'undefined');
}

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const list = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return list.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
}

function openInput(mode) {
  state.mode = mode;
  safeSet(MODE_KEY, mode);
  cleanupAll();
  $('input-mode-pill').textContent = MODE_LABEL[mode];
  setInputError('');
  $('file-input').value = '';
  $('file-capture').value = '';
  const note = $('camera-note');
  if (!cameraSupported()) {
    note.textContent = 'この ブラウザでは アプリの中で さつえいできないので、スマホの カメラで さつえいするよ。';
    note.hidden = false;
  } else {
    note.hidden = true;
  }
  showInputPanel('choose');
  showScreen('input');
}

function releaseClip() {
  if (state.clip) {
    try { URL.revokeObjectURL(state.clip.url); } catch (_) { /* ignore */ }
    state.clip = null;
  }
  const rv = $('review-video');
  rv.pause();
  rv.removeAttribute('src');
  rv.load();
}

function setClip(blob, hintMs) {
  releaseClip();
  state.clip = { blob, url: URL.createObjectURL(blob), hintMs: hintMs || 0 };
  const rv = $('review-video');
  rv.src = state.clip.url;
  rv.load();
  setInputError('');
  showInputPanel('review');
}

function onFilePicked(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.type && !file.type.startsWith('video/')) {
    setInputError('どうがの ファイルを えらんでね。');
    return;
  }
  setClip(file, 0);
  showScreen('input');
}

// ---- camera
async function startCamera() {
  setInputError('');
  if (!cameraSupported()) {
    $('file-capture').click();
    return;
  }
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      if (e && (e.name === 'OverconstrainedError' || e.name === 'NotReadableError')) {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      } else {
        throw e;
      }
    }
    state.stream = stream;
    const lv = $('live-video');
    lv.srcObject = stream;
    lv.muted = true;
    await lv.play().catch(() => {});
    resetRecordUi();
    showInputPanel('camera');
  } catch (e) {
    stopCamera();
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      setInputError('カメラが つかえないよ。ブラウザの せっていで カメラを ゆるしてね。「どうがを えらぶ」からも つかえるよ！');
    } else if (n === 'NotFoundError' || n === 'DevicesNotFoundError') {
      setInputError('カメラが みつからないよ。「どうがを えらぶ」から どうがを えらんでね。');
    } else {
      setInputError('カメラを ひらけなかったよ。「どうがを えらぶ」から どうがを えらんでね。');
    }
    showInputPanel('choose');
  }
}

function stopCamera() {
  clearInterval(state.recTimer);
  state.recTimer = null;
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.onstop = null;
    try { state.recorder.stop(); } catch (_) { /* ignore */ }
  }
  state.recorder = null;
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  const lv = $('live-video');
  lv.pause();
  lv.srcObject = null;
}

function resetRecordUi() {
  $('btn-record').classList.remove('recording');
  $('btn-record').setAttribute('aria-label', 'さつえいを はじめる');
  $('rec-badge').hidden = true;
  $('rec-label').textContent = 'タップで さつえい スタート';
  $('rec-hint').textContent = 'スマホを うごかないように おいて、ぜんしんを うつしてね。';
  $('btn-camera-cancel').hidden = false;
}

function startRecording() {
  if (!state.stream) return;
  const mimeType = pickMimeType();
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  } catch (_) {
    try { rec = new MediaRecorder(state.stream); } catch (e) {
      stopCamera();
      setInputError('この ブラウザでは さつえいできないよ。「どうがを えらぶ」から どうがを えらんでね。');
      showInputPanel('choose');
      return;
    }
  }
  state.recorder = rec;
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const elapsed = Date.now() - state.recStart;
    const type = rec.mimeType || mimeType || 'video/webm';
    const blob = new Blob(chunks, { type });
    stopCamera();
    if (!blob.size) {
      setInputError('うまく さつえいできなかったよ。もういちど ためしてね。');
      showInputPanel('choose');
      return;
    }
    setClip(blob, elapsed);
  };
  rec.start(250);
  state.recStart = Date.now();
  $('btn-record').classList.add('recording');
  $('btn-record').setAttribute('aria-label', 'さつえいを とめる');
  $('rec-badge').hidden = false;
  $('rec-hint').textContent = 'とれたら もういちど ボタンを タップ！';
  $('btn-camera-cancel').hidden = true;
  const tick = () => {
    const sec = (Date.now() - state.recStart) / 1000;
    $('rec-time').textContent = `${Math.floor(sec)} / ${MAX_RECORD_SEC}びょう`;
    $('rec-label').textContent = 'さつえい中… タップで ストップ';
    if (sec >= MAX_RECORD_SEC) stopRecording();
  };
  tick();
  state.recTimer = setInterval(tick, 200);
}

function stopRecording() {
  clearInterval(state.recTimer);
  state.recTimer = null;
  if (state.recorder && state.recorder.state !== 'inactive') {
    try { state.recorder.stop(); } catch (_) { /* ignore */ }
  }
}

function onRecordClick() {
  if (state.recorder && state.recorder.state === 'recording') stopRecording();
  else startRecording();
}

// ---------------------------------------------------------------- video helpers
function waitEvent(el, ok, ng, ms) {
  return new Promise((resolve) => {
    let t;
    const done = (v) => {
      clearTimeout(t);
      el.removeEventListener(ok, onOk);
      if (ng) el.removeEventListener(ng, onNg);
      resolve(v);
    };
    const onOk = () => done(true);
    const onNg = () => done(false);
    el.addEventListener(ok, onOk, { once: true });
    if (ng) el.addEventListener(ng, onNg, { once: true });
    t = setTimeout(() => done(false), ms);
  });
}

async function loadVideo(video, url) {
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  if (video.readyState < 1) {
    const ok = await waitEvent(video, 'loadedmetadata', 'error', 15000);
    if (!ok) throw new Error('video-load');
  }
  if (!video.videoWidth) throw new Error('video-load');
  // MediaRecorder の webm は duration が Infinity になることがある
  if (!Number.isFinite(video.duration)) {
    video.currentTime = 1e7;
    await waitEvent(video, 'durationchange', null, 3000);
    await waitEvent(video, 'seeked', null, 1500);
  }
}

// 指定秒へシークして、フレームが出るまで待つ。成功なら true
async function seekTo(video, sec) {
  const target = Math.max(0, sec);
  if (!video.seeking && Math.abs(video.currentTime - target) < 0.0005 && video.readyState >= 2) {
    await nextFrame();
    return true;
  }
  const p = waitEvent(video, 'seeked', null, 3000);
  video.currentTime = target;
  const ok = await p;
  if (ok && video.readyState < 2) await waitEvent(video, 'canplay', null, 800);
  return ok;
}

function getDurationSec(video, hintMs) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  if (hintMs) return hintMs / 1000;
  return 0;
}

// ビデオ操作の直列化（サムネ作成とスライダーが同時にシークしないように）
function enqueue(fn) {
  const run = state.lock.then(fn, fn);
  state.lock = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- analyzing
function setProgress(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('progress-bar').style.width = p + '%';
  $('progress-text').textContent = p + '%';
  $('progress').setAttribute('aria-valuenow', String(p));
}

function startCheers() {
  let i = 0;
  $('cheer').textContent = CHEERS[0];
  clearInterval(state.cheerTimer);
  state.cheerTimer = setInterval(() => {
    i = (i + 1) % CHEERS.length;
    $('cheer').textContent = CHEERS[i];
  }, 2600);
}
function stopCheers() { clearInterval(state.cheerTimer); state.cheerTimer = null; }

// onProgress の引数は 数値(0..1 / 0..100) や {loaded,total} / {progress|ratio|percent} などを許容
function normalizeProgress(a) {
  if (typeof a === 'number' && Number.isFinite(a)) return a > 1 ? a / 100 : a;
  if (a && typeof a === 'object') {
    if (a.total > 0 && a.loaded >= 0) return a.loaded / a.total;
    for (const k of ['progress', 'ratio', 'fraction']) {
      if (typeof a[k] === 'number') return a[k] > 1 ? a[k] / 100 : a[k];
    }
    if (typeof a.percent === 'number') return a.percent / 100;
  }
  return null;
}

class Cancelled extends Error {}

function showFail(reason, opts = {}) {
  stopCheers();
  $('fail-title').textContent = opts.title || 'うまく みえなかったよ';
  $('fail-reason').textContent = reason;
  $('btn-fail-retry').querySelector('.btn-text').textContent = opts.retryLabel || 'もういちど とってみよう！';
  state.failAction = opts.action || 'retake';
  showScreen('fail');
}

async function runAnalysis() {
  if (!state.clip) return;
  const run = ++state.run;
  state.cancelled = false;
  const isCancelled = () => state.cancelled || state.run !== run;
  const mode = state.mode;

  showScreen('analyzing');
  setProgress(0);
  startCheers();
  $('analyze-note').hidden = false;
  $('analyze-note').textContent = 'はじめての ときは、AIの モデル（5〜10MBくらい）を ダウンロードするので ちょっと まってね。';

  const video = $('analyze-video');
  const canvas = $('analyze-canvas');
  canvas.width = 320; canvas.height = 240;
  canvas.getContext('2d').clearRect(0, 0, 320, 240);
  state.video = video;
  state.frames = [];
  state.result = null;
  state.feedback = null;
  state.thumbs = [];

  let detector = null;
  try {
    // --- モジュール読み込み
    let mods;
    try {
      mods = await Promise.all([import('./pose.js'), import('./analyze.js'), import('./feedback.js')]);
    } catch (e) {
      console.error(e);
      throw Object.assign(new Error('modules'), { friendly: NET_MSG });
    }
    const [{ createPoseDetector }, { analyze }, { buildFeedback }] = mods;

    // --- 動画を開く
    try {
      await loadVideo(video, state.clip.url);
    } catch (e) {
      throw Object.assign(new Error('video'), { friendly: 'この どうがは ひらけなかったよ。ほかの どうがで ためしてね。' });
    }
    const durSec = getDurationSec(video, state.clip.hintMs);
    if (!(durSec > 0.3)) {
      throw Object.assign(new Error('short'), { friendly: 'どうがが みじかすぎるよ。もうすこし ながく とってみてね。' });
    }
    fitCanvasToVideo(canvas, video, 640);

    // --- モデル（初回ダウンロード）
    const makeDetector = () => createPoseDetector({
      onProgress: (a) => {
        const f = normalizeProgress(a);
        if (f !== null) setProgress(Math.min(20, f * 20));
      },
    });
    try {
      detector = await makeDetector();
    } catch (e) {
      console.error(e);
      throw Object.assign(new Error('model'), { friendly: NET_MSG, title: 'AIを よみこめなかったよ' });
    }
    if (isCancelled()) throw new Cancelled();
    setProgress(20);
    $('analyze-note').textContent = 'モデルの じゅんび ばっちり！ いま フォームを しらべているよ。';

    // --- フレームを順に処理
    const baseDt = durSec < 6 ? 1 / 20 : 1 / 15;
    const dt = Math.max(baseDt, durSec / MAX_FRAMES);
    const fps = Math.round(1 / dt);
    const total = Math.floor((durSec - 0.02) / dt) + 1;
    const frames = [];
    let lastTs = -1;
    let errCount = 0;
    const ctx = canvas.getContext('2d');

    const processAt = async (tMs) => {
      tMs = Math.max(Math.round(tMs), lastTs + 1);
      lastTs = tMs;
      let det = { landmarks: null, world: null };
      try {
        det = (await detector.detect(video, tMs)) || det;
        errCount = 0;
      } catch (e) {
        errCount++;
        if (errCount >= 8) throw Object.assign(new Error('detect'), { friendly: 'フォームを しらべられなかったよ。ブラウザを あたらしくして もういちど ためしてね。', title: 'ごめんね' });
      }
      frames.push({ t: tMs, landmarks: det.landmarks || null, world: det.world || null });
      // たのしい ライブ プレビュー
      const { w, h } = fitCanvasToVideo(canvas, video, 640);
      try { ctx.drawImage(video, 0, 0, w, h); } catch (_) { /* ignore */ }
      if (det.landmarks) drawSkeleton(ctx, det.landmarks, w, h);
      setProgress(20 + 75 * Math.min(1, tMs / (durSec * 1000)));
    };

    let seekFails = 0;
    let seekingBroken = false;
    for (let i = 0; i < total; i++) {
      if (isCancelled()) throw new Cancelled();
      const tSec = Math.min(i * dt, Math.max(0, durSec - 0.02));
      const ok = await seekTo(video, tSec);
      if (!ok) {
        seekFails++;
        if (seekFails >= 3 && frames.length < 3) { seekingBroken = true; break; }
        continue;
      }
      seekFails = 0;
      await processAt(video.currentTime * 1000);
      if (i % 4 === 3) await nextFrame();
    }

    if (seekingBroken) {
      // Safari などでシークが不安定なとき: ゆっくり再生しながら 1コマずつ処理
      frames.length = 0;
      lastTs = -1;
      try { detector.close(); } catch (_) { /* ignore */ }
      detector = await makeDetector();
      await playbackPass(video, durSec, dt, processAt, isCancelled);
    }

    if (isCancelled()) throw new Cancelled();
    if (!frames.length) {
      throw Object.assign(new Error('noframes'), { friendly: 'どうがの コマを よみとれなかったよ。ほかの どうがで ためしてね。' });
    }
    video.pause();
    try { detector.close(); } catch (_) { /* ignore */ }
    detector = null;

    // --- 解析
    setProgress(96);
    $('cheer').textContent = 'フォームを けいさん中…';
    await sleep(30);
    const meta = {
      width: video.videoWidth,
      height: video.videoHeight,
      fps,
      durationMs: Math.round(durSec * 1000),
    };
    const result = analyze(mode, frames, meta);
    if (isCancelled()) throw new Cancelled();
    if (!result || !result.ok) {
      showFail((result && result.reason) || 'からだぜんたいが うつるように さつえいしてね。');
      return;
    }
    const feedback = buildFeedback(result);
    setProgress(100);
    state.frames = frames;
    state.meta = meta;
    state.result = result;
    state.feedback = feedback;
    await sleep(250);
    stopCheers();
    await renderResult(result, feedback);
  } catch (e) {
    if (detector) { try { detector.close(); } catch (_) { /* ignore */ } }
    if (e instanceof Cancelled) return;
    console.error(e);
    if (state.run !== run) return;
    showFail(e.friendly || 'うまく いかなかったよ。もういちど ためしてね。', {
      title: e.title || 'ごめんね',
      retryLabel: e.friendly === NET_MSG ? 'もういちど ためす' : undefined,
      action: e.friendly === NET_MSG ? 'analyze' : 'retake',
    });
  }
}

// シークが使えないときの代替: 0.5倍速で再生しながら requestVideoFrameCallback で処理
function playbackPass(video, durSec, dt, processAt, isCancelled) {
  return new Promise(async (resolve) => {
    await seekTo(video, 0);
    video.playbackRate = 0.5;
    let busy = false;
    let finished = false;
    let lastMs = -Infinity;
    let lastProgressAt = Date.now();
    const useRvfc = typeof video.requestVideoFrameCallback === 'function';

    const finish = async () => {
      if (finished) return;
      finished = true;
      clearInterval(watch);
      video.pause();
      while (busy) await sleep(20);
      resolve();
    };
    const onFrame = async (mediaSec) => {
      lastProgressAt = Date.now();
      const ms = mediaSec * 1000;
      if (busy || ms - lastMs < dt * 1000 * 0.9) return;
      busy = true;
      lastMs = ms;
      try { await processAt(ms); } catch (_) { /* skip */ }
      busy = false;
    };
    const schedule = () => {
      if (finished) return;
      if (isCancelled()) { finish(); return; }
      if (useRvfc) video.requestVideoFrameCallback((_, md) => { onFrame(md.mediaTime); schedule(); });
      else requestAnimationFrame(() => { onFrame(video.currentTime); schedule(); });
    };
    const watch = setInterval(() => {
      if (Date.now() - lastProgressAt > 6000) finish(); // 止まったら おしまい
    }, 1000);
    video.addEventListener('ended', finish, { once: true });
    try {
      await video.play();
    } catch (_) { finish(); return; }
    schedule();
  });
}

// ---------------------------------------------------------------- result
const RATING = {
  good: { cls: 'chip-good', mark: '◎', word: 'すごい' },
  ok: { cls: 'chip-ok', mark: '○', word: 'いいね' },
  try: { cls: 'chip-try', mark: '△', word: 'ねらおう' },
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmtVal(m) {
  if (typeof m.value !== 'number' || !Number.isFinite(m.value)) return '';
  const v = Math.abs(m.value) >= 100 ? Math.round(m.value) : Math.round(m.value * 10) / 10;
  return `${v}${m.unit || ''}`;
}

function fmtSec(ms) { return (Math.max(0, ms) / 1000).toFixed(1) + 'びょう'; }

function renderStars(n) {
  const wrap = $('stars');
  wrap.textContent = '';
  const count = Math.max(1, Math.min(5, Math.round(n) || 1));
  wrap.setAttribute('aria-label', `5つ中 ${count}つの ほし`);
  for (let i = 0; i < 5; i++) {
    const s = el('span', 'star', '★');
    s.setAttribute('aria-hidden', 'true');
    wrap.appendChild(s);
    if (i < count) {
      if (reduceMotion()) s.classList.add('on', 'static');
      else {
        s.style.animationDelay = `${0.25 + i * 0.22}s`;
        setTimeout(() => s.classList.add('on'), 0);
      }
    }
  }
}

function animateScore(target) {
  const out = $('score-num');
  target = Math.max(0, Math.min(100, Math.round(target) || 0));
  if (reduceMotion()) { out.textContent = String(target); return; }
  const start = performance.now();
  const dur = 1000;
  const step = (now) => {
    const k = Math.min(1, (now - start) / dur);
    out.textContent = String(Math.round(target * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function nearestIndex(tMs) {
  const f = state.frames;
  if (!f.length) return -1;
  let lo = 0, hi = f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f[mid].t < tMs) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(f[lo - 1].t - tMs) <= Math.abs(f[lo].t - tMs)) lo--;
  return lo;
}

async function renderResult(result, feedback) {
  $('result-mode-pill').textContent = MODE_LABEL[result.mode] || '';
  renderStars(result.stars);
  animateScore(result.score);
  $('headline').textContent = (feedback && feedback.headline) || '';

  const praise = $('praise-list');
  praise.textContent = '';
  for (const p of (feedback && feedback.praise) || []) praise.appendChild(el('li', '', p));

  const tips = $('tips-list');
  tips.textContent = '';
  const tipArr = (feedback && feedback.tips) || [];
  if (!tipArr.length) tips.appendChild(el('p', 'empty-note', 'いまのところ、とくに なおすところは ないよ。この チョーシ！'));
  for (const t of tipArr) {
    const card = el('div', 'tip');
    card.appendChild(el('p', 'tip-title', t.title));
    card.appendChild(el('p', 'tip-text', t.text));
    if (t.drill) {
      const d = el('div', 'drill');
      d.appendChild(el('p', 'drill-title', '🏃 れんしゅうほうほう'));
      d.appendChild(el('p', 'drill-text', t.drill));
      card.appendChild(d);
    }
    tips.appendChild(card);
  }

  $('next-goal').textContent = (feedback && feedback.nextGoal) || '';

  const list = $('metrics-list');
  list.textContent = '';
  for (const m of result.metrics || []) {
    const r = RATING[m.rating] || RATING.ok;
    const li = el('li', 'metric');
    const chip = el('span', `chip ${r.cls}`, `${r.mark} ${r.word}`);
    const body = el('div', 'metric-body');
    body.appendChild(el('span', 'metric-label', m.label));
    const val = fmtVal(m);
    if (val) body.appendChild(el('span', 'metric-value', val));
    li.append(chip, body);
    if (m.detail) li.appendChild(el('p', 'metric-detail', m.detail));
    list.appendChild(li);
  }

  // ビューア初期化
  $('viewer').hidden = true;
  const slider = $('viewer-slider');
  slider.max = String(Math.max(0, state.frames.length - 1));
  slider.value = '0';

  const momentsEl = $('moments');
  momentsEl.textContent = '';
  const moments = (result.keyMoments || []).filter((m) => typeof m.t === 'number');
  state.thumbs = [];
  for (const m of moments) {
    const b = el('button', 'moment');
    b.type = 'button';
    b.setAttribute('aria-pressed', 'false');
    const c = document.createElement('canvas');
    c.width = 120; c.height = 160;
    b.append(c, el('span', 'moment-label', m.label), el('span', 'moment-time', fmtSec(m.t)));
    b.addEventListener('click', () => openViewer(m, b));
    momentsEl.appendChild(b);
    state.thumbs.push({ moment: m, canvas: c, button: b });
  }
  $('btn-save').disabled = false;

  showScreen('result');

  // サムネイル作成（動画の該当時刻へシーク）
  for (const th of state.thumbs) {
    await enqueue(async () => {
      const idx = nearestIndex(th.moment.t);
      const f = state.frames[idx];
      if (!state.video || !f) return;
      await seekTo(state.video, f.t / 1000);
      const ar = (state.video.videoHeight || 1) / (state.video.videoWidth || 1);
      th.canvas.style.aspectRatio = `${1} / ${ar}`;
      drawFrameWithSkeleton(th.canvas, state.video, f.landmarks, { maxSide: 240 });
    });
  }
}

let viewerIdx = 0;
let viewerPending = null;
let viewerRunning = false;

function openViewer(moment, button) {
  for (const th of state.thumbs) th.button.setAttribute('aria-pressed', String(th.button === button));
  const idx = Math.max(0, nearestIndex(moment.t));
  $('viewer').hidden = false;
  $('viewer-label').textContent = `${moment.label}（${fmtSec(moment.t)}）`;
  $('viewer-slider').value = String(idx);
  showViewerAt(idx);
  $('viewer').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

function showViewerAt(idx) {
  viewerPending = idx;
  if (viewerRunning) return;
  viewerRunning = true;
  enqueue(async () => {
    while (viewerPending !== null) {
      const i = viewerPending;
      viewerPending = null;
      const f = state.frames[i];
      if (!f || !state.video) continue;
      viewerIdx = i;
      await seekTo(state.video, f.t / 1000);
      drawFrameWithSkeleton($('viewer-canvas'), state.video, f.landmarks, { maxSide: 960 });
      $('viewer-time').textContent = fmtSec(f.t) + (f.landmarks ? '' : '（ほねが みつからなかったよ）');
    }
  }).finally(() => { viewerRunning = false; });
}

function closeViewer() {
  $('viewer').hidden = true;
  for (const th of state.thumbs) th.button.setAttribute('aria-pressed', 'false');
}

// ---- 結果カード PNG
function wrapLines(ctx, text, maxW) {
  const lines = [];
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue; }
    const test = cur + ch;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = ch; } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawResultCard(canvas, result, feedback, draw) {
  const W = 1080;
  const FONT = '"Hiragino Maru Gothic ProN","Hiragino Kaku Gothic ProN","BIZ UDPGothic","Yu Gothic","Meiryo",sans-serif';
  const ctx = canvas.getContext('2d');
  const pad = 56;
  const inner = W - pad * 2;
  let y = 0;
  let indent = 0; // ボックスの中は 内側に よせる

  const text = (str, size, weight, color, opts = {}) => {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const x0 = opts.x ?? pad + indent;
    const mw = opts.maxW ?? inner - indent * 2;
    const lines = wrapLines(ctx, str, mw);
    const lh = Math.round(size * 1.45);
    for (const ln of lines) {
      if (draw) {
        ctx.fillStyle = color;
        ctx.textAlign = opts.align || 'left';
        ctx.fillText(ln, opts.align === 'center' ? W / 2 : x0, y + size);
      }
      y += lh;
    }
  };
  const box = (h, fill, stroke) => {
    if (!draw) return;
    roundRect(ctx, pad - 20, y, inner + 40, h, 32);
    ctx.fillStyle = fill; ctx.fill();
    ctx.lineWidth = 6; ctx.strokeStyle = stroke; ctx.stroke();
  };
  // 高さを測ってからボックスを描くため、ブロックごとに2回走らせる
  const block = (fill, stroke, fn) => {
    const startY = y;
    const saveDraw = draw;
    // 計測
    draw = false;
    indent = 24;
    y += 24;
    fn();
    y += 24;
    const h = y - startY;
    y = startY;
    draw = saveDraw;
    box(h, fill, stroke);
    y += 24;
    fn();
    indent = 0;
    y += 24;
    y += 28;
  };

  if (draw) {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, '#d9efff'); g.addColorStop(1, '#fff4cf');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, canvas.height);
  }
  y = 48;
  text('⚾ やきゅう フォームチェック', 44, 900, '#0c3f9a', { align: 'center' });
  text(`${MODE_LABEL[result.mode] || ''}  ${new Date().toLocaleDateString('ja-JP')}`, 30, 700, '#46556f', { align: 'center' });
  y += 12;

  // ほし・スコア
  if (draw) {
    ctx.font = `900 96px ${FONT}`;
    ctx.textAlign = 'center';
    const n = Math.max(1, Math.min(5, Math.round(result.stars) || 1));
    const startX = W / 2 - (5 * 110) / 2 + 55;
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < n ? '#ffb300' : '#d5dbe6';
      ctx.fillText('★', startX + i * 110, y + 90);
    }
  }
  y += 120;
  text(`${Math.round(result.score)} てん`, 84, 900, '#0c3f9a', { align: 'center' });
  text(feedback.headline, 38, 900, '#1d2b44', { align: 'center' });
  y += 20;

  if (feedback.praise && feedback.praise.length) {
    block('#f2fff6', '#9be0b4', () => {
      text('🌟 よかったところ', 38, 900, '#136d3a');
      for (const p of feedback.praise) text('・' + p, 32, 700, '#1d2b44');
    });
  }
  if (feedback.tips && feedback.tips.length) {
    block('#fff9f1', '#ffcf9e', () => {
      text('💪 もっと よくなる ポイント', 38, 900, '#c24f00');
      for (const t of feedback.tips) {
        text(t.title, 34, 900, '#1d2b44');
        text(t.text, 30, 600, '#1d2b44');
        if (t.drill) text('🏃 ' + t.drill, 30, 700, '#7a5200');
        y += 8;
      }
    });
  }
  if (feedback.nextGoal) {
    block('#eef4ff', '#a9c6ff', () => {
      text('🎯 つぎの もくひょう', 38, 900, '#0c3f9a');
      text(feedback.nextGoal, 32, 800, '#1d2b44');
    });
  }

  // キーモーメントのサムネ
  const thumbs = state.thumbs.filter((t) => t.canvas.width > 0).slice(0, 4);
  if (thumbs.length) {
    const gap = 16;
    const tw = Math.floor((inner - gap * (thumbs.length - 1)) / thumbs.length);
    let maxH = 0;
    for (const t of thumbs) maxH = Math.max(maxH, Math.round(tw * (t.canvas.height / t.canvas.width)));
    maxH = Math.min(maxH, 360);
    if (draw) {
      thumbs.forEach((t, i) => {
        const x = pad + i * (tw + gap);
        const ratio = t.canvas.width / t.canvas.height;
        let dw = tw, dh = tw / ratio;
        if (dh > maxH) { dh = maxH; dw = dh * ratio; }
        ctx.save();
        roundRect(ctx, x, y, tw, maxH, 18);
        ctx.clip();
        ctx.fillStyle = '#0d1b2e';
        ctx.fillRect(x, y, tw, maxH);
        ctx.drawImage(t.canvas, x + (tw - dw) / 2, y + (maxH - dh) / 2, dw, dh);
        ctx.restore();
        ctx.font = `800 26px ${FONT}`;
        ctx.fillStyle = '#1d2b44';
        ctx.textAlign = 'center';
        ctx.fillText(t.moment.label, x + tw / 2, y + maxH + 34);
      });
    }
    y += maxH + 84;
  }

  text('どうがは この たんまつの 中だけで しょりされました', 26, 700, '#46556f', { align: 'center' });
  y += 24;
  return y;
}

function saveResultCard() {
  if (!state.result || !state.feedback) return;
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1000;
  const h = drawResultCard(canvas, state.result, state.feedback, false);
  canvas.height = Math.ceil(h);
  drawResultCard(canvas, state.result, state.feedback, true);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `form-check-${state.result.mode}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
}

// ---------------------------------------------------------------- cleanup
function cleanupAll() {
  state.run++;               // 進行中の解析を止める
  state.cancelled = true;
  stopCheers();
  stopCamera();
  releaseVideoAndData();
  releaseClip();
}

function releaseVideoAndData() {
  const v = $('analyze-video');
  try { v.pause(); } catch (_) { /* ignore */ }
  v.removeAttribute('src');
  v.load();
  state.video = null;
  state.frames = [];
  state.meta = null;
  state.result = null;
  state.feedback = null;
  state.thumbs = [];
  viewerPending = null;
  state.lock = Promise.resolve();
}

// ---------------------------------------------------------------- wiring
function init() {
  setupHome();

  $('btn-input-back').addEventListener('click', goHome);
  $('file-input').addEventListener('change', onFilePicked);
  $('file-capture').addEventListener('change', onFilePicked);
  $('btn-camera').addEventListener('click', startCamera);
  $('btn-record').addEventListener('click', onRecordClick);
  $('btn-camera-cancel').addEventListener('click', () => { stopCamera(); showInputPanel('choose'); });
  $('btn-retake').addEventListener('click', () => { releaseClip(); setInputError(''); showInputPanel('choose'); });
  $('btn-analyze').addEventListener('click', runAnalysis);
  $('btn-analyze-cancel').addEventListener('click', () => {
    state.cancelled = true;
    state.run++;
    stopCheers();
    showInputPanel(state.clip ? 'review' : 'choose');
    showScreen('input');
  });

  $('btn-fail-retry').addEventListener('click', () => {
    if (state.failAction === 'analyze' && state.clip) { runAnalysis(); return; }
    releaseVideoAndData();
    releaseClip();
    openInput(state.mode);
  });
  $('btn-fail-home').addEventListener('click', goHome);

  $('btn-again').addEventListener('click', () => openInput(state.mode));
  $('btn-home').addEventListener('click', goHome);
  $('btn-save').addEventListener('click', saveResultCard);
  $('btn-viewer-close').addEventListener('click', closeViewer);
  $('viewer-slider').addEventListener('input', (e) => showViewerAt(Number(e.target.value)));

  // 画面を とじるとき カメラを とめる
  window.addEventListener('pagehide', cleanupAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.stream && !(state.recorder && state.recorder.state === 'recording')) {
      stopCamera();
      showInputPanel('choose');
    }
  });

  showScreen('home');
}

init();

// analyze.js — 投球 / 打撃フォームのメトリクスを計算する (DOM なし・純粋関数)
//
// 契約 (docs/ARCHITECTURE.md):
//   export function analyze(mode, frames, meta) // mode: 'pitch' | 'bat' -> AnalysisResult
//
// 座標の扱い:
//   - 2D: landmark.x を (width/height) 倍して「画面の高さ」を 1 とする単位にそろえる (縦横比の補正)。
//   - 長さは「身長」(鼻〜足首を体のパーツの長さの合計で近似) で割って、撮影距離に左右されないようにする。
//   - 回転・角度は world landmarks (3D, 腰中心, メートル) を優先し、無ければ 2D で近似する。

const LM = {
  nose: 0,
  lSh: 11,
  rSh: 12,
  lEl: 13,
  rEl: 14,
  lWr: 15,
  rWr: 16,
  lHip: 23,
  rHip: 24,
  lKn: 25,
  rKn: 26,
  lAn: 27,
  rAn: 28,
};
const USED = Object.values(LM);
const BODY_CHECK = [LM.lSh, LM.rSh, LM.lHip, LM.rHip, LM.lAn, LM.rAn];

const RATING_POINTS = { good: 100, ok: 72, try: 45 };
const RAD = 180 / Math.PI;

// ---------------------------------------------------------------- 小さな道具

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (v) => Math.round(v * 10) / 10;

function median(arr) {
  const a = arr.filter(isNum).sort((p, q) => p - q);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function quantile(arr, q) {
  const a = arr.filter(isNum).sort((p, r) => p - r);
  if (!a.length) return NaN;
  const pos = clamp(q, 0, 1) * (a.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function wrapDeg(d) {
  let x = ((d + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

// 3 点メディアン (外れ値つぶし) → 欠損の線形補間 (短い穴のみ) → 3 点平均
function smoothSeries(src, maxGap = 3) {
  const n = src.length;
  const med = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!isNum(src[i])) {
      med[i] = NaN;
      continue;
    }
    const w = [src[i - 1], src[i], src[i + 1]].filter(isNum);
    med[i] = w.length === 3 ? median(w) : src[i];
  }
  // 短い穴を埋める
  let i = 0;
  while (i < n) {
    if (isNum(med[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && !isNum(med[j])) j++;
    const gap = j - i;
    if (i > 0 && j < n && gap <= maxGap) {
      const a = med[i - 1];
      const b = med[j];
      for (let k = i; k < j; k++) med[k] = a + ((b - a) * (k - i + 1)) / (gap + 1);
    }
    i = j;
  }
  // 4 フレームより短い「とびとびの検出」は ノイズなので すてる (うしろ向きの時など)
  i = 0;
  while (i < n) {
    if (!isNum(med[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && isNum(med[j])) j++;
    if (j - i < 4 && n >= 8) for (let k = i; k < j; k++) med[k] = NaN;
    i = j;
  }
  // 速い動き (スイング・リリース) の山を つぶしすぎないよう 1:2:1 の軽い平均にする
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    if (!isNum(med[k])) {
      out[k] = NaN;
      continue;
    }
    let s = 2 * med[k];
    let c = 2;
    if (isNum(med[k - 1])) {
      s += med[k - 1];
      c++;
    }
    if (isNum(med[k + 1])) {
      s += med[k + 1];
      c++;
    }
    out[k] = s / c;
  }
  return out;
}

// ---------------------------------------------------------------- 前処理

function prepare(frames, meta, opts = {}) {
  const list = (Array.isArray(frames) ? frames : [])
    .filter((f) => f && isNum(f.t))
    .slice()
    .sort((a, b) => a.t - b.t);
  const n = list.length;
  const width = meta && isNum(meta.width) && meta.width > 0 ? meta.width : 0;
  const height = meta && isNum(meta.height) && meta.height > 0 ? meta.height : 0;
  const aspect = width && height ? width / height : 1;
  const t = list.map((f) => f.t);

  const raw = {};
  for (const idx of USED) raw[idx] = { x: new Array(n), y: new Array(n) };
  const world = new Array(n);
  let visibleFrames = 0;
  let poseFrames = 0;

  for (let i = 0; i < n; i++) {
    const lm = Array.isArray(list[i].landmarks) && list[i].landmarks.length >= 33 ? list[i].landmarks : null;
    const wl = Array.isArray(list[i].world) && list[i].world.length >= 33 ? list[i].world : null;
    world[i] = null;
    if (lm) {
      poseFrames++;
      if (BODY_CHECK.every((k) => lm[k] && (lm[k].visibility ?? 1) > 0.5)) visibleFrames++;
    }
    for (const idx of USED) {
      const p = lm && lm[idx];
      const vis = p ? (isNum(p.visibility) ? p.visibility : 1) : 0;
      // 手首・ひじは隠れやすいので少しゆるめにする
      const minVis = idx === LM.lWr || idx === LM.rWr || idx === LM.lEl || idx === LM.rEl ? 0.2 : 0.3;
      if (p && isNum(p.x) && isNum(p.y) && vis >= minVis) {
        raw[idx].x[i] = p.x * aspect;
        raw[idx].y[i] = p.y;
      } else {
        raw[idx].x[i] = NaN;
        raw[idx].y[i] = NaN;
      }
    }
    if (wl && lm) {
      const ok = [LM.lSh, LM.rSh, LM.lHip, LM.rHip].every(
        (k) => wl[k] && isNum(wl[k].x) && isNum(wl[k].y) && isNum(wl[k].z),
      );
      if (ok) world[i] = wl;
    }
  }

  // 生の値で だいたいの身長を出しておく (うでの重なり判定に使う)
  const rawCtx = { n, P: raw };
  const roughH = bodyHeight(rawCtx);

  // 横から撮ると、見えない方のうでが 見えている方のうでに 重なって検出されることがある。
  // ひじ(または手首)が ほぼ同じ場所にあるときは、visibility が低い方のうでを捨てる。
  if (opts.dedupeArms && isNum(roughH)) {
    for (let i = 0; i < n; i++) {
      const lm = list[i].landmarks;
      if (!Array.isArray(lm) || lm.length < 33) continue;
      const near = (a, b, lim) =>
        isNum(raw[a].x[i]) && isNum(raw[b].x[i]) &&
        Math.hypot(raw[a].x[i] - raw[b].x[i], raw[a].y[i] - raw[b].y[i]) < lim * roughH;
      if (near(LM.lEl, LM.rEl, 0.1) || near(LM.lWr, LM.rWr, 0.06)) {
        const vl = (lm[LM.lEl].visibility ?? 0) + (lm[LM.lWr].visibility ?? 0);
        const vr = (lm[LM.rEl].visibility ?? 0) + (lm[LM.rWr].visibility ?? 0);
        if (Math.abs(vl - vr) < 0.1) continue;
        const drop = vl < vr ? [LM.lEl, LM.lWr] : [LM.rEl, LM.rWr];
        for (const k of drop) {
          raw[k].x[i] = NaN;
          raw[k].y[i] = NaN;
        }
      }
    }
  }

  const P = {};
  for (const idx of USED) P[idx] = { x: smoothSeries(raw[idx].x), y: smoothSeries(raw[idx].y) };

  const ctx = { n, t, P, world, aspect, visibleFrames, poseFrames };

  ctx.H = bodyHeight(ctx);

  // 3D 版の身長 (world 座標)
  const hw = [];
  for (let i = 0; i < n; i++) {
    const w = world[i];
    if (!w) continue;
    const s = midW(w, LM.lSh, LM.rSh);
    const h = midW(w, LM.lHip, LM.rHip);
    const legL = dist3(w[LM.lHip], w[LM.lKn]) + dist3(w[LM.lKn], w[LM.lAn]);
    const legR = dist3(w[LM.rHip], w[LM.rKn]) + dist3(w[LM.rKn], w[LM.rAn]);
    const v = dist3(w[LM.nose], s) + dist3(s, h) + Math.max(legL, legR);
    if (isNum(v)) hw.push(v);
  }
  ctx.HW = quantile(hw, 0.75);

  return ctx;
}

// 身長 (鼻〜足首) をパーツの長さの合計で近似する (2D, 画面の高さ = 1)
function bodyHeight(ctx) {
  const { n } = ctx;
  const hs = [];
  for (let i = 0; i < n; i++) {
    const nose = pt(ctx, LM.nose, i);
    const sh = mid(ctx, LM.lSh, LM.rSh, i);
    const hip = mid(ctx, LM.lHip, LM.rHip, i);
    if (!nose || !sh || !hip) continue;
    const legs = [];
    for (const [h, k, a] of [
      [LM.lHip, LM.lKn, LM.lAn],
      [LM.rHip, LM.rKn, LM.rAn],
    ]) {
      const ph = pt(ctx, h, i);
      const pk = pt(ctx, k, i);
      const pa = pt(ctx, a, i);
      if (ph && pk && pa) legs.push(dist(ph, pk) + dist(pk, pa));
    }
    if (!legs.length) continue;
    const leg = Math.max(...legs); // 手前に縮んで見える足より長い方を使う
    hs.push(dist(nose, sh) + dist(sh, hip) + leg);
  }
  const H = quantile(hs, 0.75);
  return isNum(H) && H > 0.01 ? H : NaN;
}

function pt(ctx, idx, i) {
  if (i < 0 || i >= ctx.n) return null;
  const x = ctx.P[idx].x[i];
  const y = ctx.P[idx].y[i];
  return isNum(x) && isNum(y) ? { x, y } : null;
}
function mid(ctx, a, b, i) {
  const p = pt(ctx, a, i);
  const q = pt(ctx, b, i);
  if (p && q) return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  return null;
}
function dist(p, q) {
  return Math.hypot(p.x - q.x, p.y - q.y);
}
function dist3(p, q) {
  if (!p || !q) return NaN;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}
function midW(w, a, b) {
  return { x: (w[a].x + w[b].x) / 2, y: (w[a].y + w[b].y) / 2, z: (w[a].z + w[b].z) / 2 };
}

// 速さ (身長/秒)
function speedSeries(ctx, getPoint) {
  const { n, t, H } = ctx;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const a = getPoint(Math.max(0, i - 1));
    const b = getPoint(Math.min(n - 1, i + 1));
    const dt = (t[Math.min(n - 1, i + 1)] - t[Math.max(0, i - 1)]) / 1000;
    if (a && b && dt > 0) out[i] = dist(a, b) / H / dt;
  }
  return out;
}

function argBest(arr, from, to, better) {
  let best = -1;
  for (let i = Math.max(0, from); i <= Math.min(arr.length - 1, to); i++) {
    if (!isNum(arr[i])) continue;
    if (best < 0 || better(arr[i], arr[best])) best = i;
  }
  return best;
}
const argMax = (arr, from, to) => argBest(arr, from, to, (a, b) => a > b);
const argMin = (arr, from, to) => argBest(arr, from, to, (a, b) => a < b);

function indexAtTime(ctx, ms) {
  const { t, n } = ctx;
  if (!n) return 0;
  if (ms <= t[0]) return 0;
  if (ms >= t[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (t[m] <= ms) lo = m;
    else hi = m;
  }
  return ms - t[lo] <= t[hi] - ms ? lo : hi;
}

// 腰・肩の向き (上から見た角度, world 座標)
function yawW(w, a, b) {
  return Math.atan2(w[a].z - w[b].z, w[a].x - w[b].x) * RAD;
}

// 体幹の傾き (鉛直からの角度)
function trunkTilt(ctx, i) {
  const w = ctx.world[i];
  if (w) {
    const s = midW(w, LM.lSh, LM.rSh);
    const h = midW(w, LM.lHip, LM.rHip);
    const v = { x: s.x - h.x, y: s.y - h.y, z: s.z - h.z };
    const len = Math.hypot(v.x, v.y, v.z);
    if (len > 0) return Math.acos(clamp(-v.y / len, -1, 1)) * RAD;
  }
  const s = mid(ctx, LM.lSh, LM.rSh, i);
  const h = mid(ctx, LM.lHip, LM.rHip, i);
  if (!s || !h) return NaN;
  return Math.atan2(Math.abs(s.x - h.x), h.y - s.y) * RAD;
}

// ---------------------------------------------------------------- 評価

function rateHigher(value, good, ok) {
  if (!isNum(value)) return null;
  return value >= good ? 'good' : value >= ok ? 'ok' : 'try';
}
function rateLower(value, good, ok) {
  if (!isNum(value)) return null;
  return value <= good ? 'good' : value <= ok ? 'ok' : 'try';
}
function rateRange(value, goodLo, goodHi, okLo, okHi) {
  if (!isNum(value)) return null;
  if (value >= goodLo && value <= goodHi) return 'good';
  if (value >= okLo && value <= okHi) return 'ok';
  return 'try';
}

function metric(id, label, value, unit, rating, detail, weight = 1) {
  if (!rating || !isNum(value)) return null;
  return { id, label, value: round1(value), unit, rating, detail, weight };
}

function finish(mode, handedness, keyMoments, metricsRaw) {
  const metrics = metricsRaw.filter(Boolean);
  if (!metrics.length) {
    return fail(mode, 'うごきが よく みえなかったよ。からだ ぜんぶが うつるように とってみてね');
  }
  let sum = 0;
  let wsum = 0;
  for (const m of metrics) {
    sum += RATING_POINTS[m.rating] * m.weight;
    wsum += m.weight;
  }
  const score = clamp(Math.round(sum / wsum), 0, 100);
  const stars = score >= 88 ? 5 : score >= 75 ? 4 : score >= 62 ? 3 : score >= 50 ? 2 : 1;
  return {
    mode,
    ok: true,
    handedness,
    score,
    stars,
    keyMoments: keyMoments.filter(Boolean).sort((a, b) => a.t - b.t),
    metrics: metrics.map(({ weight, ...m }) => m),
  };
}

function fail(mode, reason) {
  return {
    mode: mode === 'bat' ? 'bat' : 'pitch',
    ok: false,
    reason,
    handedness: 'unknown',
    score: 0,
    stars: 1,
    keyMoments: [],
    metrics: [],
  };
}

function km(ctx, id, label, i) {
  if (!(i >= 0 && i < ctx.n)) return null;
  return { id, label, t: Math.round(ctx.t[i]) };
}

// ---------------------------------------------------------------- 入口

export function analyze(mode, frames, meta = {}) {
  const m = mode === 'bat' ? 'bat' : 'pitch';
  try {
    const ctx = prepare(frames, meta, { dedupeArms: m === 'pitch' });
    if (ctx.n < 8 || ctx.poseFrames < 8) {
      return fail(m, 'どうがが みじかいか、からだが みつからなかったよ。もういちど とってみよう！');
    }
    if (ctx.visibleFrames / ctx.n < 0.6) {
      return fail(m, 'あたまから あしまで、からだ ぜんぶが うつるように とってみてね');
    }
    if (!isNum(ctx.H)) {
      return fail(m, 'からだが よく みえなかったよ。すこし はなれて とってみてね');
    }
    return m === 'bat' ? analyzeBat(ctx) : analyzePitch(ctx);
  } catch (err) {
    if (typeof console !== 'undefined') console.warn('[analyze] failed', err);
    return fail(m, 'うまく しらべられなかったよ。もういちど とってみよう！');
  }
}

// ---------------------------------------------------------------- 投球

function analyzePitch(ctx) {
  const { n, t, H } = ctx;
  const wristL = speedSeries(ctx, (i) => pt(ctx, LM.lWr, i));
  const wristR = speedSeries(ctx, (i) => pt(ctx, LM.rWr, i));
  const iL = argMax(wristL, 1, n - 2);
  const iR = argMax(wristR, 1, n - 2);
  const peakL = iL >= 0 ? wristL[iL] : 0;
  const peakR = iR >= 0 ? wristR[iR] : 0;
  if (Math.max(peakL, peakR) < 0.6) {
    return fail('pitch', 'なげる うごきが みつからなかったよ。なげる ところを ぜんぶ とってみてね');
  }
  const right = peakR >= peakL;
  const handedness = Math.max(peakL, peakR) / Math.max(1e-6, Math.min(peakL, peakR)) < 1.05 ? 'unknown' : right ? 'right' : 'left';
  const S = right
    ? { sh: LM.rSh, el: LM.rEl, wr: LM.rWr, hip: LM.rHip }
    : { sh: LM.lSh, el: LM.lEl, wr: LM.lWr, hip: LM.lHip };
  const F = right ? { kn: LM.lKn, an: LM.lAn, hip: LM.lHip } : { kn: LM.rKn, an: LM.rAn, hip: LM.rHip };
  const B = right ? { an: LM.rAn } : { an: LM.lAn };
  // なげる向き: 横から撮っていれば 前足(グラブがわ)の方向。リリースは「前むきの速さ」が一番のところ。
  // (投げる前後だけを見る。投げたあと 歩いたり 向きを変えたりするので)
  const anchor = right ? iR : iL;
  let dirVotes = 0;
  const horiz = [];
  for (let i = indexAtTime(ctx, t[anchor] - 1500); i <= indexAtTime(ctx, t[anchor] + 300); i++) {
    const a = pt(ctx, F.an, i);
    const b = pt(ctx, B.an, i);
    if (!a || !b) continue;
    horiz.push(Math.abs(a.x - b.x) / H);
    if (Math.abs(a.x - b.x) > 0.2 * H) dirVotes += Math.sign(a.x - b.x);
  }
  const sideView = quantile(horiz, 0.9) > 0.3 && dirVotes !== 0;
  let release = right ? iR : iL;
  if (sideView) {
    const dir = Math.sign(dirVotes);
    const fwd = new Array(n).fill(NaN);
    for (let i = 1; i < n - 1; i++) {
      const a = pt(ctx, S.wr, i - 1);
      const b = pt(ctx, S.wr, i + 1);
      const dt = (t[i + 1] - t[i - 1]) / 1000;
      if (a && b && dt > 0) fwd[i] = ((b.x - a.x) * dir) / H / dt;
    }
    const iF = argMax(fwd, indexAtTime(ctx, t[anchor] - 1000), indexAtTime(ctx, t[anchor] + 500));
    if (iF >= 0 && fwd[iF] > 0.4) release = iF;
  }

  // --- 着地: リリース前 1.5 秒で、ふみだしが最大近くになった最初のフレーム
  const stride = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const a = pt(ctx, F.an, i);
    const b = pt(ctx, B.an, i);
    if (a && b) stride[i] = dist(a, b) / H;
  }
  const frontAnkleSpeed = speedSeries(ctx, (i) => pt(ctx, F.an, i));
  const wStart = indexAtTime(ctx, t[release] - 1500);
  const iMaxStride = argMax(stride, wStart, release);
  let landing = -1;
  if (iMaxStride >= 0) {
    const maxS = stride[iMaxStride];
    for (let i = wStart; i <= release; i++) {
      if (isNum(stride[i]) && stride[i] >= 0.9 * maxS && (!isNum(frontAnkleSpeed[i]) || frontAnkleSpeed[i] < 1.2)) {
        landing = i;
        break;
      }
    }
    if (landing < 0) landing = iMaxStride;
  }
  if (landing < 0) landing = Math.max(0, release - 3);

  // --- 足上げ: 着地より前で、前足のひざが一番高いところ
  const liftStart = indexAtTime(ctx, t[landing] - 2500);
  const kneePct = new Array(n).fill(NaN);
  let minStrideBefore = Infinity;
  for (let i = liftStart; i <= landing; i++) {
    const k = pt(ctx, F.kn, i);
    const hp = mid(ctx, LM.lHip, LM.rHip, i);
    const base = pt(ctx, B.an, i);
    if (k && hp && base && base.y - hp.y > 0.05 * H) kneePct[i] = ((base.y - k.y) / (base.y - hp.y)) * 100;
    if (isNum(stride[i])) minStrideBefore = Math.min(minStrideBefore, stride[i]);
  }
  const iLift = argMax(kneePct, liftStart, Math.max(liftStart, landing - 1));
  const liftVal = iLift >= 0 ? kneePct[iLift] : NaN;
  // 足上げが映っていない動画 (ふみだした後から始まる) では測らない
  const liftSeen = isNum(liftVal) && (liftVal >= 70 || minStrideBefore < 0.25) && iLift < landing;

  // --- リリース付近の値
  const relEnd = Math.min(n - 1, release + 1);

  // ひじの高さ: 着地のときの 肩→ひじ と 肩→こし の角度 (90° = 肩の高さ)
  const elbowAngleAt = (i) => {
    const w = ctx.world[i];
    if (w && w[S.el] && w[S.hip]) {
      const s = w[S.sh];
      const u = { x: w[S.el].x - s.x, y: w[S.el].y - s.y, z: w[S.el].z - s.z };
      const v = { x: w[S.hip].x - s.x, y: w[S.hip].y - s.y, z: w[S.hip].z - s.z };
      const d = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
      if (d > 0) return Math.acos(clamp((u.x * v.x + u.y * v.y + u.z * v.z) / d, -1, 1)) * RAD;
    }
    const s = pt(ctx, S.sh, i);
    const e = pt(ctx, S.el, i);
    const h = pt(ctx, S.hip, i);
    if (!s || !e || !h) return NaN;
    const a1 = Math.atan2(e.y - s.y, e.x - s.x);
    const a2 = Math.atan2(h.y - s.y, h.x - s.x);
    return Math.abs(wrapDeg((a1 - a2) * RAD));
  };
  const elbowVal = median([landing - 1, landing, landing + 1].filter((i) => i >= 0 && i <= release).map(elbowAngleAt));

  // 前傾: リリースの瞬間の体幹の傾き
  const leanVal = median([release, relEnd].map((i) => trunkTilt(ctx, i)));

  // ひねり: 着地〜リリースで、肩と腰の向きの差が一番大きいところ
  let twistVal = NaN;
  for (let i = Math.max(0, landing - 2); i <= relEnd; i++) {
    const w = ctx.world[i];
    if (!w) continue;
    const sep = Math.abs(wrapDeg(yawW(w, LM.lSh, LM.rSh) - yawW(w, LM.lHip, LM.rHip)));
    if (!isNum(twistVal) || sep > twistVal) twistVal = sep;
  }

  // フォロースルー: リリース後 1 秒で、投げた手が こし の高さまで おりてくるか
  const ftEnd = indexAtTime(ctx, t[release] + 1000);
  const ftPct = new Array(n).fill(NaN);
  for (let i = release; i <= ftEnd; i++) {
    const w = pt(ctx, S.wr, i);
    const s = mid(ctx, LM.lSh, LM.rSh, i);
    const h = mid(ctx, LM.lHip, LM.rHip, i);
    if (w && s && h && h.y - s.y > 0.05 * H) ftPct[i] = ((w.y - s.y) / (h.y - s.y)) * 100;
  }
  const iFollow = argMax(ftPct, release, ftEnd);
  // 動画が リリース直後で おわっている ときは 測らない
  const followVal = iFollow >= 0 && t[n - 1] - t[release] >= 300 ? ftPct[iFollow] : NaN;

  // 頭のブレ: 着地の少し前〜リリース後で、頭の通り道が まっすぐな線から どれだけ はずれたか
  const hs = indexAtTime(ctx, t[landing] - 200);
  const he = indexAtTime(ctx, t[release] + 150);
  const headVal = chordDeviation(ctx, LM.nose, hs, he) * 100;

  const strideVal = (() => {
    const i = argMax(stride, landing, release);
    return i >= 0 ? stride[i] * 100 : NaN;
  })();

  const metrics = [
    liftSeen
      ? metric(
          'legLift',
          'あしあげの たかさ',
          liftVal,
          '%',
          rateHigher(liftVal, 85, 65),
          'まえあしの ひざが こしの たかさ(100%)まで あがったかを みたよ',
        )
      : null,
    metric(
      'stride',
      'ふみだしの おおきさ',
      strideVal,
      '%',
      rateHigher(strideVal, 65, 45),
      'ちゃくちの ときの りょうあしの はば(しんちょうに たいする わりあい)だよ',
      1.2,
    ),
    metric(
      'elbowHeight',
      'ひじの たかさ',
      elbowVal,
      '°',
      rateRange(elbowVal, 75, 120, 60, 135),
      'あしが ついた ときの なげるうでの ひじの たかさ(90°で かたと おなじ)だよ',
      1.2,
    ),
    metric(
      'lean',
      'からだの まえたおし',
      leanVal,
      '°',
      rateRange(leanVal, 18, 60, 8, 70),
      'ボールを はなす ときに からだが まえに たおれているかを みたよ',
    ),
    metric(
      'twist',
      'からだの ひねり',
      twistVal,
      '°',
      rateHigher(twistVal, 25, 12),
      'こしと かたの むきの ちがい(ひねり)の おおきさだよ',
      0.8,
    ),
    metric(
      'followThrough',
      'フォロースルー',
      followVal,
      '%',
      rateHigher(followVal, 85, 55),
      'なげた あと、うでが こし(100%)まで ふりおろせたかを みたよ',
    ),
    metric(
      'headStill',
      'あたまの ブレ',
      headVal,
      '%',
      rateLower(headVal, 5, 10),
      'なげる あいだに あたまが どれだけ ゆれたかだよ(すくないほど いい)',
    ),
  ];

  const keyMoments = [
    liftSeen ? km(ctx, 'legLift', 'あしあげ', iLift) : null,
    km(ctx, 'landing', 'ちゃくち', landing),
    km(ctx, 'release', 'リリース', release),
    km(ctx, 'follow', 'フォロー', iFollow > release ? iFollow : Math.min(n - 1, indexAtTime(ctx, t[release] + 400))),
  ];

  return finish('pitch', handedness, keyMoments, metrics);
}

// 区間 [a, b] で、点の軌跡が始点と終点を結ぶ線から最大どれだけ離れたか (身長比)
function chordDeviation(ctx, idx, a, b) {
  const pts = [];
  for (let i = a; i <= b; i++) {
    const p = pt(ctx, idx, i);
    if (p) pts.push(p);
  }
  if (pts.length < 3) return NaN;
  const p0 = pts[0];
  const p1 = pts[pts.length - 1];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  let maxD = 0;
  for (const p of pts) {
    const d = len > 1e-6 ? Math.abs((p.x - p0.x) * dy - (p.y - p0.y) * dx) / len : dist(p, p0);
    if (d > maxD) maxD = d;
  }
  return maxD / ctx.H;
}

// ---------------------------------------------------------------- 打撃

function analyzeBat(ctx) {
  const { n, t, H } = ctx;
  const hands = (i) => {
    const a = pt(ctx, LM.lWr, i);
    const b = pt(ctx, LM.rWr, i);
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b;
  };
  const hipC = (i) => mid(ctx, LM.lHip, LM.rHip, i);
  const sp = speedSeries(ctx, hands);
  // スイングらしさ: 少し前に 手が かたの近くまで 上がっていて (トップ)、前後で 手が 大きく うごいている
  const swingScore = new Array(n).fill(NaN);
  for (let i = 1; i < n - 1; i++) {
    if (!isNum(sp[i])) continue;
    const a = hands(indexAtTime(ctx, t[i] - 300));
    const b = hands(indexAtTime(ctx, t[i] + 300));
    const travel = a && b ? dist(a, b) / H : 0;
    let high = false;
    for (let j = indexAtTime(ctx, t[i] - 1200); j <= i; j++) {
      const h = hands(j);
      const sh = mid(ctx, LM.lSh, LM.rSh, j);
      if (h && sh && h.y < sh.y + 0.12 * H) {
        high = true;
        break;
      }
    }
    swingScore[i] = sp[i] * Math.min(1, travel / 0.35) * (high ? 1 : 0.4);
  }
  let impact = argMax(swingScore, 1, n - 2);
  if (impact < 0) impact = argMax(sp, 1, n - 2);
  if (impact < 0 || sp[impact] < 0.5) {
    return fail('bat', 'スイングが みつからなかったよ。バットを ふる ところを ぜんぶ とってみてね');
  }
  const peak = sp[impact];

  // スイングの向き (インパクト前後の手の動き)
  const pa = hands(indexAtTime(ctx, t[impact] - 150)) || hands(impact);
  const pb = hands(indexAtTime(ctx, t[impact] + 150)) || hands(impact);
  let dx = pb.x - pa.x;
  let dy = pb.y - pa.y;
  const dl = Math.hypot(dx, dy) || 1;
  dx /= dl;
  dy /= dl;

  // トップ: インパクト前 1.2 秒で、手が一番うしろ(スイングと反対がわ)にあるところ
  const topFrom = indexAtTime(ctx, t[impact] - 1200);
  const proj = new Array(n).fill(NaN);
  for (let i = topFrom; i < impact; i++) {
    const h = hands(i);
    if (h) proj[i] = h.x * dx + h.y * dy;
  }
  let top = argMin(proj, topFrom, impact - 1);
  if (top >= 0) {
    // ほぼ同じくらい うしろなら、スイングを はじめる 直前 (いちばん あと) を トップにする
    const lim = proj[top] + 0.025 * H;
    for (let i = impact - 1; i > top; i--) {
      if (isNum(proj[i]) && proj[i] <= lim) {
        top = i;
        break;
      }
    }
  } else {
    top = Math.max(0, impact - 2);
  }

  // フィニッシュ: インパクト後、手の速さが落ちついたところ
  const finTo = indexAtTime(ctx, t[impact] + 1500);
  let fin = -1;
  for (let i = impact + 1; i <= finTo; i++) {
    if (t[i] - t[impact] < 200) continue;
    if (isNum(sp[i]) && sp[i] < 0.25 * peak) {
      fin = i;
      break;
    }
  }
  if (fin < 0) fin = Math.min(n - 1, indexAtTime(ctx, t[impact] + 600));

  // かまえ: トップより前で、いちばん じっとしているところ
  const kFrom = indexAtTime(ctx, t[top] - 3500);
  const kTo = Math.max(kFrom, indexAtTime(ctx, t[top] - 200));
  let kamae = top;
  if (kTo < top) {
    const hipSp = speedSeries(ctx, hipC);
    const anSp = speedSeries(ctx, (i) => mid(ctx, LM.lAn, LM.rAn, i));
    const still = new Array(n).fill(NaN);
    for (let i = kFrom; i <= kTo; i++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
        const v = (sp[j] || 0) + (hipSp[j] || 0) + 2 * (anSp[j] || 0);
        if (isNum(v)) {
          s += v;
          c++;
        }
      }
      if (c) still[i] = s / c;
    }
    // じっとしている フレームのうち いちばん はやいもの (足を上げる前の かまえ) をえらぶ
    const kMin = argMin(still, kFrom, kTo);
    if (kMin >= 0) {
      const lim = still[kMin] + 0.15;
      kamae = kMin;
      for (let i = kFrom; i <= kTo; i++) {
        if (isNum(still[i]) && still[i] <= lim) {
          kamae = i;
          break;
        }
      }
    }
  }

  // 利き手: トップ→フィニッシュで手が体の どちらがわへ 動いたか
  let handedness = 'unknown';
  {
    const wTop = ctx.world[top];
    const wFin = ctx.world[fin];
    let side = NaN;
    if (wTop && wFin) {
      const ax = { x: wTop[LM.lSh].x - wTop[LM.rSh].x, z: wTop[LM.lSh].z - wTop[LM.rSh].z };
      const hT = midW(wTop, LM.lWr, LM.rWr);
      const hF = midW(wFin, LM.lWr, LM.rWr);
      side = (hF.x - hT.x) * ax.x + (hF.z - hT.z) * ax.z;
    }
    if (!isNum(side) || Math.abs(side) < 1e-3) {
      const ls = pt(ctx, LM.lSh, top);
      const rs = pt(ctx, LM.rSh, top);
      const hT = hands(top);
      const hF = hands(fin);
      if (ls && rs && hT && hF) side = (hF.x - hT.x) * (ls.x - rs.x);
    }
    // 右打ちは 右かた の近くから 左がわへ ふりぬく
    if (isNum(side) && Math.abs(side) > 1e-4) handedness = side > 0 ? 'right' : 'left';
  }

  // --- メトリクス
  // かまえの足はば
  const stanceVal = (() => {
    const vals = [];
    for (let i = Math.max(0, kamae - 1); i <= Math.min(n - 1, kamae + 1); i++) {
      const a = pt(ctx, LM.lAn, i);
      const b = pt(ctx, LM.rAn, i);
      if (a && b) vals.push((dist(a, b) / H) * 100);
    }
    return median(vals);
  })();

  // 頭のブレ: トップ〜インパクトで 頭が どれだけ うごいたか
  const headVal = (() => {
    const p0 = pt(ctx, LM.nose, top);
    if (!p0) return NaN;
    let m = 0;
    for (let i = top; i <= impact; i++) {
      const p = pt(ctx, LM.nose, i);
      if (p) m = Math.max(m, dist(p, p0));
    }
    return (m / H) * 100;
  })();

  // 腰の回転: ためた ところ (トップ前 1 秒) と インパクト〜フィニッシュの 腰の向きの差 (world)
  const hipTurnVal = (() => {
    const pre = [];
    const post = [];
    for (let i = indexAtTime(ctx, t[top] - 1000); i <= top; i++) {
      if (ctx.world[i]) pre.push(yawW(ctx.world[i], LM.lHip, LM.rHip));
    }
    for (let i = impact; i <= Math.min(n - 1, fin + 3); i++) {
      if (ctx.world[i]) post.push(yawW(ctx.world[i], LM.lHip, LM.rHip));
    }
    let m = NaN;
    for (const y0 of pre) {
      for (const y1 of post) {
        const d = Math.abs(wrapDeg(y1 - y0));
        if (!isNum(m) || d > m) m = d;
      }
    }
    return m;
  })();

  // 体重移動: かまえ〜トップで いちばん うしろ(キャッチャーがわ)に こしが あったところから、
  //           インパクトまでに ピッチャーがわへ どれだけ うごいたか
  const shiftVal = (() => {
    const h1 = hipC(impact);
    const hT = hands(top);
    const hI = hands(impact);
    if (!h1 || !hT || !hI) return NaN;
    const dir = Math.sign(hI.x - hT.x) || Math.sign(dx) || 1;
    let back = NaN;
    for (let i = kamae; i <= top; i++) {
      const h = hipC(i);
      if (h && (!isNum(back) || h.x * dir < back)) back = h.x * dir;
    }
    if (!isNum(back)) return NaN;
    return ((h1.x * dir - back) / H) * 100;
  })();

  // トップの手の高さ: かたの高さを 0 として 上なら プラス (トップ前 0.6 秒で いちばん 高いところ)
  const handHVal = (() => {
    let best = NaN;
    for (let i = indexAtTime(ctx, t[top] - 600); i <= top; i++) {
      const h = hands(i);
      const s = mid(ctx, LM.lSh, LM.rSh, i);
      if (h && s) {
        const v = ((s.y - h.y) / H) * 100;
        if (!isNum(best) || v > best) best = v;
      }
    }
    return best;
  })();

  // フィニッシュのバランス: 体のかたむき
  const balanceVal = median(
    [fin, fin + 1, fin + 2].filter((i) => i < n).map((i) => trunkTilt(ctx, i)),
  );

  const metrics = [
    metric(
      'stanceWidth',
      'かまえの あしはば',
      stanceVal,
      '%',
      rateRange(stanceVal, 25, 65, 15, 80),
      'かまえた ときの りょうあしの はば(しんちょうに たいする わりあい)だよ',
    ),
    metric(
      'headStill',
      'あたまの うごき',
      headVal,
      '%',
      rateLower(headVal, 10, 18),
      'トップから インパクトまでに あたまが どれだけ うごいたかだよ(すくないほど いい)',
      1.2,
    ),
    metric(
      'hipTurn',
      'こしの かいてん',
      hipTurnVal,
      '°',
      rateHigher(hipTurnVal, 70, 40),
      'トップから フィニッシュまでに こしが どれだけ まわったかだよ',
      1.2,
    ),
    metric(
      'weightShift',
      'たいじゅう いどう',
      shiftVal,
      '%',
      rateRange(shiftVal, 3, 25, -2, 35),
      'ためた ところから インパクトまでに こしが まえに うごいたかを みたよ',
    ),
    metric(
      'handHeight',
      'トップの てのたかさ',
      handHVal,
      '%',
      rateRange(handHVal, -8, 40, -18, 55),
      'トップの ときの てが かたの たかさ(0%)より うえに あるかを みたよ',
    ),
    metric(
      'finishBalance',
      'フィニッシュの バランス',
      balanceVal,
      '°',
      rateLower(balanceVal, 25, 40),
      'ふりおわった ときに からだが まっすぐ たてているかを みたよ(かたむきが すくないほど いい)',
    ),
  ];

  const keyMoments = [
    km(ctx, 'stance', 'かまえ', kamae),
    km(ctx, 'top', 'トップ', top),
    km(ctx, 'impact', 'インパクト', impact),
    km(ctx, 'finish', 'フィニッシュ', fin),
  ];

  return finish('bat', handedness, keyMoments, metrics);
}

// テスト・調整用 (アプリからは使わない)
export const __internal = { prepare, speedSeries, pt, mid, LM };

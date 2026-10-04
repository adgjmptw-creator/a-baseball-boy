// 骨格オーバーレイ描画（MediaPipe Pose 33点）
// すべて端末内の canvas に描くだけ。どこにも送信しない。

// MediaPipe Pose の接続（ランドマーク番号のペア）
export const POSE_CONNECTIONS = [
  // 顔
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  // 肩・うで
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  // 体
  [11, 23], [12, 24], [23, 24],
  // あし
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

// 左右でいろ分け（左=オレンジ、右=みずいろ、まんなか=きいろ）
const COLORS = {
  left: '#ff9f1c',
  right: '#22c1e8',
  center: '#ffe14d',
  outline: '#ffffff',
  joint: '#ff4d8d',
};

function sideOf(i) {
  if (i === 0) return 'center';
  if (i <= 10) return i % 2 === 1 ? 'left' : 'right'; // 1,3,5,7,9=左 / 2,4,6,8,10=右
  return i % 2 === 1 ? 'left' : 'right';              // 11,13,... = 左 / 12,14,... = 右
}

function connSide(a, b) {
  const sa = sideOf(a), sb = sideOf(b);
  if (sa === sb) return sa;
  return 'center';
}

/**
 * 骨格を描く。
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number,y:number,z?:number,visibility?:number}>|null} landmarks 0..1 正規化
 * @param {number} w canvas の幅(px)
 * @param {number} h canvas の高さ(px)
 * @param {{minVisibility?:number, lineWidth?:number, jointRadius?:number, alpha?:number}} [opts]
 */
export function drawSkeleton(ctx, landmarks, w, h, opts = {}) {
  if (!ctx || !landmarks || landmarks.length < 33) return;
  const minVis = opts.minVisibility ?? 0.35;
  const base = Math.min(w, h);
  const lw = opts.lineWidth ?? Math.max(3, base * 0.011);
  const jr = opts.jointRadius ?? Math.max(3.5, base * 0.0115);
  const alpha = opts.alpha ?? 1;

  const ok = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.visibility === undefined || p.visibility >= minVis);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 白ふちつきの線（背景がなんでも見えるように）
  for (const pass of [0, 1]) {
    for (const [a, b] of POSE_CONNECTIONS) {
      const pa = landmarks[a], pb = landmarks[b];
      if (!ok(pa) || !ok(pb)) continue;
      const face = a <= 10 && b <= 10;
      ctx.beginPath();
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
      if (pass === 0) {
        ctx.strokeStyle = COLORS.outline;
        ctx.lineWidth = (face ? lw * 0.6 : lw) + 3;
      } else {
        ctx.strokeStyle = COLORS[connSide(a, b)];
        ctx.lineWidth = face ? lw * 0.6 : lw;
      }
      ctx.stroke();
    }
  }

  // 関節（顔の細かい点はかざらない。鼻だけ大きめ）
  for (let i = 0; i < 33; i++) {
    const p = landmarks[i];
    if (!ok(p)) continue;
    if (i >= 1 && i <= 10) continue;
    const r = i === 0 ? jr * 1.5 : (i >= 17 && i <= 22) || i >= 29 ? jr * 0.7 : jr;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.joint;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.outline;
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * canvas を動画のたて横比にあわせる（長辺は maxSide まで）。
 * @returns {{w:number,h:number}}
 */
export function fitCanvasToVideo(canvas, video, maxSide = 720) {
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 360;
  const scale = Math.min(1, maxSide / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return { w, h };
}

/**
 * いまの動画フレームを canvas にえがき、骨格を重ねる。
 * canvas が動画サイズに合っていなければ自動でリサイズする。
 */
export function drawFrameWithSkeleton(canvas, video, landmarks, opts = {}) {
  const { w, h } = fitCanvasToVideo(canvas, video, opts.maxSide ?? 720);
  const ctx = canvas.getContext('2d');
  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch (_) {
    ctx.fillStyle = '#0d1b2e';
    ctx.fillRect(0, 0, w, h);
  }
  if (landmarks && opts.skeleton !== false) drawSkeleton(ctx, landmarks, w, h, opts);
  return ctx;
}

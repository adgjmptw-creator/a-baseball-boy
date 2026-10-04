// pose.js — MediaPipe Tasks Vision PoseLandmarker のうすいラッパー
//
// 契約 (docs/ARCHITECTURE.md):
//   export async function createPoseDetector({ onProgress } = {}) // -> detector
//   detector.detect(videoEl, timestampMs) // -> { landmarks: Landmark[33] | null, world: Landmark[33] | null }
//   detector.close()
//   Landmark = { x, y, z, visibility }  (x,y は 0..1 正規化、左上原点)
//
// 追加の情報 (任意で使ってよい):
//   detector.delegate  -> 'GPU' | 'CPU'  (実際に使われている実行方式)
//   onProgress(fraction: number 0..1, label: string)
//
// 動画や姿勢データはどこにも送信しない。CDN からライブラリとモデルを取得するだけ。

const TASKS_VERSION = '0.10.14';
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const BUNDLE_URL = `${CDN_BASE}/vision_bundle.mjs`;
const WASM_URL = `${CDN_BASE}/wasm`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';

let visionModulePromise = null;
let modelBufferPromise = null;

function report(onProgress, fraction, label) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(Math.max(0, Math.min(1, fraction)), label);
  } catch (_) {
    /* UI 側のエラーで解析を止めない */
  }
}

function loadVisionModule() {
  if (!visionModulePromise) {
    visionModulePromise = import(/* @vite-ignore */ BUNDLE_URL).catch((err) => {
      visionModulePromise = null;
      throw err;
    });
  }
  return visionModulePromise;
}

// モデルを自前で fetch して進捗を出す (約 5.5MB)。
async function fetchModel(onProgress) {
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model fetch failed: ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    const buf = new Uint8Array(await res.arrayBuffer());
    report(onProgress, 0.9, 'model');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    report(onProgress, 0.3 + 0.6 * (received / total), 'model');
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function loadModel(onProgress) {
  if (!modelBufferPromise) {
    modelBufferPromise = fetchModel(onProgress).catch((err) => {
      modelBufferPromise = null;
      throw err;
    });
  }
  return modelBufferPromise;
}

function toPlain(list) {
  if (!list || !list.length) return null;
  const out = new Array(list.length);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    out[i] = {
      x: p.x,
      y: p.y,
      z: p.z,
      visibility: typeof p.visibility === 'number' ? p.visibility : 0,
    };
  }
  return out;
}

async function buildLandmarker(vision, fileset, modelBuffer, delegate) {
  return vision.PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      // createFromOptions がバッファを持っていく場合があるのでコピーを渡す
      modelAssetBuffer: modelBuffer.slice(),
      delegate,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
}

// 小さな画像で 1 回動かして、実行方式が本当に使えるか確かめる
function warmUp(landmarker, ts) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, 64, 64);
  }
  landmarker.detectForVideo(c, ts);
}

export async function createPoseDetector({ onProgress } = {}) {
  report(onProgress, 0, 'library');
  const vision = await loadVisionModule();
  report(onProgress, 0.15, 'wasm');
  const fileset = await vision.FilesetResolver.forVisionTasks(WASM_URL);
  report(onProgress, 0.3, 'model');
  const modelBuffer = await loadModel(onProgress);
  report(onProgress, 0.92, 'init');

  // 単調増加のタイムスタンプを管理する (detectForVideo の制約)
  let lastTs = -1;
  let offset = 0;
  const nextTs = (t) => {
    let ts = Math.round(Number.isFinite(t) ? t : lastTs + 1) + offset;
    if (ts <= lastTs) {
      // 別の動画を最初から処理するときなど: 間隔を保ったまま基準をずらす
      offset += lastTs + 1 - ts;
      ts = lastTs + 1;
    }
    lastTs = ts;
    return ts;
  };

  let landmarker = null;
  let delegate = 'GPU';
  try {
    landmarker = await buildLandmarker(vision, fileset, modelBuffer, 'GPU');
    warmUp(landmarker, nextTs(0));
  } catch (err) {
    try {
      landmarker && landmarker.close();
    } catch (_) {
      /* ignore */
    }
    landmarker = null;
  }
  if (!landmarker) {
    delegate = 'CPU';
    landmarker = await buildLandmarker(vision, fileset, modelBuffer, 'CPU');
  }
  report(onProgress, 1, 'ready');

  let closed = false;

  return {
    get delegate() {
      return delegate;
    },
    detect(videoEl, timestampMs) {
      if (closed || !landmarker || !videoEl) return { landmarks: null, world: null };
      // まだ絵が無い動画は飛ばす
      if (
        typeof HTMLVideoElement !== 'undefined' &&
        videoEl instanceof HTMLVideoElement &&
        (videoEl.readyState < 2 || !videoEl.videoWidth)
      ) {
        return { landmarks: null, world: null };
      }
      try {
        const res = landmarker.detectForVideo(videoEl, nextTs(timestampMs));
        return {
          landmarks: toPlain(res && res.landmarks && res.landmarks[0]),
          world: toPlain(res && res.worldLandmarks && res.worldLandmarks[0]),
        };
      } catch (err) {
        console.warn('[pose] detect failed', err);
        return { landmarks: null, world: null };
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        landmarker && landmarker.close();
      } catch (_) {
        /* ignore */
      }
      landmarker = null;
    },
  };
}

# a-baseball-boy — アーキテクチャ契約（開発者向け）

子ども向け「野球フォーム分析アプリ」。**完全クライアントサイド**（サーバー処理なし）、GitHub Pages で静的配信。
動画・姿勢データは端末外に送信しない。リポジトリに動画・画像・個人情報を含めない。

## 技術スタック
- 素の HTML / CSS / ES Modules（ビルド無し。`index.html` をそのまま Pages で配信）
- 姿勢推定: MediaPipe Tasks Vision `PoseLandmarker`（CDN から WASM とモデルをロード）
  - `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.x` の `vision_bundle.mjs`
  - モデル: `pose_landmarker_lite.task`（GCS 公開 URL、`runningMode: "VIDEO"`）
- 録画: `getUserMedia` + `MediaRecorder`（撮影した動画も端末内のみ）
- UI 言語: 日本語（小学生向け。漢字は少なめ、ひらがな多め、短い文）

## ディレクトリ
```
index.html          画面骨格（Sonnet）
css/style.css       子ども向けデザイン（Sonnet）
js/app.js           画面遷移・アップロード/撮影・解析進行・結果表示（Sonnet）
js/overlay.js       骨格オーバーレイ描画（Sonnet）
js/pose.js          PoseLandmarker ラッパー（Opus）
js/analyze.js       投球/打撃のメトリクス算出（Opus）
js/feedback.js      メトリクス→子ども向けアドバイス文（Opus）
docs/               設計・プライバシー説明（Haiku）
.github/workflows/  Pages デプロイ（Haiku）
```

## モジュール契約（必ず守る）

### `js/pose.js`
```js
export async function createPoseDetector({ onProgress } = {}) // returns detector
detector.detect(videoEl, timestampMs) // -> { landmarks: Landmark[33] | null, world: Landmark[33] | null }
detector.close()
// Landmark = { x, y, z, visibility }  (x,y は 0..1 正規化、左上原点)
```
`app.js` 側は動画を 0 秒から末尾まで `requestVideoFrameCallback` または `seek` で進めながら
`detect()` を呼び、`frames` 配列を作る。

### フレーム配列（app.js → analyze.js）
```js
frames: Array<{ t: number /* ms */, landmarks: Landmark[33] | null, world: Landmark[33] | null }>
meta:   { width: number, height: number, fps: number, durationMs: number }
```

### `js/analyze.js`
```js
export function analyze(mode, frames, meta) // mode: 'pitch' | 'bat'
// -> AnalysisResult
```
```ts
type Rating = 'good' | 'ok' | 'try';
interface Metric {
  id: string;            // e.g. 'stride', 'elbowHeight', 'headStill'
  label: string;         // 子ども向け名称 e.g. 'ふみだしの大きさ'
  value: number;         // 数値
  unit: string;          // '%' | '°' | 'cm' など（表示用）
  rating: Rating;
  detail: string;        // 1 文（何を測ったか）
}
interface KeyMoment { id: string; label: string; t: number /* ms */; }
interface AnalysisResult {
  mode: 'pitch' | 'bat';
  ok: boolean;            // false のとき reason を表示して終了
  reason?: string;        // 例: '体ぜんたいが うつるように さつえいしてね'
  handedness: 'right' | 'left' | 'unknown';
  score: number;          // 0..100
  stars: 1|2|3|4|5;
  keyMoments: KeyMoment[];// 投球: 足上げ/着地/リリース/フォロー, 打撃: かまえ/トップ/インパクト/フィニッシュ
  metrics: Metric[];
}
```

### `js/feedback.js`
```js
export function buildFeedback(result) // -> Feedback
```
```ts
interface Feedback {
  headline: string;      // 例: 'ナイスピッチ！ ひじが しっかり あがっているよ'
  praise: string[];      // 良かった点 1〜3 個（必ず 1 個以上）
  tips: Array<{ metricId: string; title: string; text: string; drill: string }>; // 直すと良い点 最大 2 個 + 練習法
  nextGoal: string;      // 次の目標 1 文
}
```

## 解析で見るポイント（Opus が実装）
### 投球（横から撮影が前提、正面でもクラッシュしない）
- 足上げの高さ（膝の高さ / 身長）
- ふみだし幅（着地時の両足首距離 / 身長）
- 着地時のひじの高さ（肩ラインに対して）
- リリース付近の体の前傾・胸の向き（肩と腰のひねり差）
- フォロースルーの大きさ（投げ腕が反対側の腰を越えるか）
- 頭のブレ（軌道の横ゆれ / 身長）
### 打撃（ティー/素振り/トス。縦横どちらでも）
- かまえの足幅（足首距離 / 身長）
- 頭のブレ（スイング中の頭の移動量）
- 腰の回転量（インパクト前後の腰の向き変化）
- 体重移動（腰中心の前後移動）
- 手の高さ（トップ時の手首高さ）
- フィニッシュのバランス（スイング後の体幹傾き・足の安定）

## UX 要件（Sonnet が実装）
1. ホーム: 「なげる」「うつ」の大きなボタン → 「どうがをえらぶ」「いまからさつえい」
2. 解析中: 進捗バー + 骨格が動くプレビュー（楽しさ）
3. 結果: ★評価、ほめポイント、アドバイス（最大 2 つ）+ 練習法、キーモーメントのサムネイル（動画の該当時刻にシーク）
4. 「どうがは このスマホの中だけで しょりされます」を目立つ位置に明記
5. スマホ縦画面を最優先、タップ領域は大きく、文字は 16px 以上
6. エラー時は怒らない表現（「もういちど とってみよう！」）

## 禁止事項
- 動画・画像・個人名・メールアドレス等を git 管理下に置かない
- 外部サーバーへ動画やランドマークを送信しない（CDN からのライブラリ取得のみ可）
- ビルドツールの導入（Pages でそのまま動くこと）

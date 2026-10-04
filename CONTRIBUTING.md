# 開発ガイド

**a-baseball-boy** の開発に参加してくださり、ありがとうございます！

## 原則

- ✅ **ビルド不要**: HTML・CSS・JavaScript をそのまま。webpack・Rollup などは使いません
- ✅ **モジュール契約を守る**: `docs/ARCHITECTURE.md` の関数シグネチャに従う
- ✅ **動画・画像・個人情報は git に入れない**: `.gitignore` で除外済み
- ✅ **ES Modules**: `import`/`export` を使い、ブラウザネイティブモジュールで動く
- ✅ **日本語・子ども向け**: 漢字は少なめ、ひらがな多め、短い表現

## コードの場所

| ファイル | 責任 | 連携先 |
|--------|-----|----|
| `index.html` | 画面構造 | `js/app.js`, `css/style.css` |
| `css/style.css` | 子ども向けデザイン | HTML |
| `js/app.js` | 画面遷移・UX・進行 | `js/pose.js`, `js/analyze.js` |
| `js/overlay.js` | 骨格オーバーレイ描画 | `js/app.js` で使用 |
| `js/pose.js` | MediaPipe ラッパー | `js/app.js` が呼ぶ |
| `js/analyze.js` | 投球/打撃メトリクス計算 | `js/feedback.js` が入力 |
| `js/feedback.js` | メトリクス→アドバイス文 | 結果表示 |
| `docs/ARCHITECTURE.md` | **モジュール契約** | **必読** |
| `docs/PRIVACY.md` | プライバシー説明 | 親向け |
| `README.md` | ユーザー向けドキュメント | 一般公開 |

## モジュール契約（重要）

#### `js/pose.js`
```javascript
export async function createPoseDetector({ onProgress } = {})
// → detector オブジェクト

detector.detect(videoElement, timestampMs)
// → { landmarks: Landmark[33] | null, world: Landmark[33] | null }

detector.close()

// Landmark = { x, y, z, visibility }
// x, y: 0..1 (0 = 左・上端, 1 = 右・下端)
```

#### `js/analyze.js`
```javascript
export function analyze(mode, frames, meta)
// mode: 'pitch' | 'bat'
// frames: Array<{ t: number, landmarks: Landmark[33] | null, world: Landmark[33] | null }>
// meta: { width, height, fps, durationMs }
// → AnalysisResult

interface AnalysisResult {
  mode: 'pitch' | 'bat',
  ok: boolean,
  reason?: string,            // ok=false なら理由
  handedness: 'right' | 'left' | 'unknown',
  score: number,              // 0..100
  stars: 1|2|3|4|5,
  keyMoments: KeyMoment[],    // 投球: 足上げ/着地/リリース/フォロー, 打撃: かまえ/トップ/インパクト/フィニッシュ
  metrics: Metric[]
}

interface Metric {
  id: string,         // 例: 'stride', 'elbowHeight', 'headStill'
  label: string,      // 子ども向け名 (例: 'ふみだしの大きさ')
  value: number,
  unit: string,       // '%' | '°' | 'cm' など
  rating: 'good' | 'ok' | 'try',
  detail: string      // 1 文
}
```

#### `js/feedback.js`
```javascript
export function buildFeedback(result)
// → Feedback

interface Feedback {
  headline: string,       // 例: 'ナイスピッチ！ ひじが しっかり あがっているよ'
  praise: string[],       // 良かった点 1～3 個（必須 1 個以上）
  tips: Array<{ metricId, title, text, drill }>,  // 最大 2 個 + 練習法
  nextGoal: string        // 次の目標 1 文
}
```

## テスト方法

```bash
# ローカルサーバー起動
python3 -m http.server 8000
# または
npx http-server

# http://localhost:8000 をブラウザで開く
```

⚠️ `file://` では ES Modules が動きません。必ず `http://` で開いてください。

## 貢献フロー

1. **Issue で相談**: 大きな変更は先に Issue を作って、思想をすり合わせてください
2. **Branch を作る**: `main` から新しいブランチを切る
3. **コミット**: わかりやすいコミットメッセージで
4. **PR を作る**: テスト方法と動作確認を記入してください
5. **レビュー**: コード確認後、マージ

## 禁止事項

### git に入れてはいけないもの
- ❌ `*.mp4`, `*.mov`, `*.webm` などの動画
- ❌ `*.jpg`, `*.png`, `*.heic` などの画像
- ❌ 名前・メールアドレス・電話番号などの個人情報
- ❌ 秘密鍵・API キー・`.env`

（`.gitignore` で除外済みですが、念のため）

### コード上の禁止
- ❌ **外部サーバーにデータを送らない** (Analytics・crash reporter・logging サービスなど)
- ❌ **個人用ライブラリの追加** (npm モジュール導入は避ける。必須の場合は先に Issue で相談)
- ❌ **ビルドステップの追加** (webpack・TypeScript コンパイルなど)
- ❌ **Safari・モバイル未対応コード** (テストしてから commit)

## デザインの約束

### UI 言語
- 対象: **小学生（6～12 才）**
- 漢字は少なめ → ひらがな多め
- 文は短く、1 文 15 字以下を目安
- 怒らない表現 (「エラー」より「もういちど とってみよう！」)

### レイアウト
- 📱 **モバイルファースト** (スマートフォン縦向き優先)
- タップ領域 48px 以上
- 文字サイズ 16px 以上
- ダークモード対応

## よくある質問（開発向け）

**Q: npm パッケージを追加したい**

A: 原則、避けてください。ビルドステップが必要になり、GitHub Pages で直接配信できなくなります。本当に必要なら、先に Issue で相談して、合意を取ってください。

**Q: TypeScript を使いたい**

A: ブラウザネイティブの JavaScript だけで。TypeScript コンパイルはビルドステップなので NG。

**Q: データを外部サーバーに送りたい**

A: **アーキテクチャに反します。NG です。**

---

ご質問・提案は Issue で。楽しい開発を！⚾️

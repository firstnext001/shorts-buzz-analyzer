# バズ解剖

YouTubeショートのURLを入れると、再生回数・高評価数・コメント数・登録者数などから「なぜバズったのか」を分析する、iPhone向けのWebアプリです。Safariで開いてホーム画面に追加すると、普通のアプリと同じように使えます。

## できること

| 分析 | 内容 |
|---|---|
| バズ度（0〜100） | 再生規模・登録者外への拡散・いつもとの差・反応の熱量・伸びの速さ の5観点を合成。平熱／微熱／発熱／高熱／沸騰 の5段階 |
| 数値 | 高評価率、コメント率、登録者比、チャンネルの普段のショートとの倍率、1日あたり再生、議論度、動画の長さ |
| バズの型 | アルゴリズム拡散型、一発ヒット型、共感・満足型、コメント誘発型、ループ再生型、急上昇中 など |
| AI分析（任意） | Claude がタイトル・説明文・上位コメント・サムネイルを読み、バズの理由・つかみ・視聴者の反応・真似できるポイントを解説 |

分析結果は端末内に30件まで履歴として残ります。

## 必要なもの

1. **YouTube Data API キー**（必須・無料）
   - [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
   - 「APIとサービス」→「ライブラリ」で **YouTube Data API v3** を有効化
   - 「認証情報」→「APIキーを作成」
   - 推奨: キーの制限で「APIの制限 = YouTube Data API v3」「ウェブサイトの制限 = 公開したURL（例: `https://firstnext001.github.io/*`）」を設定
   - 無料枠は1日10,000ユニット。1回の分析で約5ユニット使います
2. **Anthropic API キー**（AI分析を使う場合）
   - [Anthropic Console](https://console.anthropic.com/) でクレジットを購入し、API Keys からキーを作成
   - モデルは Claude Opus 5。1回あたりおよそ10〜20円です。コンソールで月の上限額を設定しておくと安心です

キーはアプリの設定画面で入力します。入力したキーはそのiPhoneの中（localStorage）にだけ保存され、YouTube（Google）と Anthropic 以外には送られません。コードやリポジトリには含まれません。

## 公開する（GitHub Pages）

iPhoneから使うにはインターネット上に置く必要があります。GitHub Pages を使う場合:

1. GitHub で新しいリポジトリを作成（例: `shorts-buzz-analyzer`）
2. このフォルダを push
   ```bash
   git init -b main
   git add .
   git commit -m "first commit"
   git remote add origin https://github.com/firstnext001/shorts-buzz-analyzer.git
   git push -u origin main
   ```
3. リポジトリの Settings → Pages → Source を **GitHub Actions** にする
4. 数分後、`https://firstnext001.github.io/shorts-buzz-analyzer/` で公開されます（以後は push するたびに自動更新）

## iPhoneで使う

1. Safariで公開URLを開く
2. 共有ボタン →「ホーム画面に追加」
3. アプリを開き、右上の歯車からAPIキーを設定
4. YouTubeアプリでショートの「共有」→「リンクをコピー」→ アプリの「貼り付け」で分析開始

### YouTubeの共有メニューから直接開く（任意）

「ショートカット」アプリで次のショートカットを作ると、YouTubeの共有メニューから1タップで分析できます。

1. 新規ショートカット →「i」→「共有シートに表示」をオン、受け取る種類を「URL」に
2. アクション「URLをエンコード」（入力: ショートカットの入力）
3. アクション「テキスト」に `https://firstnext001.github.io/shorts-buzz-analyzer/?url=` と入力し、末尾に「エンコードされたURL」を差し込む
4. アクション「URLを開く」（入力: テキスト）
5. 名前を「バズ解剖」にして保存

## 分析の限界

- YouTube APIでは再生数の推移・視聴維持率・流入元は取れません（これらはチャンネル所有者だけがYouTube Studioで見られます）。そのため「いつ伸びたか」「どこで離脱したか」は分かりません
- 「普段のショート」は、チャンネルの直近50本のうち3分以内の動画を使った推定です
- AIは動画本編を見られないため、映像の中身はサムネイル・タイトル・コメントからの推測です
- バズ度のしきい値はショート全体の一般的な目安で、ジャンルによって差があります

## 開発

```bash
npm install
npm run dev      # http://localhost:5173 （同じWi-FiのiPhoneからも http://PCのIP:5173 で確認可）
npm run build    # 型チェック + dist/ に出力
```

| ファイル | 役割 |
|---|---|
| `src/youtube.ts` | URLから動画IDを取り出し、YouTube Data API で動画・チャンネル・コメントを取得 |
| `src/metrics.ts` | 指標・バズ度・バズの型・数値からの所見を計算 |
| `src/ai.ts` | Claude API（ブラウザから直接呼び出し）でバズ理由を構造化JSONで生成 |
| `src/storage.ts` | 設定と履歴の保存 |
| `src/main.ts` | 画面の組み立て |

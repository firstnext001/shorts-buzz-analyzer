// Claude API でバズの理由を文章で分析する。
// iPhone のブラウザから直接呼ぶため dangerouslyAllowBrowser を有効にしている。
// APIキーはこの端末の localStorage にだけ保存され、他に送られるのは Anthropic のみ。

import Anthropic from "@anthropic-ai/sdk";
import type { Analysis } from "./metrics";
import { fmtAge } from "./metrics";
import type { FetchedData } from "./youtube";

export const MODEL = "claude-opus-5";

export interface AiReason {
  title: string;
  detail: string;
  evidence: string;
  confidence: "高" | "中" | "低";
}

export interface AiResult {
  verdict: string;
  summary: string;
  reasons: AiReason[];
  hook: string;
  audience: string;
  takeaways: string[];
  caveats: string;
}

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", description: "バズの理由を一言で（25文字以内）" },
    summary: { type: "string", description: "全体の結論（2〜3文）" },
    reasons: {
      type: "array",
      description: "バズの理由。影響が大きい順に3〜5個",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "理由の見出し（20文字以内）" },
          detail: { type: "string", description: "なぜそう言えるかの説明（2〜3文）" },
          evidence: { type: "string", description: "根拠にした数値・コメント・タイトルの要素" },
          confidence: { type: "string", enum: ["高", "中", "低"] },
        },
        required: ["title", "detail", "evidence", "confidence"],
        additionalProperties: false,
      },
    },
    hook: { type: "string", description: "冒頭のつかみ・企画の切り口についての推測" },
    audience: { type: "string", description: "コメントから読み取れる視聴者の反応・層" },
    takeaways: {
      type: "array",
      description: "自分の動画に活かせる具体的なポイント（3〜5個）",
      items: { type: "string" },
    },
    caveats: { type: "string", description: "この分析の限界や、データから断定できないこと" },
  },
  required: ["verdict", "summary", "reasons", "hook", "audience", "takeaways", "caveats"],
  additionalProperties: false,
};

export class AiError extends Error {}

function buildPrompt(d: FetchedData, a: Analysis): string {
  const r = a.raw;
  const pct = (x: number | null) => (x === null ? "不明" : `${(x * 100).toFixed(3)}%`);
  const data = {
    タイトル: d.video.title,
    説明文: d.video.description.slice(0, 1500),
    タグ: d.video.tags.slice(0, 30),
    チャンネル: d.channel.title,
    投稿日時_日本時間: r.publishedJst,
    投稿からの経過: fmtAge(r.ageHours),
    動画の長さ_秒: r.durationSec,
    再生回数: r.views,
    高評価数: r.likes ?? "非公開",
    コメント数: r.comments ?? "オフ",
    チャンネル登録者数: r.subscribers ?? "非公開",
    高評価率: pct(r.likeRate),
    コメント率: pct(r.commentRate),
    コメント数_対_高評価数: pct(r.commentPerLike),
    再生回数_対_登録者数: r.subsRatio === null ? "不明" : `${r.subsRatio.toFixed(2)}倍`,
    チャンネルの普段のショート再生中央値: r.baselineMedian ?? "データ不足",
    普段と比べた倍率: r.baselineMultiple === null ? "不明" : `${r.baselineMultiple.toFixed(2)}倍`,
    "1日あたり平均再生": Math.round(r.viewsPerDay),
    アプリのバズ度スコア: `${a.score}/100（${a.level.name}）`,
    スコア内訳: Object.fromEntries(a.parts.map((p) => [p.label, p.score ?? "データなし"])),
    数値から判定したバズの型: a.types.map((t) => t.name),
  };
  const comments = d.comments.length
    ? d.comments
        .slice(0, 30)
        .map((c, i) => `${i + 1}. [いいね${c.likes}] ${c.text.replace(/\s+/g, " ").slice(0, 200)}`)
        .join("\n")
    : d.commentsNote ?? "コメントなし";

  return `あなたはYouTubeショート動画の分析に詳しいマーケターです。
以下のショート動画が「なぜバズったのか（またはなぜ伸びていないのか）」を、日本語で分析してください。

分析の方針:
- 数値（高評価率・コメント率・登録者比・普段との倍率・経過時間・長さ）と、タイトル・説明文・タグ・上位コメント・サムネイル画像を根拠にする。
- 動画本編は見られない。映像の中身は、サムネイル・タイトル・コメントから推測できる範囲に留め、推測であることが伝わる書き方にする。
- 目安: ショートの高評価率は2〜4%が標準、5%以上で高い。コメント率は0.05〜0.15%が標準。再生回数が登録者数を大きく上回るほどフィードでの拡散が強い。
- スコアが低い場合は、無理にバズの理由を作らず「伸びていない理由・伸ばすには」の観点で書く。
- 一般論ではなく、この動画固有の要素（具体的な言葉・企画・コメントの内容）に触れる。

## 動画データ（JSON）
${JSON.stringify(data, null, 2)}

## 上位コメント（関連度順）
${comments}`;
}

export async function analyzeWithClaude(
  apiKey: string,
  d: FetchedData,
  a: Analysis,
  onProgress: (chars: number) => void,
): Promise<AiResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const prompt = buildPrompt(d, a);

  const run = async (withImage: boolean) => {
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    if (withImage && d.video.thumbnailUrl) {
      content.push({ type: "image", source: { type: "url", url: d.video.thumbnailUrl } });
    }
    content.push({ type: "text", text: prompt });

    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [{ role: "user", content }],
    });
    stream.on("text", (_delta, snapshot) => onProgress(snapshot.length));
    return stream.finalMessage();
  };

  let message: Anthropic.Beta.BetaMessage;
  try {
    try {
      message = await run(true);
    } catch (e) {
      // サムネイル画像が取得できない場合などは画像なしでやり直す
      if (e instanceof Anthropic.BadRequestError) message = await run(false);
      else throw e;
    }
  } catch (e) {
    throw new AiError(explainError(e));
  }

  if (message.stop_reason === "refusal") {
    throw new AiError("この動画の内容はAIが分析を控えました。数値分析の結果をご覧ください。");
  }
  if (message.stop_reason === "max_tokens") {
    throw new AiError("AIの回答が長くなりすぎて途中で終わりました。もう一度お試しください。");
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return JSON.parse(text) as AiResult;
  } catch {
    throw new AiError("AIの回答を読み取れませんでした。もう一度お試しください。");
  }
}

function explainError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic APIキーが正しくありません。設定を確認してください。";
  if (e instanceof Anthropic.PermissionDeniedError) return "このAPIキーではClaudeを利用できません。Anthropicのコンソールで権限を確認してください。";
  if (e instanceof Anthropic.RateLimitError) return "Claude APIの利用上限に達しました。少し待ってから再度お試しください。";
  if (e instanceof Anthropic.BadRequestError) {
    return `Claude APIへのリクエストが拒否されました。クレジット残高が不足していないか確認してください。（${e.message}）`;
  }
  if (e instanceof Anthropic.APIConnectionError) return "Claude APIに接続できませんでした。通信状態を確認してください。";
  if (e instanceof Anthropic.APIError) return `Claude APIエラー (${e.status ?? "?"})。時間をおいて再度お試しください。`;
  return "AI分析中に予期しないエラーが発生しました。";
}

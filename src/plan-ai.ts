// 自分の動画（切り出した場面）＋参考のバズ動画 から、タイトル・テロップなどを Claude に提案させる。

import type Anthropic from "@anthropic-ai/sdk";
import { callClaudeJson } from "./ai";
import type { FrameSet } from "./frames";
import { fmtCount, fmtPct, fmtTimes } from "./metrics";
import type { HistoryEntry } from "./storage";
import { segmentsToText, type Segment } from "./transcribe";

export type TelopStyle = "フック" | "強調" | "ツッコミ" | "説明" | "オチ";

export interface Telop {
  start: number;
  end: number;
  text: string;
  style: TelopStyle;
  position: "上" | "中央" | "下";
  note: string;
}

export interface PlanResult {
  concept: string;
  titles: { text: string; aim: string }[];
  hook: { telop: string; advice: string };
  telops: Telop[];
  cover: { time: number; text: string; reason: string };
  description: string;
  hashtags: string[];
  editing: string[];
  borrowed: string;
}

export interface PlanInput {
  frames: FrameSet;
  references: HistoryEntry[];
  channelProfile: string;
  notes: string;
  speech: { kind: "script"; text: string } | { kind: "transcript"; segments: Segment[] };
}

const str = (description: string) => ({ type: "string", description });

const SCHEMA = {
  type: "object",
  properties: {
    concept: str("この動画の勝ち筋を一言で（30文字以内）"),
    titles: {
      type: "array",
      description: "タイトル案を3〜5個。切り口を変える",
      items: {
        type: "object",
        properties: { text: str("タイトル"), aim: str("このタイトルの狙い（1文）") },
        required: ["text", "aim"],
        additionalProperties: false,
      },
    },
    hook: {
      type: "object",
      properties: {
        telop: str("冒頭0〜2秒に出すテロップ"),
        advice: str("冒頭のつかみを強くするための具体的な助言"),
      },
      required: ["telop", "advice"],
      additionalProperties: false,
    },
    telops: {
      type: "array",
      description: "動画全体のテロップ案。時刻順",
      items: {
        type: "object",
        properties: {
          start: { type: "number", description: "表示開始（秒）" },
          end: { type: "number", description: "表示終了（秒）" },
          text: str("テロップの文字。2行に分けるなら改行位置に「／」"),
          style: { type: "string", enum: ["フック", "強調", "ツッコミ", "説明", "オチ"] },
          position: { type: "string", enum: ["上", "中央", "下"] },
          note: str("演出メモ（文字の大きさ・色・効果音・出し方など）。なければ空文字"),
        },
        required: ["start", "end", "text", "style", "position", "note"],
        additionalProperties: false,
      },
    },
    cover: {
      type: "object",
      properties: {
        time: { type: "number", description: "カバー（サムネ）に使う場面の秒数" },
        text: str("カバーに入れる文字"),
        reason: str("その場面を選んだ理由"),
      },
      required: ["time", "text", "reason"],
      additionalProperties: false,
    },
    description: str("概要欄の文章（2〜3行）"),
    hashtags: { type: "array", description: "ハッシュタグ3〜6個（#付き）", items: { type: "string" } },
    editing: { type: "array", description: "編集の改善点（具体的に、2〜5個）", items: { type: "string" } },
    borrowed: str("参考動画のどのバズ要素を、この動画にどう取り入れたか"),
  },
  required: ["concept", "titles", "hook", "telops", "cover", "description", "hashtags", "editing", "borrowed"],
  additionalProperties: false,
};

function referenceSummary(e: HistoryEntry, i: number): string {
  const r = e.analysis.raw;
  const summary = {
    番号: i + 1,
    タイトル: e.data.video.title,
    チャンネル: e.data.channel.title,
    長さ_秒: r.durationSec,
    再生回数: fmtCount(r.views),
    高評価率: r.likeRate === null ? "非公開" : fmtPct(r.likeRate),
    登録者比: r.subsRatio === null ? "不明" : fmtTimes(r.subsRatio),
    バズ度: `${e.analysis.score}/100（${e.analysis.level.name}）`,
    バズの型: e.analysis.types.map((t) => t.name),
    タグ: e.data.video.tags.slice(0, 15),
    説明文: e.data.video.description.slice(0, 300),
    AI分析: e.ai
      ? {
          一言: e.ai.verdict,
          理由: e.ai.reasons.map((x) => `${x.title}：${x.detail}`),
          つかみ: e.ai.hook,
          活かせるポイント: e.ai.takeaways,
        }
      : "なし",
    上位コメント: e.data.comments.slice(0, 6).map((c) => c.text.replace(/\s+/g, " ").slice(0, 100)),
  };
  return JSON.stringify(summary, null, 1);
}

function speechSection(s: PlanInput["speech"]): string {
  if (s.kind === "transcript") {
    return s.segments.length
      ? `自動文字起こしの結果（秒数は実際の発言タイミング。聞き間違いを含む可能性あり）:\n${segmentsToText(s.segments)}`
      : "自動文字起こしでは発言が検出されませんでした（話し声のない動画の可能性）。";
  }
  return s.text.trim()
    ? `投稿者が貼り付けた台本・話す内容（秒数は含まれないので、場面の画像から時刻を推定する）:\n${s.text.trim().slice(0, 4000)}`
    : "なし（話し声のない動画、または未入力）。映像だけから判断する。";
}

function instructions(p: PlanInput): string {
  const d = p.frames.duration.toFixed(1);
  return `あなたはエンタメ・ネタ系のYouTubeショートを数多くバズらせてきた構成作家・編集者です。
これから投稿する「あなたの動画」について、参考のバズ動画の勝ちパターンを取り入れながら、タイトル・テロップ・概要欄などを提案してください。

## チャンネル情報
${p.channelProfile.trim() || "未設定"}

## 動画の狙い・補足（投稿者より）
${p.notes.trim() || "なし"}

## 話している内容
${speechSection(p.speech)}

## 動画の長さ
${d}秒

## 提案の方針
- 上の画像は「あなたの動画」から切り出した場面で、直前の [秒数] がその場面の時刻です。映像の流れ・表情・動き・すでに入っている文字を読み取ってください。
- 参考のバズ動画は、数値・AI分析・タイトルの型・コメントの反応から「なぜバズったか」を読み取り、この動画に合う要素だけを取り入れてください。タイトルや言い回しをそのまま真似しないこと。参考動画がない場合は、エンタメ系ショートの一般的な勝ちパターンで考えてください。
- テロップ:
  - 冒頭0〜2秒に、スワイプされずに続きを見たくなるフックを必ず入れる
  - 1枚あたり15文字程度まで。2行に分けるなら改行位置に「／」
  - 話し声がある場合は発言のタイミングに合わせ、強調したい言葉・ツッコミ・オチは別テロップで目立たせる
  - 画面下部と右側はYouTubeのボタンや説明文で隠れるので、基本は上〜中央に置く
  - start/end は小数1桁の秒で、0〜${d}秒の範囲に収め、時間が重ならないよう時刻順に並べる
  - 文字起こしの秒数がない場合は、場面の画像と台本から推定する
- タイトル: フィードで最初に目に入る前半に一番強い言葉を置く。20〜35文字程度。3〜5案、それぞれ切り口を変える
- カバー: 切り出した場面の秒数から、一番目を引く瞬間を選ぶ
- 概要欄は2〜3行、ハッシュタグは3〜6個
- 編集の改善点は、この動画の映像を見て気づいた具体的なもの（冗長な間、オチの位置、長さ、冒頭の絵など）
- 一般論ではなく、この動画の具体的な場面・言葉に触れて提案する`;
}

export function proposeWithClaude(apiKey: string, p: PlanInput, onProgress: (chars: number) => void): Promise<PlanResult> {
  return callClaudeJson<PlanResult>({
    apiKey,
    schema: SCHEMA,
    onProgress,
    refusalMessage: "この動画の内容はAIが提案を控えました。内容や補足を見直してください。",
    build: (withRemoteImages) => {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [
        { type: "text", text: `# あなたの動画から切り出した場面（${p.frames.frames.length}枚）` },
      ];
      for (const f of p.frames.frames) {
        content.push({ type: "text", text: `[${f.time.toFixed(1)}秒]` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: f.base64 } });
      }
      if (p.references.length) {
        content.push({ type: "text", text: `# 参考にするバズ動画（${p.references.length}本）` });
        p.references.forEach((e, i) => {
          content.push({ type: "text", text: referenceSummary(e, i) });
          if (withRemoteImages && e.data.video.thumbnailUrl) {
            content.push({ type: "image", source: { type: "url", url: e.data.video.thumbnailUrl } });
          }
        });
      } else {
        content.push({ type: "text", text: "# 参考にするバズ動画\nなし" });
      }
      content.push({ type: "text", text: instructions(p) });
      return content;
    },
  });
}

// 取得した数値から指標・バズ度スコア・バズの型を計算する（AIを使わない数値分析）。
// しきい値はショート動画の一般的な目安で、ジャンルによって差があります。

import type { FetchedData } from "./youtube";

export type Grade = "low" | "avg" | "high" | "top" | "na";

export const GRADE_LABEL: Record<Grade, string> = {
  low: "控えめ",
  avg: "標準",
  high: "高い",
  top: "突出",
  na: "",
};

export interface Metric {
  label: string;
  value: string;
  sub: string;
  grade: Grade;
}

export interface BuzzType {
  name: string;
  desc: string;
}

export interface Level {
  name: string;
  desc: string;
}

export interface Raw {
  views: number;
  likes: number | null;
  comments: number | null;
  subscribers: number | null;
  likeRate: number | null;
  commentRate: number | null;
  commentPerLike: number | null;
  subsRatio: number | null;
  baselineMultiple: number | null;
  baselineMedian: number | null;
  viewsPerDay: number;
  ageHours: number;
  durationSec: number;
  publishedJst: string;
}

export interface Analysis {
  score: number;
  level: Level;
  parts: { label: string; score: number | null; weight: number }[];
  metrics: Metric[];
  types: BuzzType[];
  findings: string[];
  raw: Raw;
}

// ---------- 表示用フォーマット ----------

export function fmtCount(n: number): string {
  if (n >= 1e8) return `${trim(n / 1e8, n >= 1e9 ? 0 : 1)}億`;
  if (n >= 1e6) return `${Math.round(n / 1e4).toLocaleString("ja-JP")}万`;
  if (n >= 1e4) return `${trim(n / 1e4, 1)}万`;
  return Math.round(n).toLocaleString("ja-JP");
}

function trim(n: number, digits: number): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}

export function fmtPct(r: number): string {
  const p = r * 100;
  return `${p >= 10 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3)}%`;
}

export function fmtTimes(x: number): string {
  return `×${x >= 100 ? Math.round(x).toLocaleString("ja-JP") : x >= 10 ? x.toFixed(1) : x.toFixed(2)}`;
}

/** 文章中で使う「56倍」形式 */
function fmtBai(x: number): string {
  return `${x >= 10 ? Math.round(x).toLocaleString("ja-JP") : x.toFixed(1)}倍`;
}

export function fmtAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}分`;
  if (hours < 48) return `${Math.round(hours)}時間`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)}日`;
  if (days < 730) return `${Math.round(days / 30.4)}か月`;
  return `${trim(days / 365, 1)}年`;
}

const jstFormatter = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

// ---------- スコア計算 ----------

/** 折れ線補間。pts は x 昇順 */
function interp(x: number, pts: [number, number][]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

const log = (x: number) => Math.log10(Math.max(x, 1e-9));

function grade(x: number | null, [a, b, c]: [number, number, number]): Grade {
  if (x === null || !Number.isFinite(x)) return "na";
  return x < a ? "low" : x < b ? "avg" : x < c ? "high" : "top";
}

function levelOf(score: number): Level {
  if (score >= 85) return { name: "沸騰", desc: "大バズ。ショートフィードで爆発的に拡散しています" };
  if (score >= 70) return { name: "高熱", desc: "しっかりバズっています" };
  if (score >= 50) return { name: "発熱", desc: "じわじわ伸びている、小〜中規模のバズ" };
  if (score >= 30) return { name: "微熱", desc: "平均より少し伸びている程度" };
  return { name: "平熱", desc: "今のところバズとは言えない水準" };
}

export function analyze(d: FetchedData): Analysis {
  const { video: v, channel: c } = d;
  const ageHours = Math.max((Date.parse(d.fetchedAt) - Date.parse(v.publishedAt)) / 36e5, 1 / 60);
  const viewsPerDay = v.views / Math.max(ageHours / 24, 0.25);

  const likeRate = v.likes !== null && v.views > 0 ? v.likes / v.views : null;
  const commentRate = v.comments !== null && v.views > 0 ? v.comments / v.views : null;
  const commentPerLike = v.likes && v.comments !== null ? v.comments / v.likes : null;
  const subsRatio = c.subscribers ? v.views / c.subscribers : null;
  const baselineMedian = c.recentShortsSampleSize >= 3 ? c.recentShortsMedianViews : null;
  const baselineMultiple = baselineMedian ? v.views / baselineMedian : null;

  // 5つの観点を0〜100点にして重み付き平均（取れない指標は重みを除外）
  const engagement =
    likeRate === null && commentRate === null
      ? null
      : (() => {
          const l = likeRate === null ? null : interp(likeRate * 100, [[0, 0], [1, 10], [3, 40], [5, 65], [8, 90], [10, 100]]);
          const cm = commentRate === null ? null : interp(commentRate * 100, [[0, 0], [0.05, 20], [0.15, 50], [0.4, 85], [1, 100]]);
          if (l === null) return cm;
          if (cm === null) return l;
          return l * 0.7 + cm * 0.3;
        })();

  const parts = [
    { label: "再生規模", weight: 0.3, score: interp(log(v.views), [[3, 0], [4, 20], [5, 45], [6, 70], [7, 90], [8, 100]]) },
    { label: "登録者外への拡散", weight: 0.25, score: subsRatio === null ? null : interp(log(subsRatio), [[-2, 0], [-1, 10], [0, 40], [1, 75], [2, 100]]) },
    { label: "いつもとの差", weight: 0.2, score: baselineMultiple === null ? null : interp(log(baselineMultiple), [[-1, 0], [-0.3, 15], [0, 35], [0.477, 60], [1, 85], [1.477, 100]]) },
    { label: "反応の熱量", weight: 0.15, score: engagement },
    { label: "伸びの速さ", weight: 0.1, score: interp(log(viewsPerDay), [[2, 0], [3, 10], [4, 35], [5, 60], [6, 85], [7, 100]]) },
  ];
  const used = parts.filter((p) => p.score !== null);
  const totalWeight = used.reduce((s, p) => s + p.weight, 0);
  const score = Math.round(used.reduce((s, p) => s + (p.score as number) * p.weight, 0) / totalWeight);

  const raw: Raw = {
    views: v.views,
    likes: v.likes,
    comments: v.comments,
    subscribers: c.subscribers,
    likeRate,
    commentRate,
    commentPerLike,
    subsRatio,
    baselineMultiple,
    baselineMedian,
    viewsPerDay,
    ageHours,
    durationSec: v.durationSec,
    publishedJst: jstFormatter.format(new Date(v.publishedAt)),
  };

  return {
    score,
    level: levelOf(score),
    parts: parts.map((p) => ({ label: p.label, weight: p.weight, score: p.score === null ? null : Math.round(p.score) })),
    metrics: buildMetrics(raw, c.recentShortsSampleSize),
    types: buildTypes(raw, score),
    findings: buildFindings(raw, score),
    raw,
  };
}

function buildMetrics(r: Raw, sample: number): Metric[] {
  const na = "非公開";
  return [
    {
      label: "再生回数",
      value: `${fmtCount(r.views)}回`,
      sub: `投稿から${fmtAge(r.ageHours)}`,
      grade: grade(r.views, [1e4, 1e5, 1e6]),
    },
    {
      label: "高評価率",
      value: r.likeRate === null ? na : fmtPct(r.likeRate),
      sub: r.likes === null ? "高評価数 非公開" : `高評価 ${fmtCount(r.likes)}`,
      grade: grade(r.likeRate, [0.02, 0.04, 0.07]),
    },
    {
      label: "コメント率",
      value: r.commentRate === null ? "—" : fmtPct(r.commentRate),
      sub: r.comments === null ? "コメントオフ" : `コメント ${fmtCount(r.comments)}件`,
      grade: grade(r.commentRate, [0.0005, 0.0015, 0.004]),
    },
    {
      label: "登録者比",
      value: r.subsRatio === null ? "—" : fmtTimes(r.subsRatio),
      sub: r.subscribers === null ? "登録者数 非公開" : `登録者 ${fmtCount(r.subscribers)}人`,
      grade: grade(r.subsRatio, [0.3, 1, 5]),
    },
    {
      label: "いつもの何倍",
      value: r.baselineMultiple === null ? "—" : fmtTimes(r.baselineMultiple),
      sub: r.baselineMedian === null ? "比較データ不足" : `普段 ${fmtCount(r.baselineMedian)}回（${sample}本の中央値）`,
      grade: grade(r.baselineMultiple, [0.7, 1.5, 3]),
    },
    {
      label: "1日あたり再生",
      value: `${fmtCount(r.viewsPerDay)}回`,
      sub: "投稿からの平均",
      grade: grade(r.viewsPerDay, [1e4, 1e5, 1e6]),
    },
    {
      label: "議論度",
      value: r.commentPerLike === null ? "—" : fmtPct(r.commentPerLike),
      sub: "コメント数÷高評価数",
      grade: grade(r.commentPerLike, [0.01, 0.03, 0.08]),
    },
    {
      label: "動画の長さ",
      value: `${r.durationSec}秒`,
      sub: r.durationSec <= 15 ? "ループされやすい長さ" : r.durationSec <= 35 ? "ショートの主流の長さ" : "長め（構成力が必要）",
      grade: "na",
    },
  ];
}

function buildTypes(r: Raw, score: number): BuzzType[] {
  const t: BuzzType[] = [];
  if (r.subsRatio !== null && r.subsRatio >= 5)
    t.push({ name: "アルゴリズム拡散型", desc: "登録者以外のおすすめフィードで広く再生されている" });
  if (r.baselineMultiple !== null && r.baselineMultiple >= 3)
    t.push({ name: "一発ヒット型", desc: "チャンネルの普段の再生数を大きく上回る当たり動画" });
  if (r.subsRatio !== null && r.subsRatio < 1 && (r.subscribers ?? 0) >= 1e5)
    t.push({ name: "チャンネル力型", desc: "既存ファンの厚さで再生を稼いでいる" });
  if (r.likeRate !== null && r.likeRate >= 0.05)
    t.push({ name: "共感・満足型", desc: "見た人の多くが高評価を押すほど満足度が高い" });
  if ((r.commentRate !== null && r.commentRate >= 0.003) || (r.commentPerLike !== null && r.commentPerLike >= 0.08))
    t.push({ name: "コメント誘発型", desc: "ツッコミ・共感・議論など、書き込みたくなる要素がある" });
  if (r.durationSec <= 15 && score >= 40)
    t.push({ name: "ループ再生型", desc: "短尺で繰り返し再生され、再生回数が積み上がりやすい" });
  if (r.ageHours <= 72 && r.viewsPerDay >= 5e4)
    t.push({ name: "急上昇中", desc: "投稿直後から勢いよく再生が伸びている" });
  if (r.ageHours >= 24 * 180 && score >= 50)
    t.push({ name: "ロングセラー型", desc: "長期間にわたって再生を積み上げている" });
  return t;
}

function buildFindings(r: Raw, score: number): string[] {
  const f: string[] = [];
  if (r.subsRatio !== null) {
    if (r.subsRatio >= 5)
      f.push(`再生回数が登録者数の${fmtBai(r.subsRatio)}。登録者以外にもショートフィードで大きく拡散されています。`);
    else if (r.subsRatio >= 1) f.push(`再生回数が登録者数を上回っており（${fmtBai(r.subsRatio)}）、おすすめ経由の再生が一定あります。`);
    else f.push(`再生回数は登録者数を下回っています（${fmtBai(r.subsRatio)}）。主に既存の視聴者に見られている段階です。`);
  }
  if (r.baselineMultiple !== null && r.baselineMedian !== null) {
    if (r.baselineMultiple >= 3)
      f.push(`このチャンネルの普段のショート（中央値${fmtCount(r.baselineMedian)}回）の${fmtBai(r.baselineMultiple)}。明らかな当たり動画です。`);
    else if (r.baselineMultiple < 0.7)
      f.push(`普段のショート（中央値${fmtCount(r.baselineMedian)}回）より再生が少なめです。`);
    else f.push(`普段のショート（中央値${fmtCount(r.baselineMedian)}回）と同程度の伸びです。`);
  }
  if (r.likeRate !== null) {
    if (r.likeRate >= 0.05) f.push(`高評価率${fmtPct(r.likeRate)}はショートとして高水準。満足度・共感度が高い内容です。`);
    else if (r.likeRate < 0.02) f.push(`高評価率${fmtPct(r.likeRate)}は控えめ。流し見で回っている可能性があります。`);
  } else {
    f.push("高評価数が非公開のため、反応の熱量はコメントから判断しています。");
  }
  if (r.commentPerLike !== null && r.commentPerLike >= 0.08)
    f.push(`高評価に対してコメントが多め（${fmtPct(r.commentPerLike)}）。賛否やツッコミを呼ぶタイプかもしれません。`);
  else if (r.commentRate !== null && r.commentRate >= 0.003)
    f.push(`コメント率${fmtPct(r.commentRate)}は高め。思わず書き込みたくなる要素があります。`);
  if (r.durationSec <= 15) f.push(`${r.durationSec}秒と短く、ループ再生で回数が伸びやすい長さです。`);
  else if (r.durationSec > 60 && score >= 60) f.push(`${r.durationSec}秒と長めのショートでも伸びており、最後まで見せる構成ができています。`);
  if (r.ageHours <= 72 && r.viewsPerDay >= 5e4)
    f.push(`投稿から${fmtAge(r.ageHours)}で${fmtCount(r.views)}回。今まさに急上昇しています。`);
  else if (r.ageHours >= 24 * 180)
    f.push(`投稿から${fmtAge(r.ageHours)}が経過。再生の推移はAPIで取れないため、いつ伸びたかは不明です。`);
  return f;
}

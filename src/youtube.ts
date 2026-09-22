// YouTube Data API v3 からショート動画の情報を集める。
// 1回の分析で使うクォータは約5ユニット（無料枠は1日10,000ユニット）。

const API = "https://www.googleapis.com/youtube/v3";

export interface VideoData {
  id: string;
  title: string;
  description: string;
  tags: string[];
  publishedAt: string;
  channelId: string;
  channelTitle: string;
  durationSec: number;
  thumbnailUrl: string;
  views: number;
  likes: number | null; // 高評価数を非公開にしている動画は null
  comments: number | null; // コメントオフの動画は null
}

export interface ChannelData {
  title: string;
  subscribers: number | null; // 登録者数非公開なら null
  videoCount: number;
  /** 直近アップロードのうち3分以内の動画（≒ショート）の再生数中央値。対象動画は除く */
  recentShortsMedianViews: number | null;
  recentShortsSampleSize: number;
}

export interface TopComment {
  text: string;
  likes: number;
}

export interface FetchedData {
  video: VideoData;
  channel: ChannelData;
  comments: TopComment[];
  commentsNote: string | null;
  fetchedAt: string;
}

export class YouTubeError extends Error {}

/** ショート / 通常動画 / youtu.be など、よくあるURL形式から動画IDを取り出す */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const m = url.pathname.match(/^\/(shorts|embed|live|v)\/([^/?#]+)/);
    id = m ? m[2] : url.searchParams.get("v");
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** ISO 8601 の再生時間 (PT1M5S) を秒に */
export function parseDuration(iso: string): number {
  const m = iso.match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((v) => Number(v ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

interface ApiErrorBody {
  error?: { message?: string; errors?: { reason?: string }[] };
}

async function call<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const qs = new URLSearchParams({ ...params, key });
  let res: Response;
  try {
    res = await fetch(`${API}/${path}?${qs}`);
  } catch {
    throw new YouTubeError("YouTubeに接続できませんでした。通信状態を確認してください。");
  }
  if (res.ok) return (await res.json()) as T;

  const body = (await res.json().catch(() => ({}))) as ApiErrorBody;
  const reason = body.error?.errors?.[0]?.reason ?? "";
  const err = new YouTubeError(explainError(res.status, reason, body.error?.message));
  (err as YouTubeError & { reason: string }).reason = reason;
  throw err;
}

function explainError(status: number, reason: string, message?: string): string {
  switch (reason) {
    case "keyInvalid":
    case "badRequest":
      if (message?.includes("API key")) return "YouTube APIキーが正しくありません。設定を確認してください。";
      break;
    case "quotaExceeded":
    case "dailyLimitExceeded":
      return "YouTube APIの1日の上限に達しました。日本時間の17時ごろにリセットされます。";
    case "accessNotConfigured":
      return "Google CloudでYouTube Data API v3が有効になっていません。";
    case "ipRefererBlocked":
    case "forbidden":
      return "このAPIキーはこのサイトからの利用が許可されていません。キーの制限（HTTPリファラー）を確認してください。";
  }
  return `YouTube APIエラー (${status}) ${message ?? ""}`.trim();
}

interface VideosResponse {
  items: {
    id: string;
    snippet: {
      title: string;
      description: string;
      tags?: string[];
      publishedAt: string;
      channelId: string;
      channelTitle: string;
      thumbnails: Record<string, { url: string; width: number; height: number }>;
    };
    statistics: { viewCount?: string; likeCount?: string; commentCount?: string };
    contentDetails: { duration: string };
  }[];
}

interface ChannelsResponse {
  items: {
    snippet: { title: string };
    statistics: { subscriberCount?: string; hiddenSubscriberCount: boolean; videoCount?: string };
    contentDetails: { relatedPlaylists: { uploads: string } };
  }[];
}

interface PlaylistItemsResponse {
  items: { contentDetails: { videoId: string } }[];
}

interface CommentThreadsResponse {
  items: {
    snippet: { topLevelComment: { snippet: { textOriginal: string; likeCount: number } } };
  }[];
}

const num = (v: string | undefined): number | null => (v === undefined ? null : Number(v));

function bestThumbnail(t: VideosResponse["items"][0]["snippet"]["thumbnails"]): string {
  for (const k of ["maxres", "standard", "high", "medium", "default"]) if (t[k]) return t[k].url;
  return "";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function fetchAll(videoId: string, key: string): Promise<FetchedData> {
  const vres = await call<VideosResponse>(
    "videos",
    { part: "snippet,statistics,contentDetails", id: videoId },
    key,
  );
  const v = vres.items[0];
  if (!v) throw new YouTubeError("動画が見つかりません。非公開・削除済み、またはURLが間違っている可能性があります。");

  const video: VideoData = {
    id: v.id,
    title: v.snippet.title,
    description: v.snippet.description,
    tags: v.snippet.tags ?? [],
    publishedAt: v.snippet.publishedAt,
    channelId: v.snippet.channelId,
    channelTitle: v.snippet.channelTitle,
    durationSec: parseDuration(v.contentDetails.duration),
    thumbnailUrl: bestThumbnail(v.snippet.thumbnails),
    views: Number(v.statistics.viewCount ?? 0),
    likes: num(v.statistics.likeCount),
    comments: num(v.statistics.commentCount),
  };

  const [channel, commentResult] = await Promise.all([
    fetchChannel(video, key),
    fetchComments(videoId, key),
  ]);

  return {
    video,
    channel,
    comments: commentResult.comments,
    commentsNote: commentResult.note,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchChannel(video: VideoData, key: string): Promise<ChannelData> {
  const cres = await call<ChannelsResponse>(
    "channels",
    { part: "snippet,statistics,contentDetails", id: video.channelId },
    key,
  );
  const c = cres.items[0];
  const base: ChannelData = {
    title: c?.snippet.title ?? video.channelTitle,
    subscribers: c && !c.statistics.hiddenSubscriberCount ? num(c.statistics.subscriberCount) : null,
    videoCount: Number(c?.statistics.videoCount ?? 0),
    recentShortsMedianViews: null,
    recentShortsSampleSize: 0,
  };
  if (!c) return base;

  // チャンネルの「いつもの再生数」を出すため、直近50本から3分以内の動画を拾う
  try {
    const pl = await call<PlaylistItemsResponse>(
      "playlistItems",
      { part: "contentDetails", playlistId: c.contentDetails.relatedPlaylists.uploads, maxResults: "50" },
      key,
    );
    const ids = pl.items.map((i) => i.contentDetails.videoId).filter((id) => id !== video.id);
    if (ids.length === 0) return base;
    const vs = await call<VideosResponse>(
      "videos",
      { part: "statistics,contentDetails", id: ids.join(",") },
      key,
    );
    const shortViews = vs.items
      .filter((x) => {
        const d = parseDuration(x.contentDetails.duration);
        return d > 0 && d <= 180;
      })
      .map((x) => Number(x.statistics.viewCount ?? 0));
    return { ...base, recentShortsMedianViews: median(shortViews), recentShortsSampleSize: shortViews.length };
  } catch {
    return base; // 比較用データが取れなくても本体の分析は続ける
  }
}

async function fetchComments(videoId: string, key: string): Promise<{ comments: TopComment[]; note: string | null }> {
  try {
    const res = await call<CommentThreadsResponse>(
      "commentThreads",
      { part: "snippet", videoId, order: "relevance", maxResults: "30", textFormat: "plainText" },
      key,
    );
    const comments = res.items.map((i) => ({
      text: i.snippet.topLevelComment.snippet.textOriginal,
      likes: i.snippet.topLevelComment.snippet.likeCount,
    }));
    return { comments, note: comments.length === 0 ? "コメントはまだありません。" : null };
  } catch (e) {
    const reason = (e as { reason?: string }).reason;
    if (reason === "commentsDisabled") return { comments: [], note: "この動画はコメントがオフです。" };
    return { comments: [], note: "コメントを取得できませんでした。" };
  }
}

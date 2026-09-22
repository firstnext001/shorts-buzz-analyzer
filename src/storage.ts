// 設定（APIキー）と分析履歴をこの端末の localStorage に保存する。
// プライベートブラウズ等で使えない場合でもアプリ自体は動くようにしている。

import type { AiResult } from "./ai";
import type { Analysis } from "./metrics";
import type { PlanResult } from "./plan-ai";
import type { Segment } from "./transcribe";
import type { FetchedData } from "./youtube";

export interface Settings {
  youtubeKey: string;
  anthropicKey: string;
  openaiKey: string;
  useAi: boolean;
  /** ジャンル・視聴者層・キャラなど。提案をチャンネルに合わせるために使う */
  channelProfile: string;
}

export interface HistoryEntry {
  videoId: string;
  savedAt: string;
  data: FetchedData;
  analysis: Analysis;
  ai: AiResult | null;
}

const SETTINGS_KEY = "sba.settings.v1";
const HISTORY_KEY = "sba.history.v1";
const HISTORY_MAX = 30;
const PLANS_KEY = "sba.plans.v1";
const PLANS_MAX = 20;

export interface PlanEntry {
  id: string;
  createdAt: string;
  fileName: string;
  duration: number;
  /** カバー候補の場面の小さな画像（data URL） */
  coverImage: string;
  referenceTitles: string[];
  script: string;
  notes: string;
  transcript: Segment[] | null;
  result: PlanResult;
}

function read<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(key);
    return s ? { ...fallback, ...JSON.parse(s) } : fallback;
  } catch {
    return fallback;
  }
}

function readArray<T>(key: string): T[] {
  try {
    const s = localStorage.getItem(key);
    const v = s ? JSON.parse(s) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存できない環境では何もしない */
  }
}

export function loadSettings(): Settings {
  return read<Settings>(SETTINGS_KEY, { youtubeKey: "", anthropicKey: "", openaiKey: "", useAi: true, channelProfile: "" });
}

export function saveSettings(s: Settings): void {
  write(SETTINGS_KEY, s);
}

export function loadHistory(): HistoryEntry[] {
  return readArray<HistoryEntry>(HISTORY_KEY);
}

export function addHistory(entry: HistoryEntry): void {
  const list = loadHistory().filter((h) => h.videoId !== entry.videoId);
  list.unshift(entry);
  write(HISTORY_KEY, list.slice(0, HISTORY_MAX));
}

export function removeHistory(videoId: string): void {
  write(
    HISTORY_KEY,
    loadHistory().filter((h) => h.videoId !== videoId),
  );
}

export function loadPlans(): PlanEntry[] {
  return readArray<PlanEntry>(PLANS_KEY);
}

export function addPlan(entry: PlanEntry): void {
  const list = loadPlans().filter((p) => p.id !== entry.id);
  list.unshift(entry);
  write(PLANS_KEY, list.slice(0, PLANS_MAX));
}

export function removePlan(id: string): void {
  write(
    PLANS_KEY,
    loadPlans().filter((p) => p.id !== id),
  );
}

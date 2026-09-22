// 設定（APIキー）と分析履歴をこの端末の localStorage に保存する。
// プライベートブラウズ等で使えない場合でもアプリ自体は動くようにしている。

import type { AiResult } from "./ai";
import type { Analysis } from "./metrics";
import type { FetchedData } from "./youtube";

export interface Settings {
  youtubeKey: string;
  anthropicKey: string;
  useAi: boolean;
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
  return read<Settings>(SETTINGS_KEY, { youtubeKey: "", anthropicKey: "", useAi: true });
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

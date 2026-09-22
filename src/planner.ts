// 「動画に提案」タブ：参考のバズ動画を選び、自分の動画を読み込んで、タイトル・テロップ等の提案を受け取る。

import "./planner.css";
import { AiError } from "./ai";
import { $, copyButton, h, thumb, type Child } from "./dom";
import { extractFrames, FrameError, smallImage, type Frame, type FrameSet } from "./frames";
import { proposeWithClaude, type PlanResult, type TelopStyle } from "./plan-ai";
import {
  addPlan,
  loadHistory,
  loadPlans,
  loadSettings,
  removePlan,
  type PlanEntry,
} from "./storage";
import {
  extractAudio,
  prepareCapture,
  segmentsToText,
  transcribe,
  TranscribeError,
  type Segment,
} from "./transcribe";

const MAX_REFS = 5;
const MAX_DURATION = 180; // ショートの上限（3分）

const refList = $<HTMLUListElement>("ref-list");
const refEmpty = $<HTMLParagraphElement>("ref-empty");
const refCount = $<HTMLSpanElement>("ref-count");
const videoInput = $<HTMLInputElement>("video-input");
const videoInfo = $<HTMLDivElement>("video-info");
const scriptInput = $<HTMLTextAreaElement>("script-input");
const scriptBox = $<HTMLDivElement>("script-box");
const autoNote = $<HTMLDivElement>("auto-note");
const notesInput = $<HTMLTextAreaElement>("notes-input");
const planBtn = $<HTMLButtonElement>("plan-btn");
const planError = $<HTMLParagraphElement>("plan-error");
const planResult = $<HTMLDivElement>("plan-result");
const planSetup = $<HTMLElement>("plan-setup");
const planHistory = $<HTMLElement>("plan-history");
const planHistoryList = $<HTMLUListElement>("plan-history-list");

const selectedRefs = new Set<string>();
let videoFile: File | null = null;
let previewUrl: string | null = null;
let busy = false;
let openSettings: () => void = () => {};

type SpeechMode = "script" | "auto";

function speechMode(): SpeechMode {
  return document.querySelector<HTMLInputElement>('input[name="speech"]:checked')?.value === "auto" ? "auto" : "script";
}

function setSpeechMode(mode: SpeechMode) {
  const radio = document.querySelector<HTMLInputElement>(`input[name="speech"][value="${mode}"]`);
  if (radio) radio.checked = true;
  updateSpeechUi();
}

function showError(msg: string | null) {
  planError.textContent = msg ?? "";
  planError.hidden = !msg;
}

// ---------- 参考動画の選択 ----------

function renderRefs() {
  const history = loadHistory();
  for (const id of [...selectedRefs]) if (!history.some((e) => e.videoId === id)) selectedRefs.delete(id);
  refEmpty.hidden = history.length > 0;
  refCount.textContent = history.length ? `${selectedRefs.size}/${MAX_REFS}本選択中` : "";
  const full = selectedRefs.size >= MAX_REFS;
  refList.replaceChildren(
    ...history.map((e) => {
      const checked = selectedRefs.has(e.videoId);
      const box = h("input", { type: "checkbox", id: `ref-${e.videoId}` });
      box.checked = checked;
      box.disabled = full && !checked;
      box.addEventListener("change", () => {
        if (box.checked) selectedRefs.add(e.videoId);
        else selectedRefs.delete(e.videoId);
        renderRefs();
      });
      return h(
        "li",
        null,
        h(
          "label",
          { class: checked ? "ref is-on" : "ref", for: `ref-${e.videoId}` },
          box,
          thumb(e.data.video.thumbnailUrl),
          h(
            "span",
            { class: "ref-text" },
            h("span", { class: "ref-title" }, e.data.video.title),
            h("span", { class: "ref-sub" }, `${e.analysis.level.name} ・ ${e.ai ? "AI分析あり" : "数値のみ"}`),
          ),
          h("span", { class: "ref-score" }, e.analysis.score),
        ),
      );
    }),
  );
}

// ---------- 動画の選択 ----------

function onVideoChosen() {
  const file = videoInput.files?.[0] ?? null;
  videoInput.value = ""; // 同じファイルを選び直しても反応するように
  if (!file) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  videoFile = file;
  previewUrl = URL.createObjectURL(file);
  const preview = h("video", { class: "video-preview", src: previewUrl, controls: "", playsinline: "", muted: "", preload: "metadata" });
  const meta = h("div", { class: "video-file-meta" }, h("b", null, file.name), h("span", { id: "video-duration" }, "長さを確認中…"));
  preview.addEventListener("loadedmetadata", () => {
    const d = preview.duration;
    const el = document.getElementById("video-duration");
    if (!el) return;
    el.textContent = `${d.toFixed(1)}秒 ・ ${(file.size / 1024 / 1024).toFixed(1)}MB`;
    if (d > MAX_DURATION) el.textContent += "（ショートの上限3分を超えています）";
  });
  videoInfo.replaceChildren(preview, meta);
  showError(null);
}

// ---------- 話している内容 ----------

function updateSpeechUi() {
  const auto = speechMode() === "auto";
  scriptBox.hidden = auto;
  autoNote.hidden = !auto;
  if (!auto) return;
  const hasKey = Boolean(loadSettings().openaiKey);
  if (hasKey) {
    autoNote.replaceChildren(
      h("p", null, "動画の音声をOpenAIの文字起こし（Whisper）に送り、話した内容を秒数つきで文字にします。料金は1分あたり約1円です。"),
      h("p", { class: "hint" }, "iPhoneで音声を一度に取り出せない形式の動画は、動画の長さぶん時間をかけて取り込みます（音は鳴りません）。"),
    );
  } else {
    const btn = h("button", { type: "button", class: "btn-ghost" }, "OpenAI APIキーを設定");
    btn.addEventListener("click", openSettings);
    autoNote.replaceChildren(h("p", null, "自動で文字起こしするには、設定でOpenAI APIキーを登録してください。"), btn);
  }
}

// ---------- 提案の作成 ----------

function setBusy(b: boolean) {
  busy = b;
  planBtn.disabled = b;
  planBtn.textContent = b ? "提案を作成中…" : "提案を作る";
}

function progressView(): { el: HTMLElement; set: (msg: string) => void } {
  const text = h("span", null, "準備しています…");
  const el = h(
    "div",
    { class: "loading" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("div", null, h("b", { class: "loading-title" }, "提案を作っています"), text),
  );
  return { el, set: (msg) => (text.textContent = msg) };
}

async function onPlan() {
  if (busy) return;
  showError(null);
  const s = loadSettings();
  if (!s.anthropicKey) {
    showError("提案を作るには、設定でAnthropic APIキーを登録してください。");
    openSettings();
    return;
  }
  if (!videoFile) {
    showError("「動画を選ぶ」から、提案してほしい動画を選んでください。");
    return;
  }
  const mode = speechMode();
  if (mode === "auto" && !s.openaiKey) {
    showError("自動で文字起こしするには、設定でOpenAI APIキーを登録してください。");
    openSettings();
    return;
  }

  const file = videoFile;
  // iPhoneでは音声付きの再生をタップ直後にしか始められないので、ここで先に準備する
  const capture = mode === "auto" ? prepareCapture(file) : null;
  setBusy(true);
  const progress = progressView();
  planResult.replaceChildren(progress.el);
  progress.el.scrollIntoView({ behavior: "smooth", block: "center" });

  try {
    const frames = await extractFrames(file, (done, total) => progress.set(`場面を切り出しています…（${done}/${total}）`));
    if (frames.duration > MAX_DURATION + 1) {
      throw new FrameError("3分を超える動画です。ショート用に3分以内に編集した動画を選んでください。");
    }

    let transcript: Segment[] | null = null;
    if (capture) {
      const wav = await extractAudio(file, capture, progress.set);
      progress.set("文字起こしをしています…");
      transcript = await transcribe(s.openaiKey, wav);
    }

    const references = loadHistory().filter((e) => selectedRefs.has(e.videoId));
    const script = scriptInput.value;
    const notes = notesInput.value;
    progress.set("AIが映像と参考動画を見ています…（1〜2分ほどかかります）");
    const result = await proposeWithClaude(
      s.anthropicKey,
      {
        frames,
        references,
        channelProfile: s.channelProfile,
        notes,
        speech: transcript ? { kind: "transcript", segments: transcript } : { kind: "script", text: script },
      },
      (chars) => progress.set(`提案を書いています…（${chars.toLocaleString("ja-JP")}字）`),
    );

    const entry: PlanEntry = {
      id: `${Date.now()}`,
      createdAt: new Date().toISOString(),
      fileName: file.name,
      duration: frames.duration,
      coverImage: await smallImage(nearestFrame(frames, result.cover.time)),
      referenceTitles: references.map((e) => e.data.video.title),
      script: transcript ? "" : script,
      notes,
      transcript,
      result,
    };
    addPlan(entry);
    renderPlan(entry, frames);
    renderPlanHistory();
  } catch (e) {
    planResult.replaceChildren();
    const known = e instanceof FrameError || e instanceof TranscribeError || e instanceof AiError;
    showError(known ? (e as Error).message : "提案の作成中にエラーが発生しました。もう一度お試しください。");
  } finally {
    capture?.dispose();
    setBusy(false);
  }
}

function nearestFrame(frames: FrameSet, t: number): Frame {
  return frames.frames.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best.time - t) ? f : best));
}

// ---------- 結果の表示 ----------

const STYLE_GRADE: Record<TelopStyle, string> = {
  フック: "g-top",
  オチ: "g-top",
  強調: "g-high",
  ツッコミ: "g-avg",
  説明: "g-low",
};

const sec = (t: number) => `${t.toFixed(1)}`;

/** 「／」を改行として見せる */
function telopText(text: string): Child[] {
  return text.split("／").flatMap((part, i) => (i === 0 ? [part] : [h("br"), part]));
}

function block(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "plan-block" }, h("h3", null, title), ...children);
}

function renderPlan(entry: PlanEntry, frames?: FrameSet) {
  const r: PlanResult = entry.result;
  const coverSrc = frames
    ? `data:image/jpeg;base64,${nearestFrame(frames, r.cover.time).base64}`
    : entry.coverImage;

  const titles = h(
    "ol",
    { class: "plan-titles" },
    ...r.titles.map((t) =>
      h("li", null, h("div", { class: "plan-title-text" }, t.text), h("div", { class: "plan-aim" }, t.aim), copyButton("コピー", () => t.text)),
    ),
  );

  const telops = h(
    "ol",
    { class: "telops" },
    ...r.telops.map((t) =>
      h(
        "li",
        { class: "telop" },
        h("span", { class: "telop-time" }, `${sec(t.start)}–${sec(t.end)}秒`),
        h(
          "div",
          { class: "telop-body" },
          h("div", { class: "telop-tags" }, h("span", { class: `pill ${STYLE_GRADE[t.style] ?? "g-low"}` }, t.style), h("span", { class: "telop-pos" }, `位置: ${t.position}`)),
          h("div", { class: "telop-text" }, ...telopText(t.text)),
          t.note && h("div", { class: "telop-note" }, t.note),
        ),
      ),
    ),
  );
  const telopsCopy = copyButton("テロップをまとめてコピー", () =>
    r.telops.map((t) => `${sec(t.start)}〜${sec(t.end)}秒 ${t.text.replace(/／/g, " ")}`).join("\n"),
  );

  const descText = `${r.description}\n\n${r.hashtags.join(" ")}`;

  const parts: Child[] = [
    h("div", { class: "plan-head" }, h("span", { class: "section-title" }, "この動画の勝ち筋"), h("p", { class: "plan-concept" }, r.concept)),
    block("タイトル案", titles),
    block("冒頭0〜2秒のつかみ", h("p", { class: "hook-telop" }, ...telopText(r.hook.telop)), h("p", null, r.hook.advice)),
    block("テロップ案", h("p", { class: "hint" }, "時間は目安です。編集アプリで実際の間に合わせて調整してください。"), telops, telopsCopy),
    block(
      "カバー（サムネ）",
      h(
        "div",
        { class: coverSrc ? "cover has-img" : "cover" },
        coverSrc ? h("img", { class: "cover-img", src: coverSrc, alt: "" }) : null,
        h("div", null, h("div", { class: "cover-time" }, `${sec(r.cover.time)}秒の場面`), h("div", { class: "cover-text" }, ...telopText(r.cover.text)), h("p", null, r.cover.reason)),
      ),
    ),
    block("概要欄・ハッシュタグ", h("p", { class: "desc" }, r.description), h("p", { class: "tags" }, r.hashtags.join(" ")), copyButton("概要欄をコピー", () => descText)),
    block("編集の改善点", h("ul", { class: "takeaways" }, ...r.editing.map((x) => h("li", null, x)))),
    block("参考動画から取り入れたこと", h("p", null, r.borrowed), entry.referenceTitles.length ? h("ul", { class: "ref-used" }, ...entry.referenceTitles.map((t) => h("li", null, t))) : h("p", { class: "hint" }, "参考動画なしで提案しました。")),
  ];

  if (entry.transcript) {
    const toScript = h("button", { type: "button", class: "btn-ghost" }, "台本欄に入れて直す");
    toScript.addEventListener("click", () => {
      scriptInput.value = segmentsToText(entry.transcript ?? []);
      setSpeechMode("script");
      scriptInput.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    parts.push(
      h(
        "details",
        { class: "comments" },
        h("summary", null, `文字起こしの結果（${entry.transcript.length}件）`),
        entry.transcript.length
          ? h("pre", { class: "transcript" }, segmentsToText(entry.transcript))
          : h("p", { class: "hint" }, "発言は検出されませんでした。"),
        h("p", { class: "hint" }, "聞き間違いがあれば、台本欄で直してからもう一度「提案を作る」を押すと、より正確な提案になります。"),
        toScript,
      ),
    );
  }

  planResult.replaceChildren(h("div", { class: "plan" }, ...parts));
  planResult.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- 提案の履歴 ----------

const dateFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function renderPlanHistory() {
  const list = loadPlans();
  planHistory.hidden = list.length === 0;
  planHistoryList.replaceChildren(
    ...list.map((p) => {
      const open = h(
        "button",
        { type: "button", class: "h-open" },
        thumb(p.coverImage),
        h(
          "span",
          { class: "h-text" },
          h("span", { class: "h-title" }, p.result.titles[0]?.text ?? p.fileName),
          h("span", { class: "h-date" }, `${dateFmt.format(new Date(p.createdAt))} ・ ${p.duration.toFixed(0)}秒`),
        ),
      );
      open.addEventListener("click", () => {
        showError(null);
        renderPlan(p);
      });
      const del = h("button", { type: "button", class: "h-del", "aria-label": "提案を削除" }, "×");
      del.addEventListener("click", () => {
        removePlan(p.id);
        renderPlanHistory();
      });
      return h("li", { class: "h-item" }, open, del);
    }),
  );
}

// ---------- 初期化 ----------

export function refreshPlanner() {
  planSetup.hidden = Boolean(loadSettings().anthropicKey);
  renderRefs();
  renderPlanHistory();
  updateSpeechUi();
}

export function initPlanner(open: () => void) {
  openSettings = open;
  videoInput.addEventListener("change", onVideoChosen);
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="speech"]')) {
    r.addEventListener("change", updateSpeechUi);
  }
  planBtn.addEventListener("click", () => void onPlan());
  $("plan-setup-open").addEventListener("click", open);
  refreshPlanner();
}


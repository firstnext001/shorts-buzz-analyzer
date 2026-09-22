import "./style.css";
import { AiError, analyzeWithClaude, type AiResult } from "./ai";
import { analyze, fmtCount, GRADE_LABEL, type Analysis } from "./metrics";
import {
  addHistory,
  loadHistory,
  loadSettings,
  removeHistory,
  saveSettings,
  type HistoryEntry,
} from "./storage";
import { fetchAll, parseVideoId, YouTubeError, type FetchedData } from "./youtube";

// ---------- DOM helper（YouTube由来の文字列は必ず textContent で入れる） ----------

type Child = Node | string | number | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string> | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** サムネイル。URLが無い・読み込めない場合は同じ大きさの無地の枠を出す */
function thumb(url: string, cls?: string): HTMLElement {
  const attrs: Record<string, string> = { alt: "", loading: "lazy", referrerpolicy: "no-referrer" };
  if (cls) attrs.class = cls;
  const img = h("img", attrs);
  img.addEventListener("error", () => img.removeAttribute("src"));
  if (url) img.src = url;
  return img;
}

const form = $<HTMLFormElement>("entry");
const urlInput = $<HTMLInputElement>("url-input");
const analyzeBtn = $<HTMLButtonElement>("analyze-btn");
const entryError = $<HTMLParagraphElement>("entry-error");
const resultEl = $<HTMLElement>("result");
const setupEl = $<HTMLElement>("setup");
const historyEl = $<HTMLElement>("history");
const historyList = $<HTMLUListElement>("history-list");
const settingsDialog = $<HTMLDialogElement>("settings");
const settingsForm = $<HTMLFormElement>("settings-form");
const ytKeyInput = $<HTMLInputElement>("yt-key");
const aiKeyInput = $<HTMLInputElement>("ai-key");
const useAiInput = $<HTMLInputElement>("use-ai");

// ---------- state ----------

type AiState =
  | { kind: "off" }
  | { kind: "nokey" }
  | { kind: "loading"; chars: number }
  | { kind: "error"; message: string }
  | { kind: "done"; result: AiResult };

interface Current {
  data: FetchedData;
  analysis: Analysis;
  ai: AiState;
}

let current: Current | null = null;
let runId = 0;
let aiSlot: HTMLElement | null = null;

// ---------- analysis flow ----------

function extractUrl(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  return (m ? m[0] : text).trim();
}

function showEntryError(msg: string | null) {
  entryError.textContent = msg ?? "";
  entryError.hidden = !msg;
}

function setBusy(busy: boolean) {
  analyzeBtn.disabled = busy;
  analyzeBtn.textContent = busy ? "分析中…" : "分析する";
}

async function run(input: string) {
  showEntryError(null);
  const videoId = parseVideoId(extractUrl(input));
  if (!videoId) {
    showEntryError("YouTubeショートのURLを入力してください（例: https://youtube.com/shorts/…）");
    return;
  }
  const settings = loadSettings();
  if (!settings.youtubeKey) {
    showEntryError("先に設定からYouTube APIキーを登録してください。");
    openSettings();
    return;
  }

  const myRun = ++runId;
  setBusy(true);
  current = null;
  aiSlot = null;
  resultEl.replaceChildren(
    h("div", { class: "loading" }, h("span", { class: "spinner", "aria-hidden": "true" }), "動画のデータを取得しています…"),
  );

  let data: FetchedData;
  try {
    data = await fetchAll(videoId, settings.youtubeKey);
  } catch (e) {
    if (myRun !== runId) return;
    resultEl.replaceChildren();
    showEntryError(e instanceof YouTubeError ? e.message : "データの取得中にエラーが発生しました。");
    setBusy(false);
    return;
  }
  if (myRun !== runId) return;

  const analysis = analyze(data);
  const wantsAi = settings.useAi;
  const ai: AiState = !wantsAi ? { kind: "off" } : settings.anthropicKey ? { kind: "loading", chars: 0 } : { kind: "nokey" };
  current = { data, analysis, ai };
  renderResult(current);
  save(current);
  setBusy(false);
  resultEl.scrollIntoView({ behavior: "smooth", block: "start" });

  if (ai.kind === "loading") await runAi(myRun, settings.anthropicKey);
}

async function runAi(myRun: number, apiKey: string) {
  if (!current) return;
  const target = current;
  target.ai = { kind: "loading", chars: 0 };
  renderAi();
  try {
    const result = await analyzeWithClaude(apiKey, target.data, target.analysis, (chars) => {
      if (myRun !== runId || current !== target) return;
      target.ai = { kind: "loading", chars };
      updateAiProgress(chars);
    });
    target.ai = { kind: "done", result };
    save(target);
  } catch (e) {
    target.ai = { kind: "error", message: e instanceof AiError ? e.message : "AI分析に失敗しました。" };
  }
  if (myRun === runId && current === target) renderAi();
  renderHistory();
}

function save(c: Current) {
  addHistory({
    videoId: c.data.video.id,
    savedAt: new Date().toISOString(),
    data: c.data,
    analysis: c.analysis,
    ai: c.ai.kind === "done" ? c.ai.result : null,
  });
  renderHistory();
}

// ---------- rendering ----------

const LEVEL_COLOR: Record<string, string> = {
  平熱: "var(--cool)",
  微熱: "var(--warm)",
  発熱: "var(--warm)",
  高熱: "var(--hot)",
  沸騰: "var(--hot)",
};

const dateFmt = new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function renderResult(c: Current) {
  const { data: d, analysis: a } = c;
  const v = d.video;

  const videoBlock = h(
    "section",
    { class: "video" },
    thumb(v.thumbnailUrl, "video-thumb"),
    h(
      "div",
      { class: "video-meta" },
      h("h2", { class: "video-title" }, v.title),
      h("div", { class: "video-sub" }, d.channel.title, h("br"), `${a.raw.publishedJst} 投稿`),
      h("a", { class: "video-link", href: `https://www.youtube.com/shorts/${v.id}`, target: "_blank", rel: "noopener" }, "YouTubeで開く ↗"),
    ),
  );

  const marker = h("span", { class: "thermo-marker", style: `left:${a.score}%` });
  const scoreBlock = h(
    "section",
    { class: "score", "aria-label": `バズ度 ${a.score}点、${a.level.name}` },
    h(
      "div",
      { class: "score-head" },
      h("div", null, h("div", { class: "score-label" }, "バズ度"), h("div", { class: "score-num" }, a.score, h("small", null, "/100"))),
      h(
        "div",
        { class: "score-level", style: `--level-color:${LEVEL_COLOR[a.level.name] ?? "var(--ink)"}` },
        h("div", { class: "score-level-name" }, a.level.name),
        h("div", { class: "score-level-desc" }, a.level.desc),
      ),
    ),
    h(
      "div",
      { class: "thermo", "aria-hidden": "true" },
      h("div", { class: "thermo-track" }),
      marker,
      h(
        "div",
        { class: "thermo-ticks" },
        ...[
          ["平熱", 15],
          ["微熱", 40],
          ["発熱", 60],
          ["高熱", 77.5],
          ["沸騰", 92.5],
        ].map(([name, pos]) => h("span", { style: `left:${pos}%` }, name)),
      ),
    ),
    h(
      "div",
      { class: "parts" },
      ...a.parts.map((p) =>
        h(
          "div",
          { class: p.score === null ? "part is-na" : "part" },
          h("span", null, p.label),
          h("span", { class: "part-bar" }, h("i", { style: `width:${p.score ?? 0}%` })),
          h("span", { class: "part-val" }, p.score ?? "—"),
        ),
      ),
    ),
  );

  const typesBlock = h(
    "section",
    null,
    h("h2", { class: "section-title" }, "バズの型"),
    a.types.length
      ? h("div", { class: "types" }, ...a.types.map((t) => h("div", { class: "type" }, h("b", null, t.name), t.desc)))
      : h("p", { class: "type-none" }, "数値からはっきりした型は見つかりませんでした。"),
  );

  const metricsBlock = h(
    "section",
    null,
    h("h2", { class: "section-title" }, "数値"),
    h(
      "div",
      { class: "metrics" },
      ...a.metrics.map((m) =>
        h(
          "div",
          { class: "metric" },
          h("div", { class: "metric-top" }, m.label, m.grade !== "na" && h("span", { class: `pill g-${m.grade}` }, GRADE_LABEL[m.grade])),
          h("div", { class: "metric-value" }, m.value),
          h("div", { class: "metric-sub" }, m.sub),
        ),
      ),
    ),
  );

  const findingsBlock = a.findings.length
    ? h(
        "section",
        null,
        h("h2", { class: "section-title" }, "数値から読み取れること"),
        h("ul", { class: "findings" }, ...a.findings.map((f) => h("li", null, f))),
      )
    : null;

  aiSlot = h("section", { class: "ai" });

  const commentsBlock = h(
    "details",
    { class: "comments" },
    h("summary", null, d.comments.length ? `上位コメント（${d.comments.length}件）` : "コメント"),
    d.comments.length
      ? h(
          "ol",
          null,
          ...d.comments.map((cm) => h("li", null, cm.text, h("span", { class: "c-likes" }, `いいね ${fmtCount(cm.likes)}`))),
        )
      : h("p", { class: "ai-msg" }, d.commentsNote ?? "コメントはありません。"),
  );

  resultEl.replaceChildren(videoBlock, scoreBlock, aiSlot, typesBlock, metricsBlock, ...(findingsBlock ? [findingsBlock] : []), commentsBlock);
  renderAi();
}

function aiHead(): HTMLElement {
  return h("div", { class: "ai-head" }, h("h2", { class: "section-title" }, "AIによるバズ理由の分析"), h("span", { class: "ai-model" }, "Claude"));
}

function renderAi() {
  if (!aiSlot || !current) return;
  const s = current.ai;
  switch (s.kind) {
    case "off":
      aiSlot.replaceChildren(aiHead(), h("p", { class: "ai-msg" }, "AI分析はオフになっています。設定からオンにできます。"));
      break;
    case "nokey": {
      const btn = h("button", { type: "button", class: "btn-ghost" }, "Anthropic APIキーを設定");
      btn.addEventListener("click", openSettings);
      aiSlot.replaceChildren(
        aiHead(),
        h("p", { class: "ai-msg" }, "Anthropic APIキーを設定すると、タイトル・コメント・サムネイルも読み込んで、バズった理由を文章で解説します。"),
        btn,
      );
      break;
    }
    case "loading":
      aiSlot.replaceChildren(
        aiHead(),
        h(
          "div",
          { class: "ai-wait" },
          h("span", { class: "spinner", "aria-hidden": "true" }),
          h("div", null, h("b", null, "タイトル・コメント・サムネイルを読んでいます"), h("span", { id: "ai-progress" }, progressText(s.chars))),
        ),
      );
      break;
    case "error": {
      const retry = h("button", { type: "button", class: "btn-ghost" }, "もう一度AI分析する");
      retry.addEventListener("click", () => {
        const key = loadSettings().anthropicKey;
        if (key) void runAi(runId, key);
        else openSettings();
      });
      aiSlot.replaceChildren(aiHead(), h("p", { class: "ai-msg is-error" }, s.message), retry);
      break;
    }
    case "done":
      aiSlot.replaceChildren(...renderAiResult(s.result));
      break;
  }
}

function progressText(chars: number): string {
  return chars > 0 ? `回答を作成中…（${chars.toLocaleString("ja-JP")}字）` : "考えています…（30秒〜1分ほどかかります）";
}

function updateAiProgress(chars: number) {
  const el = document.getElementById("ai-progress");
  if (el) el.textContent = progressText(chars);
}

const CONF_GRADE: Record<string, string> = { 高: "g-top", 中: "g-high", 低: "g-low" };

function renderAiResult(r: AiResult): Node[] {
  const block = (title: string, ...body: Child[]) => h("div", { class: "ai-block" }, h("h3", null, title), ...body);
  return [
    aiHead(),
    h("p", { class: "ai-verdict" }, r.verdict),
    h("p", { class: "ai-summary" }, r.summary),
    h(
      "ol",
      { class: "reasons" },
      ...r.reasons.map((x) =>
        h(
          "li",
          { class: "reason" },
          h("div", { class: "reason-title" }, x.title, h("span", { class: `pill ${CONF_GRADE[x.confidence] ?? "g-low"}` }, `確度 ${x.confidence}`)),
          h("p", { class: "reason-detail" }, x.detail),
          h("p", { class: "reason-evidence" }, `根拠: ${x.evidence}`),
        ),
      ),
    ),
    block("つかみ・企画の切り口", h("p", null, r.hook)),
    block("視聴者の反応", h("p", null, r.audience)),
    block("自分の動画に活かすなら", h("ul", { class: "takeaways" }, ...r.takeaways.map((t) => h("li", null, t)))),
    h("div", { class: "ai-block" }, h("p", { class: "ai-caveats" }, r.caveats)),
  ];
}

function showFromHistory(e: HistoryEntry) {
  runId++;
  setBusy(false);
  showEntryError(null);
  current = {
    data: e.data,
    analysis: e.analysis,
    ai: e.ai ? { kind: "done", result: e.ai } : loadSettings().anthropicKey ? { kind: "error", message: "この分析にはAIの結果がありません。" } : { kind: "nokey" },
  };
  urlInput.value = `https://youtube.com/shorts/${e.videoId}`;
  renderResult(current);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderHistory() {
  const list = loadHistory();
  historyEl.hidden = list.length === 0;
  historyList.replaceChildren(
    ...list.map((e) => {
      const open = h(
        "button",
        { type: "button", class: "h-open" },
        thumb(e.data.video.thumbnailUrl),
        h(
          "span",
          { class: "h-text" },
          h("span", { class: "h-title" }, e.data.video.title),
          h("span", { class: "h-date" }, `${dateFmt.format(new Date(e.savedAt))} ・ ${e.analysis.level.name}`),
        ),
        h("span", { class: "h-score" }, e.analysis.score),
      );
      open.addEventListener("click", () => showFromHistory(e));
      const del = h("button", { type: "button", class: "h-del", "aria-label": "履歴から削除" }, "×");
      del.addEventListener("click", () => {
        removeHistory(e.videoId);
        renderHistory();
      });
      return h("li", { class: "h-item" }, open, del);
    }),
  );
}

// ---------- settings ----------

function refreshSetupNotice() {
  setupEl.hidden = Boolean(loadSettings().youtubeKey);
}

function openSettings() {
  const s = loadSettings();
  ytKeyInput.value = s.youtubeKey;
  aiKeyInput.value = s.anthropicKey;
  useAiInput.checked = s.useAi;
  for (const input of [ytKeyInput, aiKeyInput]) input.classList.add("masked");
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".reveal")) btn.textContent = "表示";
  if (!settingsDialog.open) settingsDialog.showModal();
}

settingsForm.addEventListener("submit", () => {
  saveSettings({
    youtubeKey: ytKeyInput.value.trim(),
    anthropicKey: aiKeyInput.value.trim(),
    useAi: useAiInput.checked,
  });
  refreshSetupNotice();
  // キーを設定した直後なら、表示中の動画のAI分析を始める
  const s = loadSettings();
  if (current && s.useAi && s.anthropicKey && (current.ai.kind === "nokey" || current.ai.kind === "off")) {
    void runAi(runId, s.anthropicKey);
  } else if (current && !s.useAi && current.ai.kind !== "done") {
    current.ai = { kind: "off" };
    renderAi();
  }
});

$("settings-close").addEventListener("click", () => settingsDialog.close());
settingsDialog.addEventListener("click", (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});
$("open-settings").addEventListener("click", openSettings);
$("setup-open").addEventListener("click", openSettings);

for (const btn of document.querySelectorAll<HTMLButtonElement>(".reveal")) {
  btn.addEventListener("click", () => {
    const input = $<HTMLInputElement>(btn.dataset.target ?? "");
    const hidden = input.classList.toggle("masked");
    btn.textContent = hidden ? "表示" : "隠す";
  });
}

// ---------- entry ----------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  urlInput.blur();
  void run(urlInput.value);
});

$("paste-btn").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    urlInput.value = extractUrl(text);
    if (parseVideoId(urlInput.value)) void run(urlInput.value);
    else showEntryError("クリップボードにYouTubeのURLが見つかりませんでした。");
  } catch {
    urlInput.focus();
    showEntryError("貼り付けできませんでした。入力欄を長押しして「ペースト」を選んでください。");
  }
});

// ---------- boot ----------

refreshSetupNotice();
renderHistory();

// ショートカット等から ?url=… 付きで開かれたら、そのまま分析する
const params = new URLSearchParams(location.search);
const shared = params.get("url") ?? params.get("text");
if (shared) {
  history.replaceState(null, "", location.pathname);
  urlInput.value = extractUrl(shared);
  if (loadSettings().youtubeKey) void run(urlInput.value);
}

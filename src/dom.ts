// 画面づくりの小さな道具。YouTubeやAI由来の文字列は必ず textContent で入れる（innerHTMLは使わない）。

export type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
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

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** サムネイル。URLが無い・読み込めない場合は同じ大きさの無地の枠を出す */
export function thumb(url: string, cls?: string): HTMLElement {
  const attrs: Record<string, string> = { alt: "", loading: "lazy", referrerpolicy: "no-referrer" };
  if (cls) attrs.class = cls;
  const img = h("img", attrs);
  img.addEventListener("error", () => img.removeAttribute("src"));
  if (url) img.src = url;
  return img;
}

/** 押すと text をコピーし、ボタンの表示で結果を知らせる */
export function copyButton(label: string, getText: () => string): HTMLButtonElement {
  const btn = h("button", { type: "button", class: "btn-copy" }, label);
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "コピーしました";
    } catch {
      btn.textContent = "コピーできませんでした";
    }
    setTimeout(() => (btn.textContent = label), 1600);
  });
  return btn;
}

// 端末内の動画から場面の静止画を切り出す（動画そのものはどこにも送らない）。

export interface Frame {
  time: number;
  /** JPEG の base64（data: の接頭辞なし） */
  base64: string;
}

export interface FrameSet {
  duration: number;
  width: number;
  height: number;
  frames: Frame[];
}

export class FrameError extends Error {}

const MAX_FRAMES = 24;
const LONG_SIDE = 720; // 文字が読めて、AIの料金も抑えられる大きさ

function waitFor(el: HTMLMediaElement, event: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new FrameError("動画の読み込みに時間がかかりすぎました。もう一度お試しください。")), timeoutMs);
    const onOk = () => done();
    const onErr = () => done(new FrameError("この動画を読み込めませんでした。別の形式で書き出した動画でお試しください。"));
    function done(err?: Error) {
      clearTimeout(timer);
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onErr);
      if (err) reject(err);
      else resolve();
    }
    el.addEventListener(event, onOk);
    el.addEventListener("error", onErr);
  });
}

/** 切り出す時刻。つかみが大事なので冒頭は細かく、残りは均等に */
export function planTimes(duration: number, max = MAX_FRAMES): number[] {
  const end = Math.max(duration - 0.1, 0);
  const set = new Set<number>();
  const add = (t: number) => set.add(Math.round(Math.min(Math.max(t, 0), end) * 10) / 10);
  add(0.1);
  if (duration > 2) add(1);
  const step = Math.max(1, duration / (max - 2));
  for (let t = step; t < end; t += step) add(t);
  add(end);
  const times = [...set].sort((a, b) => a - b);
  if (times.length <= max) return times;
  // 念のため上限を超えたら均等に間引く
  return Array.from({ length: max }, (_, i) => times[Math.round((i * (times.length - 1)) / (max - 1))]);
}

export async function extractFrames(file: File, onProgress: (done: number, total: number) => void): Promise<FrameSet> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await waitFor(video, "loadedmetadata");
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) throw new FrameError("動画の長さを読み取れませんでした。");

    // iPhoneのSafariは一度再生を始めないと画面を描けないことがあるため、再生してすぐ止める
    try {
      await video.play();
      video.pause();
    } catch {
      /* 自動再生できなくても seek で描ける環境が多いので続行 */
    }
    if (video.readyState < 2) await waitFor(video, "loadeddata");

    const scale = Math.min(1, LONG_SIDE / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new FrameError("画像の処理に失敗しました。");

    const times = planTimes(duration);
    const frames: Frame[] = [];
    for (const [i, t] of times.entries()) {
      if (Math.abs(video.currentTime - t) > 0.01) {
        const seeked = waitFor(video, "seeked");
        video.currentTime = t;
        await seeked;
      }
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      frames.push({ time: t, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
      onProgress(i + 1, times.length);
    }
    return { duration, width, height, frames };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

/** 履歴用の小さな画像（data URL） */
export function smallImage(frame: Frame, width = 160): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = Math.round((img.height / img.width) * width);
      c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => resolve("");
    img.src = `data:image/jpeg;base64,${frame.base64}`;
  });
}

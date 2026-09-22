// 動画の音声を取り出して OpenAI の文字起こし（whisper-1）にかける。
// 送るのは 16kHz モノラルに変換した音声だけで、映像は送らない。

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export class TranscribeError extends Error {}

const RATE = 16000;
const MAX_DECODE_BYTES = 300 * 1024 * 1024; // これより大きい動画は丸ごと読み込まず再生して取り込む

type AudioContextCtor = typeof AudioContext;
const AudioCtx: AudioContextCtor =
  window.AudioContext ?? (window as unknown as { webkitAudioContext: AudioContextCtor }).webkitAudioContext;

/**
 * iPhoneでは「タップした瞬間」にしか音声付きの再生を始められない。
 * そのため提案ボタンのタップ処理の中で同期的に呼び、再生の許可を先に取っておく。
 */
export interface CaptureSession {
  video: HTMLVideoElement;
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  /** 再生許可を取るための「再生→すぐ停止」が終わったら解決する */
  unlocked: Promise<void>;
  dispose(): void;
}

export function prepareCapture(file: File): CaptureSession {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  const ctx = new AudioCtx();
  // 音はスピーカーに出さず、取り込み用の経路だけにつなぐ
  const source = ctx.createMediaElementSource(video);
  void ctx.resume();
  const unlocked = video.play().then(
    () => video.pause(),
    () => {},
  );
  return {
    video,
    ctx,
    source,
    unlocked,
    dispose() {
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      void ctx.close();
    },
  };
}

/** 動画から文字起こし用の WAV を作る。まず高速な一括変換を試し、だめなら再生して取り込む */
export async function extractAudio(
  file: File,
  session: CaptureSession,
  onStatus: (msg: string) => void,
): Promise<Blob> {
  let samples: Float32Array | null = null;
  if (file.size <= MAX_DECODE_BYTES) {
    onStatus("音声を取り出しています…");
    try {
      samples = await decodeWhole(file);
    } catch {
      samples = null; // iPhoneの .mov などは一括変換できないことがある
    }
  }
  if (!samples) samples = await captureRealtime(session, onStatus);

  let peak = 0;
  for (let i = 0; i < samples.length; i += 16) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < 0.005) {
    throw new TranscribeError("動画から音声を取り出せませんでした（無音でした）。「台本を貼り付け」に切り替えてください。");
  }
  return encodeWav(samples, RATE);
}

async function decodeWhole(file: File): Promise<Float32Array> {
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    return await resample(decoded);
  } finally {
    void ctx.close();
  }
}

async function resample(buf: AudioBuffer): Promise<Float32Array> {
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * RATE)), RATE);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}

async function captureRealtime(s: CaptureSession, onStatus: (msg: string) => void): Promise<Float32Array> {
  const { video, ctx, source } = s;
  await s.unlocked; // 許可取りの停止が、これから始める再生を止めてしまわないように
  await ctx.resume();
  if (video.readyState < 1) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadedmetadata", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new TranscribeError("動画の音声を読み込めませんでした。")), { once: true });
    });
  }
  const duration = video.duration;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  proc.onaudioprocess = (e) => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(proc);
  proc.connect(ctx.destination); // 出力は無音（入力を書き写さないため）

  video.currentTime = 0;
  try {
    await video.play();
  } catch {
    source.disconnect();
    proc.disconnect();
    throw new TranscribeError("音声を取り込めませんでした。もう一度「提案を作る」を押すか、「台本を貼り付け」に切り替えてください。");
  }
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const left = Math.max(0, Math.ceil(duration - video.currentTime));
      onStatus(`音声を取り込んでいます…（残り約${left}秒）`);
    }, 500);
    const finish = () => {
      clearInterval(tick);
      clearTimeout(guard);
      resolve();
    };
    const guard = setTimeout(finish, (duration + 10) * 1000);
    video.addEventListener("ended", finish, { once: true });
  });
  video.pause();
  source.disconnect();
  proc.disconnect();

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  const buf = new AudioBuffer({ length: Math.max(1, total), numberOfChannels: 1, sampleRate: ctx.sampleRate });
  buf.copyToChannel(merged, 0);
  return resample(buf);
}

function encodeWav(samples: Float32Array, rate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob: number;
}

export async function transcribe(apiKey: string, wav: Blob): Promise<Segment[]> {
  const form = new FormData();
  form.append("file", wav, "audio.wav");
  form.append("model", "whisper-1");
  form.append("language", "ja");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "segment");

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch {
    throw new TranscribeError("文字起こしサービスに接続できませんでした。通信状態を確認してください。");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = body.error?.code;
    if (res.status === 401) throw new TranscribeError("OpenAI APIキーが正しくありません。設定を確認してください。");
    if (code === "insufficient_quota") throw new TranscribeError("OpenAIのクレジット残高が不足しています。");
    if (res.status === 429) throw new TranscribeError("文字起こしの利用上限に達しました。少し待ってから再度お試しください。");
    if (res.status === 413) throw new TranscribeError("音声が長すぎて文字起こしできません（上限25MB）。");
    throw new TranscribeError(`文字起こしに失敗しました（${res.status}）。${body.error?.message ?? ""}`.trim());
  }
  const json = (await res.json()) as { segments?: WhisperSegment[] };
  // BGMだけの区間で出る「ご視聴ありがとうございました」のような誤認識を除く
  return (json.segments ?? [])
    .filter((s) => s.no_speech_prob < 0.6 && s.text.trim())
    .map((s) => ({ start: round1(s.start), end: round1(s.end), text: s.text.trim() }));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function segmentsToText(segments: Segment[]): string {
  return segments.map((s) => `[${s.start.toFixed(1)}〜${s.end.toFixed(1)}秒] ${s.text}`).join("\n");
}

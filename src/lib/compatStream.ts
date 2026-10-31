import { isTauri } from "@/lib/http";

const STREAM_GATEWAY = "http://127.0.0.1:8097";

/** Start Akflix's rolling hardware-accelerated HLS compatibility pipeline. */
export async function startCompatibilityStream(
  filename: string,
  hash: string,
  audioLanguage = "eng",
  startSeconds = 0
): Promise<string> {
  if (!isTauri()) throw new Error("Compatibility streaming is available in the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const route = await invoke<string>("start_hls_stream", {
    relativePath: `Streaming Cache/${filename}`,
    streamId: hash,
    audioLanguage,
    startSeconds,
  });
  return `${STREAM_GATEWAY}/${route}`;
}

/** Transcode directly from rqbit's seekable localhost stream—no disk buffer gate. */
export async function startCompatibilityStreamUrl(
  inputUrl: string,
  hash: string,
  audioLanguage = "eng",
  startSeconds = 0
): Promise<string> {
  if (!isTauri()) throw new Error("Compatibility streaming is available in the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const route = await invoke<string>("start_hls_url", {
    inputUrl,
    streamId: hash,
    audioLanguage,
    startSeconds,
  });
  return `${STREAM_GATEWAY}/${route}`;
}

/**
 * A remuxed (stream-copy) conversion starts at the keyframe at or before the
 * requested point, up to ~10 s earlier; its route says where (`?start=`).
 * Records that start and how far into the conversion the request is.
 */
export function placeConversion(
  source: { startSeconds: number; landAt?: number },
  url: string,
  requested: number
): void {
  const reported = Number(new URL(url, STREAM_GATEWAY).searchParams.get("start"));
  const start = Number.isFinite(reported) && reported > 0 && reported <= requested ? reported : requested;
  source.startSeconds = start;
  source.landAt = requested - start > 0.05 ? requested - start : undefined;
}

/** End a paused conversion's FFmpeg but keep what it produced. */
export async function releaseCompatibilityStream(hash: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("release_hls_stream", { streamId: hash });
}

export async function stopCompatibilityStream(hash: string): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("stop_hls_stream", { streamId: hash });
}

export async function setCompatibilityStreamPaused(
  hash: string,
  paused: boolean
): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_hls_stream_paused", { streamId: hash, paused });
}

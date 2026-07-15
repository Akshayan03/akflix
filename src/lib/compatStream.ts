import { isTauri } from "@/lib/http";

const STREAM_GATEWAY = "http://127.0.0.1:8097";

/** Start Akflix's rolling hardware-accelerated HLS compatibility pipeline. */
export async function startCompatibilityStream(
  filename: string,
  hash: string,
  audioLanguage = "eng"
): Promise<string> {
  if (!isTauri()) throw new Error("Compatibility streaming is available in the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const route = await invoke<string>("start_hls_stream", {
    relativePath: `Streaming Cache/${filename}`,
    streamId: hash,
    audioLanguage,
  });
  return `${STREAM_GATEWAY}/${route}`;
}

/** Transcode directly from rqbit's seekable localhost stream—no disk buffer gate. */
export async function startCompatibilityStreamUrl(
  inputUrl: string,
  hash: string,
  audioLanguage = "eng"
): Promise<string> {
  if (!isTauri()) throw new Error("Compatibility streaming is available in the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  const route = await invoke<string>("start_hls_url", {
    inputUrl,
    streamId: hash,
    audioLanguage,
  });
  return `${STREAM_GATEWAY}/${route}`;
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

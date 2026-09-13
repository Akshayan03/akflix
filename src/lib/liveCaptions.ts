import { isTauri } from "@/lib/http";
import type { CaptionCue } from "@/lib/manualCaptions";

export async function transcribeCaptionChunk(
  input: string,
  startSeconds: number,
  durationSeconds = 20,
  audioLanguage = "eng"
): Promise<CaptionCue[]> {
  if (!isTauri()) throw new Error("Live captions are available in the Mac app.");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CaptionCue[]>("transcribe_caption_chunk", {
    input,
    startSeconds,
    durationSeconds,
    audioLanguage,
  });
}

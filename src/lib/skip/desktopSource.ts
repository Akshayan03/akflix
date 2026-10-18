/**
 * Skip detection's view of a file on the desktop: the bundled FFmpeg reads
 * its chapters and true duration and decodes stretches of audio
 * (src-tauri skip_media_*).
 */

import { invoke } from "@tauri-apps/api/core";
import type { SkipSourceAdapter } from "./detector";
import { parseFfmetadataChapters, type SkipMarkers } from "./markers";
import { gentleReader } from "./streamReader";

export interface DesktopSkipSource {
  /** Identifies this playback: a read for anything else is stopped when this one starts. */
  owner: string;
  /** What FFmpeg reads: an http(s) URL or media://<relative path>. */
  input: string;
  audioLanguage?: string;
  /** Episodes read audio for fingerprints; anything else only uses named markers. */
  fingerprint: boolean;
  /** The whole file is readable now (a media server, a finished download). */
  available: () => boolean;
  playhead: () => number;
  /** The player's duration (may be a catalog estimate); the file's own wins once probed. */
  duration: () => number;
  known?: (signal: AbortSignal) => Promise<SkipMarkers>;
}

export interface DesktopSkipReader {
  adapter: SkipSourceAdapter;
  /** The file's own duration once probed, else the player's. */
  duration: () => number;
}

function toPcm(response: unknown): Int16Array {
  const buffer =
    response instanceof ArrayBuffer
      ? response
      : ArrayBuffer.isView(response)
        ? response.buffer.slice(response.byteOffset, response.byteOffset + response.byteLength)
        : Array.isArray(response)
          ? Uint8Array.from(response as number[]).buffer
          : new ArrayBuffer(0);
  return new Int16Array(buffer.slice(0, buffer.byteLength - (buffer.byteLength % 2)));
}

export function desktopSkipReader(source: DesktopSkipSource): DesktopSkipReader {
  let probed = 0;
  const duration = () => probed || source.duration();
  const adapter: SkipSourceAdapter = {
    chapters: async () => {
      const probe = await invoke<{ metadata: string; duration: number }>("skip_media_probe", { input: source.input });
      if (probe.duration > 0) probed = probe.duration;
      return parseFfmetadataChapters(probe.metadata);
    },
    known: source.known,
    pcm: source.fingerprint
      ? gentleReader({
          read: async (start, seconds) =>
            toPcm(
              await invoke("skip_media_pcm", {
                owner: source.owner,
                input: source.input,
                startSeconds: start,
                durationSeconds: seconds,
                audioLanguage: source.audioLanguage ?? null,
              })
            ),
          playhead: source.playhead,
          duration,
          available: source.available,
        })
      : undefined,
    cancel: () => void invoke("skip_media_cancel", { owner: source.owner }).catch(() => {}),
  };
  return { adapter, duration };
}

import type { TorrentResult } from "@/types/torrent";

function sourceText(result: TorrentResult): string {
  let link = result.magnetUrl ?? result.downloadUrl ?? "";
  try {
    link = decodeURIComponent(link);
  } catch {
    // The release title still gives us a useful compatibility signal.
  }
  return `${result.title} ${result.category ?? ""} ${link}`.toLowerCase();
}

export function isIosNativeSource(result: TorrentResult): boolean {
  if (result.streamUrl) return true;
  const text = sourceText(result);
  const nativeContainer = /\.(mp4|m4v|mov)(?:\b|$)/i.test(text);
  const unsupportedContainer = /\.(mkv|webm|avi|wmv|flv)(?:\b|$)/i.test(text);
  const unsupportedCodec = /\b(av1|vp9|xvid|divx)\b/i.test(text);
  const nativeCodec = /\b(h\.?264|x264|avc|h\.?265|x265|hevc)\b/i.test(text);
  if (unsupportedContainer || unsupportedCodec) return false;
  return nativeContainer && nativeCodec;
}

export function iosNativeSources(results: TorrentResult[]): TorrentResult[] {
  return results.filter(isIosNativeSource);
}

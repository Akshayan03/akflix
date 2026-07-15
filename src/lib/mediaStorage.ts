import { isTauri } from "@/lib/http";

/** Free bytes on the volume that holds Akflix's embedded media cache. */
export async function availableMediaStorage(): Promise<number | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<number>("available_media_storage");
  } catch {
    return null;
  }
}

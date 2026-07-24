import { isTauri } from "@/lib/http";

export interface MediaStorageStatus {
  /** Configured location. This becomes active after a restart. */
  path: string;
  /** Location used by the currently running media engine. */
  activePath: string;
  available: boolean;
  activeAvailable: boolean;
  writable: boolean;
  freeBytes: number | null;
  activeFreeBytes: number | null;
  usingExternal: boolean;
  usingDefault: boolean;
  restartRequired: boolean;
  engineRunning: boolean;
  volumeName: string | null;
}

async function invokeStorage<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

export async function getMediaStorageStatus(): Promise<MediaStorageStatus | null> {
  if (!isTauri()) return null;
  return invokeStorage<MediaStorageStatus>("media_storage_status");
}

export async function configureMediaStorage(selectedPath: string): Promise<MediaStorageStatus> {
  return invokeStorage<MediaStorageStatus>("configure_media_storage", { selectedPath });
}

export async function resetMediaStorage(): Promise<MediaStorageStatus> {
  return invokeStorage<MediaStorageStatus>("reset_media_storage");
}

/**
 * Confirm the selected drive is available before source racing or playback.
 * A pending storage change also stops new writes until Akflix restarts.
 */
export async function requireMediaStorage(): Promise<MediaStorageStatus | null> {
  const status = await getMediaStorageStatus();
  if (!status) return null;
  if (status.restartRequired) {
    throw new Error("Restart Akflix to finish changing the media storage location.");
  }
  if (!status.activeAvailable || !status.writable) {
    const drive = status.volumeName ?? "The selected storage drive";
    throw new Error(`${drive} is disconnected or read-only. Reconnect it before streaming.`);
  }
  if (!status.engineRunning) {
    throw new Error("The media drive is connected again. Restart Akflix to restart the playback engine.");
  }
  return status;
}

/** Free bytes on the volume that holds Akflix's embedded media cache. */
export async function availableMediaStorage(): Promise<number | null> {
  if (!isTauri()) return null;
  const status = await requireMediaStorage();
  return status?.activeFreeBytes ?? null;
}

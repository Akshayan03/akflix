/**
 * Desktop (Tauri-only) integrations, all lazily imported so the plain web
 * build never loads them:
 *   - deep links:  magnet: URLs and .torrent files opened with Akflix
 *   - updater:     check/download/install via the Tauri Updater plugin
 */

import { toast } from "sonner";
import { isTauri } from "@/lib/http";
import { useTorrents } from "@/stores/torrentStore";

/**
 * Handle magnet links / files the OS hands us. Adds the magnet to
 * qBittorrent as an offline download and routes the user to Downloads.
 */
export async function initDeepLinks(navigate: (path: string) => void): Promise<void> {
  if (!isTauri()) return;
  try {
    const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");

    const handle = async (urls: string[] | null) => {
      for (const url of urls ?? []) {
        if (url.startsWith("magnet:")) {
          try {
            await useTorrents.getState().addMagnet(url, "download");
            toast.success("Magnet added to downloads");
            navigate("/downloads");
          } catch (e) {
            toast.error("Could not add magnet", {
              description: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    };

    await handle(await getCurrent()); // link that launched the app (cold start)
    await onOpenUrl(handle); // links while running
  } catch {
    // Plugin not available (e.g. dev without the Rust side) — ignore.
  }
}

export interface UpdateStatus {
  available: boolean;
  version?: string;
  notes?: string;
}

/** Check GitHub releases for a newer version. Desktop only. */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!isTauri()) return { available: false };
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return { available: false };
  return { available: true, version: update.version, notes: update.body ?? undefined };
}

/** Download + install the pending update, then relaunch. */
export async function installUpdate(): Promise<void> {
  const { check } = await import("@tauri-apps/plugin-updater");
  const { relaunch } = await import("@tauri-apps/plugin-process");
  const update = await check();
  if (!update) return;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      // Progress is surfaced via a persistent toast from the caller if needed.
      void downloaded;
    }
  });
  await relaunch();
}

/** Silent startup check: shows a toast offering to install if one exists. */
export async function checkForUpdatesQuietly(): Promise<void> {
  try {
    const status = await checkForUpdates();
    if (status.available) {
      toast("Update available", {
        description: `Akflix ${status.version} is ready to install.`,
        action: {
          label: "Install",
          onClick: () => {
            toast.promise(installUpdate(), {
              loading: "Downloading update…",
              success: "Restarting…",
              error: "Update failed",
            });
          },
        },
        duration: 15_000,
      });
    }
  } catch {
    // Offline or updater not configured — never bother the user about it.
  }
}

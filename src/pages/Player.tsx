/**
 * /play/:itemId — thin route shim over the persistent <PlayerHost/>.
 *
 * Mounting this route asks the global playback engine to load the item and
 * switch to the expanded (full-screen) view. Navigating away does NOT stop
 * playback — it minimizes into the MiniPlayer bar. Use the bar's ✕ to stop.
 */

import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { usePlayback } from "@/stores/playbackStore";

export default function Player() {
  const { itemId } = useParams<{ itemId: string }>();
  const open = usePlayback((s) => s.open);
  const expand = usePlayback((s) => s.expand);
  const minimize = usePlayback((s) => s.minimize);

  useEffect(() => {
    if (!itemId) return;
    const current = usePlayback.getState().session;
    // Same item already loaded (e.g. expanding the mini player) → just expand.
    if (current?.itemId === itemId) expand();
    else open(itemId);
    return () => minimize();
  }, [itemId, open, expand, minimize]);

  // PlayerHost renders the actual surface above everything.
  return <div className="min-h-screen bg-black" />;
}

/** Full-screen route shim for a temporary local torrent stream. */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { usePlayback } from "@/stores/playbackStore";

export default function DirectPlayer() {
  const navigate = useNavigate();
  const expand = usePlayback((state) => state.expand);
  const minimize = usePlayback((state) => state.minimize);
  const direct = usePlayback((state) => state.requestedDirect);

  useEffect(() => {
    if (!direct) {
      navigate("/", { replace: true });
      return;
    }
    expand();
    return () => minimize();
  }, [direct, expand, minimize, navigate]);

  return <div className="min-h-screen bg-black" />;
}

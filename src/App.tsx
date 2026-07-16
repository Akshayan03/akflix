import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "sonner";
import { useAuth } from "@/stores/authStore";
import { initDeepLinks, checkForUpdatesQuietly } from "@/lib/desktop";
import Navbar from "@/components/Navbar";
import PlayerHost from "@/components/PlayerHost";
import Login from "@/pages/Login";
import Home from "@/pages/Home";
import Search from "@/pages/Search";
import Details from "@/pages/Details";
import Player from "@/pages/Player";
import Downloads from "@/pages/Downloads";
import Settings from "@/pages/Settings";
import DiscoverDetails from "@/pages/DiscoverDetails";
import StreamController from "@/components/StreamController";
import DirectPlayer from "@/pages/DirectPlayer";
import Browse from "@/pages/Browse";
import { isAppleMobile } from "@/lib/platform";

/** Routes that need an active Jellyfin session redirect to /login. */
function RequireAuth({ children }: { children: JSX.Element }) {
  const active = useAuth((s) => s.activeProfileId);
  return active ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const mobileApple = isAppleMobile();
  const isPlayer = location.pathname.startsWith("/play") || location.pathname === "/stream";
  const isLogin = location.pathname === "/login";

  // Desktop-only integrations (no-ops in the browser).
  useEffect(() => {
    useAuth.getState().ensureLocalProfile();
    initDeepLinks(navigate);
    if (!mobileApple) checkForUpdatesQuietly();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route changes should always start at the top. This is especially
  // important on iOS, where dismissing the keyboard can leave the WebView
  // with a temporary scroll offset that otherwise carries into the next page.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [location.pathname]);

  const routes = (
    <Routes location={location}>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/movies" element={<RequireAuth><Browse type="movie" /></RequireAuth>} />
      <Route path="/shows" element={<RequireAuth><Browse type="series" /></RequireAuth>} />
      <Route path="/search" element={<RequireAuth><Search /></RequireAuth>} />
      <Route path="/title/:itemId" element={<RequireAuth><Details /></RequireAuth>} />
      <Route path="/discover/:type/:imdbId" element={<RequireAuth><DiscoverDetails /></RequireAuth>} />
      <Route path="/play/:itemId" element={<RequireAuth><Player /></RequireAuth>} />
      <Route path="/stream" element={<RequireAuth><DirectPlayer /></RequireAuth>} />
      <Route path="/downloads" element={<RequireAuth><Downloads /></RequireAuth>} />
      <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );

  return (
    <div className={mobileApple ? "ios-app-shell min-h-full" : "min-h-full"}>
      {/* The player and login are immersive full-screen pages — no navbar. */}
      {!isPlayer && !isLogin && <Navbar />}

      {/* Pages animate their own entrances (motion initial/animate).
          NOTE: deliberately NOT wrapped in <AnimatePresence mode="wait"> —
          exit-gated routing wedges when the outgoing page re-renders during
          its exit (e.g. Downloads' 2s torrent polling), leaving the app stuck
          on the old route. Entrance animations don't have that failure mode. */}
      {mobileApple && !isPlayer ? (
        <AnimatePresence initial={false} mode="sync">
          <motion.div
            key={location.key}
            initial={{ opacity: 0, x: 14, filter: "blur(3px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, x: -10, filter: "blur(2px)" }}
            transition={{ type: "spring", stiffness: 330, damping: 31, mass: 0.72 }}
            className="min-h-[100svh]"
          >
            {routes}
          </motion.div>
        </AnimatePresence>
      ) : routes}

      {/* Persistent playback engine: fullscreen player, PiP + mini bar. */}
      <PlayerHost />

      {/* Global Torrentio temporary-cache handoff and buffering status. */}
      {!isLogin && !mobileApple && <StreamController />}

      {/* Toast notifications (Sonner), styled for the dark theme. */}
      <Toaster
        theme="dark"
        position={mobileApple ? "bottom-center" : "bottom-right"}
        offset={{ bottom: mobileApple ? 104 : 96 }}
        toastOptions={{
          style: {
            background: "rgba(21,19,15,.96)",
            border: "1px solid rgba(255,255,255,.1)",
            color: "#fff",
            borderRadius: "16px",
            backdropFilter: "blur(20px)",
          },
        }}
      />
    </div>
  );
}

/**
 * Fixed top navigation — transparent over the hero, fades to black on scroll,
 * exactly like Netflix. Includes profile menu with server switching.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Search, Download, Settings, ChevronDown, Home, RadioTower, Film, Tv, Check } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { isAppleMobile, isDesktopMac } from "@/lib/platform";
import { useT } from "@/i18n";
import Brand from "@/components/Brand";
import MobileNavigation from "@/components/MobileNavigation";

// Under Tauri on macOS the window uses an overlay titlebar: the traffic
// lights float over our navbar, so shift the wordmark right to clear them.
const macOverlayPad =
  isDesktopMac() ? "!pl-[88px] md:!pl-[92px]" : "";

export default function Navbar() {
  const t = useT();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileApple = isAppleMobile();

  const profiles = useAuth((s) => s.profiles);
  const activeId = useAuth((s) => s.activeProfileId);
  const switchProfile = useAuth((s) => s.switchProfile);
  const logout = useAuth((s) => s.logout);
  const active = profiles.find((p) => p.id === activeId);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  if (mobileApple) return <MobileNavigation />;

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition-colors duration-200 ${
      isActive
        ? "bg-white text-black"
        : "text-zinc-400 hover:bg-white/[0.08] hover:text-white"
    }`;
  return (
    <>
    <header
      // data-tauri-drag-region: empty navbar space drags the window (desktop).
      data-tauri-drag-region
      className={`fixed inset-x-0 top-0 z-40 flex h-20 items-center px-5 transition-all duration-300 md:px-8 ${macOverlayPad}`}
    >
      <div
        data-tauri-drag-region
        className={`flex h-14 w-full items-center rounded-2xl border px-3 transition-all md:px-4 ${
          scrolled
            ? "border-white/[0.12] bg-black/85 shadow-[0_14px_45px_rgba(0,0,0,.5)] backdrop-blur-2xl"
            : "border-white/[0.08] bg-black/25 backdrop-blur-md"
        }`}
      >
      <Link to="/" aria-label="Akflix home" className="mr-6 rounded-md px-1 py-1 text-white"><Brand height={19} /></Link>

      <nav className="hidden items-center gap-1 md:flex">
        <NavLink to="/" className={linkCls} end>
          <Home size={14} /> {t("nav.home")}
        </NavLink>
        <NavLink to="/movies" className={linkCls}>
          <Film size={14} /> Movies
        </NavLink>
        <NavLink to="/shows" className={linkCls}>
          <Tv size={14} /> Shows
        </NavLink>
        <NavLink to="/downloads" className={linkCls}>
          <RadioTower size={14} /> Activity
        </NavLink>
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label={t("nav.search")}
          onClick={() => navigate("/search")}
          className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white"
        >
          <Search size={20} />
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label={t("nav.downloads")}
          onClick={() => navigate("/downloads")}
          className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white md:hidden"
        >
          <Download size={20} />
        </motion.button>
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label={t("nav.settings")}
          onClick={() => navigate("/settings")}
          className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white"
        >
          <Settings size={20} />
        </motion.button>

        {/* Profile menu */}
        <div ref={menuRef} className="relative">
          <motion.button
            whileTap={{ scale: 0.96 }}
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`Profile: ${active?.userName ?? "not signed in"}`}
            className="ml-1 flex items-center gap-2 rounded-xl p-1 text-sm text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white font-bold uppercase text-black">
              {active?.userName?.[0] ?? "?"}
            </span>
            <ChevronDown size={14} className={`transition-transform duration-200 ${menuOpen ? "rotate-180" : ""}`} />
          </motion.button>

          <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -5, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              role="menu"
              className="glass-panel absolute right-0 mt-3 w-60 overflow-hidden rounded-2xl p-1.5 shadow-2xl"
            >
              {profiles.map((p) => (
                <button
                  key={p.id}
                  role="menuitem"
                  onClick={() => {
                    switchProfile(p.id);
                    setMenuOpen(false);
                    navigate("/");
                  }}
                  aria-current={p.id === activeId ? "true" : undefined}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/[0.08] ${
                    p.id === activeId ? "text-white" : "text-zinc-300"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{p.userName}</span>
                    <span className="block truncate text-xs text-zinc-500">
                      {p.serverName ?? p.serverUrl}
                    </span>
                  </span>
                  {p.id === activeId && <Check size={15} aria-hidden="true" />}
                </button>
              ))}
              <div className="mt-1 border-t border-white/[0.07] pt-1">
                <button
                  role="menuitem"
                  onClick={() => {
                    logout();
                    navigate("/login");
                  }}
                  className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/[0.07]"
                >
                  {t("nav.logout")}
                </button>
              </div>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </div>
      </div>
    </header>
    </>
  );
}

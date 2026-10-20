/**
 * Fixed top navigation: transparent over artwork, a solid black bar once the
 * page scrolls. Includes the profile menu with server switching.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Search, Settings, ChevronDown, Check } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useTorrents } from "@/stores/torrentStore";
import { isAppleMobile, isDesktopMac } from "@/lib/platform";
import { useT } from "@/i18n";
import Brand from "@/components/Brand";
import MobileNavigation from "@/components/MobileNavigation";

export default function Navbar() {
  const t = useT();
  const navigate = useNavigate();
  const onSearch = useLocation().pathname === "/search";
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const mobileApple = isAppleMobile();

  const profiles = useAuth((s) => s.profiles);
  const activeId = useAuth((s) => s.activeProfileId);
  const switchProfile = useAuth((s) => s.switchProfile);
  const logout = useAuth((s) => s.logout);
  const active = profiles.find((p) => p.id === activeId);
  // Unfinished transfers reported by the engine (never an estimate).
  const transfers = useTorrents((s) => s.torrents.filter((torrent) => torrent.progress < 1).length);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K / Ctrl+K opens search from anywhere outside a text field.
  useEffect(() => {
    if (mobileApple) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      navigate("/search");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileApple, navigate]);

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

  const shortcut = /Mac/i.test(navigator.userAgent) ? "⌘K" : "Ctrl K";
  const links = [
    { to: "/", label: t("nav.home"), end: true },
    { to: "/movies", label: "Movies", end: false },
    { to: "/shows", label: "Shows", end: false },
    { to: "/new", label: "What's New", end: false },
    { to: "/downloads", label: t("nav.downloads"), end: false },
  ];

  return (
    <header
      // data-tauri-drag-region: empty header space drags the window (desktop).
      data-tauri-drag-region
      data-scrolled={scrolled}
      className={`ak-nav fixed inset-x-0 top-0 z-40 flex items-center gap-5 lg:gap-8 ${isDesktopMac() ? "ak-nav--mac" : ""}`}
    >
      <Link to="/" aria-label="Akflix home" className="shrink-0 rounded-md py-1 text-white">
        <Brand height={18} />
      </Link>

      <nav aria-label="Primary" className="flex items-center gap-0.5">
        {links.map((link) => (
          <NavLink key={link.to} to={link.to} end={link.end} className="ak-nav-link">
            {({ isActive }) => (
              <>
                {link.label}
                {link.to === "/downloads" && transfers > 0 && (
                  <span
                    className="ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-white px-1 text-[10px] font-bold tabular-nums text-black"
                    aria-label={`${transfers} active`}
                  >
                    {transfers}
                  </span>
                )}
                {isActive && (
                  <motion.span
                    layoutId="ak-nav-indicator"
                    className="ak-nav-indicator"
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  />
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigate("/search")}
          aria-label={t("nav.search")}
          aria-keyshortcuts="Meta+K Control+K"
          aria-current={onSearch ? "page" : undefined}
          className={`group mr-1 flex h-9 items-center gap-2 rounded-full border pl-3 pr-2 transition-colors duration-150 hover:border-white/40 hover:text-white ${
            onSearch ? "border-white/50 bg-white/[0.08] text-white" : "border-white/[0.14] bg-white/[0.04] text-zinc-400"
          }`}
        >
          <Search size={16} aria-hidden="true" />
          <span className="hidden pr-6 text-xs font-medium lg:inline">{t("nav.search")}</span>
          <kbd className="hidden rounded-md border border-white/[0.14] px-1.5 py-0.5 font-sans text-[10px] font-semibold text-zinc-400 lg:inline">
            {shortcut}
          </kbd>
        </button>
        <NavLink
          to="/settings"
          aria-label={t("nav.settings")}
          className={({ isActive }) => `ak-icon-button ${isActive ? "bg-white/10 !text-white" : ""}`}
        >
          <Settings size={18} />
        </NavLink>

        {/* Profile menu */}
        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`Profile: ${active?.userName ?? "not signed in"}`}
            className="ml-1 flex items-center gap-1.5 rounded-full p-1 pr-2 text-zinc-300 transition-colors duration-150 hover:bg-white/[0.08] hover:text-white"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-xs font-bold uppercase text-black">
              {active?.userName?.[0] ?? "?"}
            </span>
            <ChevronDown size={14} className={`transition-transform duration-150 ${menuOpen ? "rotate-180" : ""}`} />
          </button>

          <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
              role="menu"
              className="glass-panel absolute right-0 mt-2 w-60 origin-top-right overflow-hidden rounded-2xl p-1.5"
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
    </header>
  );
}

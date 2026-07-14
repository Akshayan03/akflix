/**
 * Fixed top navigation — transparent over the hero, fades to black on scroll,
 * exactly like Netflix. Includes profile menu with server switching.
 */

import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Search, Download, Settings, ChevronDown } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { isTauri } from "@/lib/http";
import { useT } from "@/i18n";

// Under Tauri on macOS the window uses an overlay titlebar: the traffic
// lights float over our navbar, so shift the wordmark right to clear them.
const macOverlayPad =
  isTauri() && navigator.userAgent.includes("Mac") ? "pl-[84px]" : "";

export default function Navbar() {
  const t = useT();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `text-sm transition-colors ${
      isActive ? "font-semibold text-white" : "text-zinc-300 hover:text-white"
    }`;

  return (
    <header
      // data-tauri-drag-region: empty navbar space drags the window (desktop).
      data-tauri-drag-region
      className={`fixed inset-x-0 top-0 z-40 flex h-16 items-center gap-8 px-6 transition-colors duration-300 md:px-12 ${macOverlayPad} ${
        scrolled
          ? "bg-surface/95 backdrop-blur"
          : "bg-gradient-to-b from-black/70 to-transparent"
      }`}
    >
      {/* Wordmark */}
      <Link to="/" className="select-none text-2xl font-extrabold tracking-tight text-brand">
        AKFLIX
      </Link>

      <nav className="hidden items-center gap-6 md:flex">
        <NavLink to="/" className={linkCls} end>
          {t("nav.home")}
        </NavLink>
        <NavLink to="/downloads" className={linkCls}>
          {t("nav.downloads")}
        </NavLink>
      </nav>

      <div className="ml-auto flex items-center gap-5">
        <button
          aria-label={t("nav.search")}
          onClick={() => navigate("/search")}
          className="text-zinc-300 transition hover:text-white"
        >
          <Search size={20} />
        </button>
        <button
          aria-label={t("nav.downloads")}
          onClick={() => navigate("/downloads")}
          className="text-zinc-300 transition hover:text-white md:hidden"
        >
          <Download size={20} />
        </button>
        <button
          aria-label={t("nav.settings")}
          onClick={() => navigate("/settings")}
          className="text-zinc-300 transition hover:text-white"
        >
          <Settings size={20} />
        </button>

        {/* Profile menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex items-center gap-2 text-sm text-zinc-200 hover:text-white"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded bg-brand font-bold uppercase">
              {active?.userName?.[0] ?? "?"}
            </span>
            <ChevronDown size={14} className={menuOpen ? "rotate-180" : ""} />
          </button>

          {menuOpen && (
            <div
              className="absolute right-0 mt-2 w-56 overflow-hidden rounded-md border border-zinc-800 bg-surface-raised shadow-xl"
              onMouseLeave={() => setMenuOpen(false)}
            >
              {profiles.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    switchProfile(p.id);
                    setMenuOpen(false);
                    navigate("/");
                  }}
                  className={`block w-full px-4 py-2.5 text-left text-sm hover:bg-white/10 ${
                    p.id === activeId ? "text-white" : "text-zinc-300"
                  }`}
                >
                  <span className="font-medium">{p.userName}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {p.serverName ?? p.serverUrl}
                  </span>
                </button>
              ))}
              <div className="border-t border-zinc-800">
                <button
                  onClick={() => {
                    logout();
                    navigate("/login");
                  }}
                  className="block w-full px-4 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/10"
                >
                  {t("nav.logout")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

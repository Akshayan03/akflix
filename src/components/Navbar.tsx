/**
 * Fixed top navigation — transparent over the hero, fades to black on scroll,
 * exactly like Netflix. Includes profile menu with server switching.
 */

import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { Search, Download, Settings, ChevronDown, Home, RadioTower, Film, Tv } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { isAppleMobile, isDesktopMac } from "@/lib/platform";
import { useT } from "@/i18n";
import Brand from "@/components/Brand";

// Under Tauri on macOS the window uses an overlay titlebar: the traffic
// lights float over our navbar, so shift the wordmark right to clear them.
const macOverlayPad =
  isDesktopMac() ? "!pl-[88px] md:!pl-[92px]" : "";

export default function Navbar() {
  const t = useT();
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
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

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold transition ${
      isActive
        ? "bg-white/[0.10] text-white shadow-inner shadow-white/[0.04]"
        : "text-zinc-400 hover:bg-white/[0.05] hover:text-white"
    }`;
  const mobileLinkCls = ({ isActive }: { isActive: boolean }) =>
    `flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-2 text-[10px] font-semibold transition ${
      isActive ? "bg-brand/12 text-brand-light" : "text-zinc-500"
    }`;

  return (
    <>
    <header
      // data-tauri-drag-region: empty navbar space drags the window (desktop).
      data-tauri-drag-region
      className={`fixed inset-x-0 top-0 z-40 flex h-20 items-center px-5 transition-all duration-300 md:px-8 ${macOverlayPad} ${mobileApple ? "ios-safe-top" : ""}`}
    >
      <div className={`flex h-14 w-full items-center rounded-2xl border px-3 transition-all md:px-4 ${
        scrolled
          ? "border-white/10 bg-[#0b0a08]/88 shadow-[0_14px_45px_rgba(0,0,0,.4)] backdrop-blur-2xl"
          : "border-white/[0.07] bg-black/20 backdrop-blur-md"
      }`}>
      <Link to="/" className="mr-5"><Brand /></Link>

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
        {!mobileApple && (
          <NavLink to="/downloads" className={linkCls}>
            <RadioTower size={14} /> Activity
          </NavLink>
        )}
      </nav>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          aria-label={t("nav.search")}
          onClick={() => navigate("/search")}
          className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white"
        >
          <Search size={20} />
        </button>
        {!mobileApple && (
          <button
            aria-label={t("nav.downloads")}
            onClick={() => navigate("/downloads")}
            className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white md:hidden"
          >
            <Download size={20} />
          </button>
        )}
        <button
          aria-label={t("nav.settings")}
          onClick={() => navigate("/settings")}
          className="rounded-xl p-2.5 text-zinc-400 transition hover:bg-white/[0.07] hover:text-white"
        >
          <Settings size={20} />
        </button>

        {/* Profile menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="ml-1 flex items-center gap-2 rounded-xl p-1 text-sm text-zinc-200 transition hover:bg-white/[0.06] hover:text-white"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand-light via-brand to-brand-dark font-bold uppercase text-[#090806] shadow-[0_0_20px_rgba(214,178,94,.18)]">
              {active?.userName?.[0] ?? "?"}
            </span>
            <ChevronDown size={14} className={menuOpen ? "rotate-180" : ""} />
          </button>

          {menuOpen && (
            <div
              className="glass-panel absolute right-0 mt-3 w-60 overflow-hidden rounded-2xl p-1.5 shadow-2xl"
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
                  className={`block w-full rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/[0.07] ${
                    p.id === activeId ? "text-white" : "text-zinc-300"
                  }`}
                >
                  <span className="font-medium">{p.userName}</span>
                  <span className="block truncate text-xs text-zinc-500">
                    {p.serverName ?? p.serverUrl}
                  </span>
                </button>
              ))}
              <div className="mt-1 border-t border-white/[0.07] pt-1">
                <button
                  onClick={() => {
                    logout();
                    navigate("/login");
                  }}
                  className="block w-full rounded-xl px-3 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/[0.07]"
                >
                  {t("nav.logout")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      </div>
    </header>
    {mobileApple && (
      <nav className="ios-bottom-nav glass-panel fixed inset-x-3 z-40 flex items-center gap-1 rounded-[22px] p-1.5 md:hidden" aria-label="iPhone navigation">
        <NavLink to="/" className={mobileLinkCls} end>
          <Home size={18} /> Home
        </NavLink>
        <NavLink to="/movies" className={mobileLinkCls}>
          <Film size={18} /> Movies
        </NavLink>
        <NavLink to="/shows" className={mobileLinkCls}>
          <Tv size={18} /> Shows
        </NavLink>
        <NavLink to="/search" className={mobileLinkCls}>
          <Search size={18} /> Search
        </NavLink>
      </nav>
    )}
    </>
  );
}

import { motion } from "framer-motion";
import { Film, Home, Search, Tv, UserRound } from "lucide-react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import Brand from "@/components/Brand";
import { useAuth } from "@/stores/authStore";

const tabs = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/movies", label: "Movies", icon: Film },
  { to: "/shows", label: "Shows", icon: Tv },
  { to: "/search", label: "Search", icon: Search },
  { to: "/settings", label: "Profile", icon: UserRound },
] as const;

const pageTitle = (path: string) => {
  if (path === "/movies") return "Movies";
  if (path === "/shows") return "Shows";
  if (path === "/search") return "Search";
  if (path === "/settings") return "Profile";
  return null;
};

export default function MobileNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const profiles = useAuth((state) => state.profiles);
  const activeId = useAuth((state) => state.activeProfileId);
  const active = profiles.find((profile) => profile.id === activeId);
  const title = pageTitle(location.pathname);
  const isDetail = location.pathname.startsWith("/discover/") || location.pathname.startsWith("/title/");

  return (
    <>
      <motion.header
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 340, damping: 30 }}
        className="ios-mobile-header fixed inset-x-0 top-0 z-40"
      >
        <div className="flex h-14 items-center px-4">
          {isDetail ? (
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => navigate(-1)}
              aria-label="Go back"
              className="ios-circle-button text-xl"
            >
              ‹
            </motion.button>
          ) : title ? (
            <motion.h1
              key={title}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className="text-[22px] font-black tracking-[-0.04em]"
            >
              {title}
            </motion.h1>
          ) : (
            <Brand className="[&_svg]:!h-8 [&_svg]:!w-8 [&_span]:!text-[16px]" />
          )}

          <div className="ml-auto flex items-center gap-2">
            {location.pathname === "/" && (
              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={() => navigate("/search")}
                aria-label="Search"
                className="ios-circle-button"
              >
                <Search size={18} />
              </motion.button>
            )}
            <motion.button
              whileTap={{ scale: 0.92 }}
              onClick={() => navigate("/settings")}
              aria-label="Open profile and settings"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-brand-light to-brand text-sm font-black uppercase text-[#090806] shadow-[0_8px_24px_rgba(214,178,94,.22)] ring-1 ring-white/20"
            >
              {active?.userName?.[0] ?? "A"}
            </motion.button>
          </div>
        </div>
      </motion.header>

      <nav className="ios-tab-bar fixed inset-x-2 z-40 grid grid-cols-5" aria-label="Primary navigation">
        {tabs.map(({ to, label, icon: Icon, ...tab }) => (
          <NavLink
            key={to}
            to={to}
            end={"end" in tab ? tab.end : undefined}
            className="relative flex min-w-0 flex-col items-center justify-center gap-1 py-2 text-[10px] font-semibold"
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.span
                    layoutId="ios-active-tab"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    className="absolute inset-x-2 inset-y-1 rounded-2xl bg-brand/[0.12] ring-1 ring-brand/10"
                  />
                )}
                <motion.span
                  whileTap={{ scale: 0.82 }}
                  animate={{ y: isActive ? -1 : 0 }}
                  className={`relative z-10 ${isActive ? "text-brand-light" : "text-zinc-500"}`}
                >
                  <Icon size={19} strokeWidth={isActive ? 2.5 : 2} />
                </motion.span>
                <span className={`relative z-10 truncate ${isActive ? "text-brand-light" : "text-zinc-500"}`}>
                  {label}
                </span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

/**
 * Full-bleed library hero: backdrop, gradient wash, title/overview and
 * Play / More info actions.
 */

import { useNavigate } from "react-router-dom";
import { Play, Info } from "lucide-react";
import { useAuth } from "@/stores/authStore";
import { useT } from "@/i18n";
import { formatRuntime } from "@/lib/utils";
import type { BaseItem } from "@/types/jellyfin";
import Artwork from "@/components/Artwork";

export default function HeroBanner({ item }: { item: BaseItem }) {
  const t = useT();
  const navigate = useNavigate();
  const client = useAuth((s) => s.client)();
  if (!client) return null;

  const backdrop = client.imageUrl(item, "Backdrop", 1920);
  const primary = client.imageUrl(item, "Primary", 900);
  const inProgress = (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

  return (
    <section aria-label={`From your library: ${item.Name}`} className="editorial-hero relative h-[min(80vh,860px)] min-h-[540px] w-full overflow-hidden">
      <div key={item.Id} className="ak-backdrop-in absolute inset-0">
        <Artwork
          src={backdrop ?? primary}
          title={item.Name}
          variant="backdrop"
          className="h-full w-full object-cover object-[center_22%]"
          draggable={false}
        />
      </div>
      <div className="absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-black/60 to-transparent" />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.86)_0%,rgba(0,0,0,.5)_34%,rgba(0,0,0,0)_66%)]" />
      <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-surface via-surface/60 to-transparent" />

      <div className="ak-gutter absolute inset-x-0 bottom-[clamp(104px,15vh,156px)]">
        <div key={`${item.Id}-copy`} className="ak-rise-in max-w-[660px]">
          <p className="ak-eyebrow mb-4 !text-zinc-200">From your library</p>
          <h1 className="hero-shadow">{item.Name}</h1>

          <div className="ak-meta mt-4">
            {item.CommunityRating && (
              <span className="font-semibold text-white">★ {item.CommunityRating.toFixed(1)}</span>
            )}
            {item.ProductionYear && <span>{item.ProductionYear}</span>}
            {item.OfficialRating && <span>{item.OfficialRating}</span>}
            {item.RunTimeTicks && <span>{formatRuntime(item.RunTimeTicks)}</span>}
          </div>

          {item.Overview && (
            <p className="mt-4 line-clamp-3 max-w-[580px] text-[15px] leading-[1.6] text-zinc-300">
              {item.Overview}
            </p>
          )}

          <div className="mt-6 flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(`/play/${item.Id}`)}
              className="desktop-control desktop-primary"
            >
              <Play size={17} fill="currentColor" aria-hidden="true" />
              {inProgress ? t("hero.resume") : t("hero.play")}
            </button>
            <button
              type="button"
              onClick={() => navigate(`/title/${item.Id}`)}
              className="desktop-control desktop-secondary"
            >
              <Info size={17} aria-hidden="true" />
              {t("hero.moreInfo")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

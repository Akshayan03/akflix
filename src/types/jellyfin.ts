/**
 * Minimal Jellyfin API types — only the fields Akflix actually consumes.
 * Full reference: https://api.jellyfin.org/
 */

export interface JellyfinUser {
  Id: string;
  Name: string;
  PrimaryImageTag?: string;
  Policy?: { IsAdministrator?: boolean };
}

export interface AuthResponse {
  User: JellyfinUser;
  AccessToken: string;
  ServerId: string;
}

export interface UserItemData {
  PlaybackPositionTicks: number;
  PlayedPercentage?: number;
  Played: boolean;
  IsFavorite: boolean;
  UnplayedItemCount?: number;
}

export interface MediaStream {
  Index: number;
  Type: "Video" | "Audio" | "Subtitle" | "EmbeddedImage";
  Codec?: string;
  Language?: string;
  DisplayTitle?: string;
  IsDefault?: boolean;
  IsExternal?: boolean;
  DeliveryUrl?: string;
  DeliveryMethod?: "Encode" | "Embed" | "External" | "Hls";
  IsTextSubtitleStream?: boolean;
}

export interface MediaSource {
  Id: string;
  Container?: string;
  SupportsDirectPlay: boolean;
  SupportsDirectStream: boolean;
  SupportsTranscoding: boolean;
  TranscodingUrl?: string;
  MediaStreams?: MediaStream[];
  RunTimeTicks?: number;
}

export interface PlaybackInfoResponse {
  MediaSources: MediaSource[];
  PlaySessionId: string;
  ErrorCode?: string;
}

export interface BaseItem {
  Id: string;
  Name: string;
  /** Server-side media path, requested for torrent-to-library handoff matching. */
  Path?: string;
  Type:
    | "Movie"
    | "Series"
    | "Season"
    | "Episode"
    | "BoxSet"
    | "CollectionFolder"
    | string;
  Overview?: string;
  ProductionYear?: number;
  CommunityRating?: number;
  OfficialRating?: string;
  RunTimeTicks?: number;
  Genres?: string[];
  ImageTags?: Record<string, string>;
  BackdropImageTags?: string[];
  ParentBackdropItemId?: string;
  ParentBackdropImageTags?: string[];
  SeriesId?: string;
  SeriesName?: string;
  SeasonId?: string;
  SeasonName?: string;
  IndexNumber?: number; // episode number
  ParentIndexNumber?: number; // season number
  UserData?: UserItemData;
  CollectionType?: string; // "movies" | "tvshows" | ...
  MediaSources?: MediaSource[];
  ChildCount?: number;
  /** External metadata ids, e.g. { Imdb: "tt1234567", Tmdb: "123" }. */
  ProviderIds?: Record<string, string>;
}

export interface ItemsResult {
  Items: BaseItem[];
  TotalRecordCount: number;
}

/** A configured Jellyfin server + saved session ("profile"). */
export interface ServerProfile {
  kind?: "local" | "jellyfin";
  id: string; // local uuid
  serverUrl: string; // normalized, no trailing slash
  serverName?: string;
  userId: string;
  userName: string;
  accessToken: string;
  userImageTag?: string;
}

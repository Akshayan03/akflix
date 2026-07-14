/**
 * Multi-server Jellyfin auth.
 *
 * Every successful login is saved as a ServerProfile (server + user + token),
 * so the login screen doubles as a Netflix-style "Who's watching?" picker:
 * each saved profile is one tap away, and you can be signed into several
 * servers/users at once and switch instantly.
 */

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { JellyfinClient } from "@/api/jellyfin";
import { uuid } from "@/lib/utils";
import type { ServerProfile } from "@/types/jellyfin";

interface AuthState {
  profiles: ServerProfile[];
  activeProfileId: string | null;

  /** Client for the active profile (rebuilt on the fly, not persisted). */
  client: () => JellyfinClient | null;
  activeProfile: () => ServerProfile | null;

  login: (serverUrl: string, username: string, password: string) => Promise<ServerProfile>;
  switchProfile: (id: string) => void;
  removeProfile: (id: string) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      profiles: [],
      activeProfileId: null,

      activeProfile: () => {
        const { profiles, activeProfileId } = get();
        return profiles.find((p) => p.id === activeProfileId) ?? null;
      },

      client: () => {
        const p = get().activeProfile();
        return p ? JellyfinClient.fromProfile(p) : null;
      },

      login: async (serverUrl, username, password) => {
        const info = await JellyfinClient.pingServer(serverUrl); // validates URL
        const auth = await JellyfinClient.authenticate(serverUrl, username, password);

        const profile: ServerProfile = {
          id: uuid(),
          serverUrl: serverUrl.trim().replace(/\/+$/, ""),
          serverName: info.ServerName,
          userId: auth.User.Id,
          userName: auth.User.Name,
          accessToken: auth.AccessToken,
          userImageTag: auth.User.PrimaryImageTag,
        };

        set((s) => {
          // Replace an existing profile for the same server+user.
          const others = s.profiles.filter(
            (p) => !(p.serverUrl === profile.serverUrl && p.userId === profile.userId)
          );
          return { profiles: [...others, profile], activeProfileId: profile.id };
        });
        return profile;
      },

      switchProfile: (id) => set({ activeProfileId: id }),

      removeProfile: (id) =>
        set((s) => ({
          profiles: s.profiles.filter((p) => p.id !== id),
          activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
        })),

      logout: () => set({ activeProfileId: null }),
    }),
    { name: "akflix.auth" }
  )
);

/**
 * Stable Jellyfin client for the active profile.
 *
 * `useAuth(s => s.client)()` builds a NEW client instance every render,
 * which is fine for render-time use but must never appear in effect
 * dependency arrays (it re-fires the effect each render). Components with
 * effects should use this hook instead — the instance is memoized per
 * profile switch.
 */
export function useJellyfinClient(): JellyfinClient | null {
  const profileId = useAuth((s) => s.activeProfileId);
  return useMemo(
    () => useAuth.getState().client(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileId]
  );
}

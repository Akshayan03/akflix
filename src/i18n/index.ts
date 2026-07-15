/**
 * Tiny dependency-free i18n. Add a language by extending `dictionaries`
 * and the `language` union in settingsStore.
 */

import { useCallback } from "react";
import { useSettings } from "@/stores/settingsStore";

const en = {
  "nav.home": "Home",
  "nav.search": "Search",
  "nav.downloads": "Downloads",
  "nav.settings": "Settings",
  "nav.switchProfile": "Switch profile",
  "nav.logout": "Sign out",

  "row.continueWatching": "Continue Watching",
  "row.nextUp": "Next Up",
  "row.myList": "My List",
  "row.recentlyAdded": "Recently Added",

  "hero.play": "Play",
  "hero.moreInfo": "More Info",
  "hero.resume": "Resume",

  "login.title": "Sign in to your Jellyfin server",
  "login.server": "Server URL",
  "login.username": "Username",
  "login.password": "Password",
  "login.signIn": "Sign In",
  "login.addServer": "Add a server",
  "login.whosWatching": "Who's watching?",

  "search.placeholder": "Titles, people, genres…",
  "search.library": "From your library",
  "search.torrents": "Discover (torrents)",
  "search.noResults": "No results found",

  "torrent.download": "Download",
  "torrent.stream": "Stream",
  "torrent.copyMagnet": "Copy magnet",
  "torrent.seeders": "seeders",
  "torrent.findSources": "Find torrent sources",
  "torrent.added": "Added to downloads",
  "torrent.disclaimer":
    "Only download content you have the legal right to access. You are responsible for complying with the laws of your country.",

  "downloads.title": "Downloads",
  "downloads.empty": "No active downloads",
  "downloads.import": "Scan into Jellyfin",
  "downloads.importHint":
    "Runs a Jellyfin library scan so completed downloads show up in your library.",
  "downloads.offline": "qBittorrent is unreachable — check Settings.",
  "downloads.pause": "Pause",
  "downloads.resume": "Resume",
  "downloads.delete": "Remove",
  "downloads.deleteFiles": "Remove + delete files",

  "settings.title": "Settings",
  "settings.jellyfin": "Jellyfin servers",
  "settings.torrentClient": "Playback engine",
  "settings.indexer": "Torrent indexer (Prowlarr)",
  "settings.downloadPath": "Download path",
  "settings.language": "Language",
  "settings.subtitleLang": "Preferred subtitle language",
  "settings.test": "Test connection",
  "settings.ok": "Connected",
  "settings.fail": "Connection failed",
  "settings.save": "Save",
  "settings.saved": "Saved",

  "details.play": "Play",
  "details.resume": "Resume",
  "details.myList": "My List",
  "details.inList": "In My List",
  "details.seasons": "Seasons",

  "player.loading": "Loading stream…",
  "player.subtitles": "Subtitles",
  "player.subtitlesOff": "Off",
  "player.back": "Back",

  "common.error": "Something went wrong",
  "common.loading": "Loading…",
};

type Dict = typeof en;
export type TranslationKey = keyof Dict;

const es: Dict = {
  ...en,
  "nav.home": "Inicio",
  "nav.search": "Buscar",
  "nav.downloads": "Descargas",
  "nav.settings": "Ajustes",
  "nav.switchProfile": "Cambiar perfil",
  "nav.logout": "Cerrar sesión",
  "row.continueWatching": "Continuar viendo",
  "row.nextUp": "A continuación",
  "row.myList": "Mi lista",
  "row.recentlyAdded": "Añadido recientemente",
  "hero.play": "Reproducir",
  "hero.moreInfo": "Más información",
  "hero.resume": "Reanudar",
  "login.title": "Inicia sesión en tu servidor Jellyfin",
  "login.server": "URL del servidor",
  "login.username": "Usuario",
  "login.password": "Contraseña",
  "login.signIn": "Iniciar sesión",
  "login.addServer": "Añadir servidor",
  "login.whosWatching": "¿Quién está viendo?",
  "search.placeholder": "Títulos, personas, géneros…",
  "search.library": "De tu biblioteca",
  "search.torrents": "Descubrir (torrents)",
  "search.noResults": "Sin resultados",
  "torrent.download": "Descargar",
  "torrent.stream": "Transmitir",
  "torrent.copyMagnet": "Copiar magnet",
  "torrent.seeders": "semillas",
  "torrent.findSources": "Buscar fuentes torrent",
  "torrent.added": "Añadido a descargas",
  "downloads.title": "Descargas",
  "downloads.empty": "No hay descargas activas",
  "downloads.import": "Escanear en Jellyfin",
  "downloads.pause": "Pausar",
  "downloads.resume": "Reanudar",
  "downloads.delete": "Quitar",
  "downloads.deleteFiles": "Quitar y borrar archivos",
  "settings.title": "Ajustes",
  "settings.language": "Idioma",
  "settings.save": "Guardar",
  "settings.saved": "Guardado",
  "details.play": "Reproducir",
  "details.resume": "Reanudar",
  "details.myList": "Mi lista",
  "details.inList": "En mi lista",
  "details.seasons": "Temporadas",
  "player.loading": "Cargando…",
  "player.subtitles": "Subtítulos",
  "player.subtitlesOff": "No",
  "player.back": "Atrás",
  "common.error": "Algo salió mal",
  "common.loading": "Cargando…",
};

const fr: Dict = {
  ...en,
  "nav.home": "Accueil",
  "nav.search": "Recherche",
  "nav.downloads": "Téléchargements",
  "nav.settings": "Paramètres",
  "nav.switchProfile": "Changer de profil",
  "nav.logout": "Se déconnecter",
  "row.continueWatching": "Reprendre la lecture",
  "row.nextUp": "À suivre",
  "row.myList": "Ma liste",
  "row.recentlyAdded": "Ajouts récents",
  "hero.play": "Lecture",
  "hero.moreInfo": "Plus d'infos",
  "hero.resume": "Reprendre",
  "login.title": "Connexion à votre serveur Jellyfin",
  "login.server": "URL du serveur",
  "login.username": "Nom d'utilisateur",
  "login.password": "Mot de passe",
  "login.signIn": "Se connecter",
  "login.addServer": "Ajouter un serveur",
  "login.whosWatching": "Qui regarde ?",
  "search.placeholder": "Titres, personnes, genres…",
  "search.library": "De votre bibliothèque",
  "search.torrents": "Découvrir (torrents)",
  "search.noResults": "Aucun résultat",
  "torrent.download": "Télécharger",
  "torrent.stream": "Diffuser",
  "torrent.copyMagnet": "Copier le magnet",
  "torrent.seeders": "sources",
  "torrent.findSources": "Chercher des torrents",
  "torrent.added": "Ajouté aux téléchargements",
  "downloads.title": "Téléchargements",
  "downloads.empty": "Aucun téléchargement actif",
  "downloads.import": "Scanner dans Jellyfin",
  "downloads.pause": "Pause",
  "downloads.resume": "Reprendre",
  "downloads.delete": "Retirer",
  "downloads.deleteFiles": "Retirer + supprimer",
  "settings.title": "Paramètres",
  "settings.language": "Langue",
  "settings.save": "Enregistrer",
  "settings.saved": "Enregistré",
  "details.play": "Lecture",
  "details.resume": "Reprendre",
  "details.myList": "Ma liste",
  "details.inList": "Dans ma liste",
  "details.seasons": "Saisons",
  "player.loading": "Chargement…",
  "player.subtitles": "Sous-titres",
  "player.subtitlesOff": "Désactivés",
  "player.back": "Retour",
  "common.error": "Une erreur est survenue",
  "common.loading": "Chargement…",
};

const dictionaries: Record<string, Dict> = { en, es, fr };

/**
 * Hook: `const t = useT(); t("hero.play")` — re-renders on language change.
 * The returned function is referentially stable per language, so it's safe
 * to use in effect/callback dependency arrays.
 */
export function useT() {
  const language = useSettings((s) => s.language);
  return useCallback(
    (key: TranslationKey): string => {
      const dict = dictionaries[language] ?? en;
      return dict[key] ?? en[key] ?? key;
    },
    [language]
  );
}

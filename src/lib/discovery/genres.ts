/** Genre names as Cinemeta spells them, and how rows talk about them. */

/** One spelling per genre across Cinemeta and Jellyfin ("Science Fiction"). */
export function normalizeGenre(genre: string): string {
  const value = genre.trim().toLowerCase().replace(/\s+/g, " ");
  if (value === "science fiction" || value === "sci fi" || value === "scifi") return "sci-fi";
  if (value === "reality" || value === "reality tv") return "reality-tv";
  if (value === "talk" || value === "talk show") return "talk-show";
  if (value === "game show") return "game-show";
  if (value === "sports") return "sport";
  if (value === "biopic") return "biography";
  return value;
}

/** Cinemeta's own genre option for a normalized genre (for genre feeds). */
export const CATALOG_GENRES: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animation: "Animation",
  biography: "Biography",
  comedy: "Comedy",
  crime: "Crime",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  history: "History",
  horror: "Horror",
  mystery: "Mystery",
  romance: "Romance",
  "sci-fi": "Sci-Fi",
  sport: "Sport",
  thriller: "Thriller",
  war: "War",
  western: "Western",
  "reality-tv": "Reality-TV",
  "talk-show": "Talk-Show",
  "game-show": "Game-Show",
};

/** Plural noun for one genre, as in "Thrillers for you". */
const SINGLE: Record<string, string> = {
  action: "Action",
  adventure: "Adventures",
  animation: "Animation",
  biography: "Biopics",
  comedy: "Comedies",
  crime: "Crime stories",
  documentary: "Documentaries",
  drama: "Dramas",
  family: "Family favourites",
  fantasy: "Fantasy",
  history: "History",
  horror: "Horror",
  mystery: "Mysteries",
  romance: "Romance",
  "sci-fi": "Sci-fi",
  sport: "Sports stories",
  thriller: "Thrillers",
  war: "War stories",
  western: "Westerns",
  "reality-tv": "Reality TV",
  "talk-show": "Talk shows",
  "game-show": "Game shows",
};

/** Natural names for common pairs; order-insensitive. */
const PAIRS: Record<string, string> = {
  "crime+drama": "Crime dramas",
  "comedy+drama": "Comedy dramas",
  "crime+thriller": "Crime thrillers",
  "mystery+thriller": "Mystery thrillers",
  "horror+thriller": "Horror thrillers",
  "horror+mystery": "Horror mysteries",
  "comedy+romance": "Romantic comedies",
  "drama+romance": "Romantic dramas",
  "action+adventure": "Action adventures",
  "action+crime": "Action crime",
  "action+thriller": "Action thrillers",
  "action+comedy": "Action comedies",
  "action+sci-fi": "Sci-fi action",
  "adventure+sci-fi": "Sci-fi adventures",
  "adventure+fantasy": "Fantasy adventures",
  "drama+sci-fi": "Sci-fi dramas",
  "drama+fantasy": "Fantasy dramas",
  "drama+mystery": "Mystery dramas",
  "drama+thriller": "Dramatic thrillers",
  "drama+horror": "Horror dramas",
  "biography+drama": "True-story dramas",
  "drama+history": "Historical dramas",
  "drama+war": "War dramas",
  "drama+sport": "Sports dramas",
  "comedy+crime": "Crime comedies",
  "animation+family": "Animated family films",
  "animation+comedy": "Animated comedies",
  "adventure+animation": "Animated adventures",
  "crime+documentary": "True crime",
  "comedy+horror": "Horror comedies",
  "comedy+family": "Family comedies",
};

const pairKey = (a: string, b: string) => [a, b].sort().join("+");

export const hasPairName = (a: string, b: string) => pairKey(normalizeGenre(a), normalizeGenre(b)) in PAIRS;

/** "Crime dramas", "Thrillers", or a plain fallback for anything unexpected. */
export function genreRowName(genres: string[]): string {
  const [a, b] = genres.map(normalizeGenre);
  if (b) {
    const pair = PAIRS[pairKey(a, b)];
    if (pair) return pair;
  }
  if (SINGLE[a]) return SINGLE[a];
  return a ? a.charAt(0).toUpperCase() + a.slice(1) : "Picks";
}

/** Lower-case genre for a sentence: "Because you like thrillers". */
export function genrePhrase(genre: string): string {
  const name = SINGLE[normalizeGenre(genre)] ?? genre;
  return name === "Sci-fi" || name === "Reality TV" ? name : name.toLowerCase();
}

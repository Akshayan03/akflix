/** @type {import('tailwindcss').Config} */

// Akflix monochrome system. Every colour in the UI is a neutral grey: artwork
// and video are the only colour on screen. The same file ships in the desktop
// and iPhone repositories so both apps share one set of tokens.
//
// `zinc` is redefined as a true neutral ramp (Tailwind's default zinc is
// blue-tinted). Text contrast on every surface from #000 to #272727
// (checked by tests/theme-tokens.test.mjs):
//   zinc-300 ≥ 9.5:1 · zinc-400 ≥ 6.5:1 · zinc-500 ≥ 4.5:1 (AA body text)
//   zinc-600 ≥ 3:1 up to #1c1c1c — large text, icons and borders only.
const neutral = {
  50: "#fafafa",
  100: "#f4f4f4",
  200: "#e4e4e4",
  300: "#cfcfcf",
  400: "#ababab",
  500: "#8e8e8e",
  600: "#6e6e6e",
  700: "#404040",
  800: "#272727",
  900: "#171717",
  950: "#0c0c0c",
};

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        zinc: neutral,
        neutral,
        // Primary actions are white on black; "brand" is the white end of the ramp.
        brand: {
          DEFAULT: "#ededed",
          dark: "#a8a8a8",
          light: "#ffffff",
        },
        accent: "#ffffff",
        surface: {
          DEFAULT: "#000000",
          raised: "#121212",
          overlay: "#1c1c1c",
        },
        line: {
          DEFAULT: "rgba(255,255,255,0.12)",
          strong: "rgba(255,255,255,0.28)",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI Variable Text",
          "Segoe UI",
          "Inter",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
        // Titles: Apple's New York on macOS/iOS, Georgia elsewhere.
        display: ["ui-serif", "New York", "Iowan Old Style", "Georgia", "Times New Roman", "serif"],
      },
      transitionTimingFunction: {
        out: "cubic-bezier(0.22, 1, 0.36, 1)",
        "in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(10px)" },
          "100%": { opacity: "1", transform: "none" },
        },
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "indeterminate": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(250%)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s linear infinite",
        "fade-up": "fade-up 360ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "fade-in": "fade-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both",
        indeterminate: "indeterminate 1.3s cubic-bezier(0.65, 0, 0.35, 1) infinite",
      },
    },
  },
  plugins: [],
};

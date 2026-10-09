/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Editorial desktop palette: ivory controls and charcoal surfaces.
        brand: {
          DEFAULT: "#ddd8cd",
          dark: "#a9a397",
          light: "#eeeae1",
        },
        accent: "#f4e9cf",
        surface: {
          DEFAULT: "#101112",
          raised: "#191a1b",
          overlay: "#232426",
        },
      },
      fontFamily: {
        sans: [
          "Avenir Next",
          "SF Pro Display",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-400px 0" },
          "100%": { backgroundPosition: "400px 0" },
        },
      },
      animation: {
        shimmer: "shimmer 1.4s linear infinite",
      },
    },
  },
  plugins: [],
};

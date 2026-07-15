/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Akflix noir palette: champagne gold, warm ivory, deep espresso.
        brand: {
          DEFAULT: "#d6b25e",
          dark: "#98752f",
          light: "#f0d58a",
        },
        accent: "#f4e9cf",
        surface: {
          DEFAULT: "#090806",
          raised: "#15130f",
          overlay: "#1f1b14",
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

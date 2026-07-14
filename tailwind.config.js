/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Netflix-inspired dark cinematic palette
        brand: {
          DEFAULT: "#e50914",
          dark: "#b00710",
          light: "#f6121d",
        },
        surface: {
          DEFAULT: "#141414",
          raised: "#1f1f1f",
          overlay: "#232323",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "Helvetica Neue",
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

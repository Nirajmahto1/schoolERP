/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./App.{js,jsx,ts,tsx}",
    "./app/**/*.{js,jsx,ts,tsx}",
    "./components/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#004ac6",
        "primary-container": "#2563eb",
        surface: "#f7f9fb",
        "surface-container-low": "#f2f4f6",
        "surface-container-highest": "#e0e3e5",
        "on-surface": "#191c1e",
        "on-surface-variant": "#434655",
        error: "#ba1a1a",
      },
    },
  },
  plugins: [],
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ringbg: 'rgba(255, 255, 255, 0.1)'
      }
    },
  },
  plugins: [],
}

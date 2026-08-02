/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        farm: {
          green: '#2d9960',
          'green-dark': '#1f6b42',
          gold: '#e8a427',
        },
      },
    },
  },
  plugins: [],
}

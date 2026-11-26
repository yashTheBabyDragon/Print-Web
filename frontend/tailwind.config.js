/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        pw: {
          cyan: '#00A7D9',
          'cyan-hover': '#0090BD',
          'cyan-ink': '#007BA3',
          'cyan-light': '#38C6F4',
          light: {
            bg: '#F6F7F9',
            surface: '#FFFFFF',
            subtle: '#EFEFF3',
            ink: '#111318',
            muted: '#5B616E',
          },
          dark: {
            bg: '#0D0E11',
            surface: '#15171C',
            elevated: '#1D2027',
            ink: '#F4F5F7',
            muted: '#9399A6',
          },
        },
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'SF Pro Display',
          'SF Pro Text',
          'Plus Jakarta Sans',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'ui-monospace',
          'Menlo',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};

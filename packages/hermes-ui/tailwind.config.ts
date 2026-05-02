import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0a0b',
          card: '#141416',
          hover: '#1a1a1c',
        },
        accent: {
          DEFAULT: '#9ec5ff',
          subtle: '#7aa6e0',
        },
        success: '#5fcc7f',
        warn: '#ffc857',
        error: '#ff7878',
        muted: '#6b6b75',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
export default config;

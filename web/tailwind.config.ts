import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FAFAF8',
        ink: '#0A0A0A',
        line: '#E4E2DD',
        'line-strong': '#CFCCC4',
        muted: '#6B6862',
        panel: '#FFFFFF',
        good: '#1E7A3D',
        warn: '#966B10',
        bad: '#B23A2E',
        // Brand accent — same value as `warn` (the ABSTAIN verdict color) by
        // design, kept as a separate token so intent reads clearly in markup:
        // `accent` for brand/UI, `warn` for the semantic "insufficient" state.
        accent: '#966B10',
        'accent-dark': '#7A5610',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      borderRadius: {
        sm: '2px',
        DEFAULT: '3px',
        md: '4px',
        lg: '6px',
      },
      backgroundImage: {
        grid: 'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
      },
      backgroundSize: {
        grid: '40px 40px',
      },
      maxWidth: {
        content: '1180px',
      },
    },
  },
  plugins: [],
} satisfies Config;

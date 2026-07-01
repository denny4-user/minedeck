/** MineDeck UI — Tailwind CSS v3 + daisyUI v4 config.
 *  Build the stylesheet with:  npm run build:css
 *  The generated public/css/app.css is committed, so the server needs no build.
 */
module.exports = {
  content: ['./public/**/*.{html,js}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Inter', 'Helvetica Neue', 'Arial', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'Cascadia Code', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    logs: false,
    themes: [
      {
        minedeck: {
          primary: '#46d17f',
          'primary-content': '#052012',
          secondary: '#58a6ff',
          'secondary-content': '#041220',
          accent: '#3fbf6f',
          'accent-content': '#052012',
          neutral: '#1b212a',
          'neutral-content': '#e6edf3',
          'base-100': '#12161c',
          'base-200': '#0e1217',
          'base-300': '#232b36',
          'base-content': '#e6edf3',
          info: '#58a6ff',
          success: '#46d17f',
          warning: '#f0b849',
          error: '#f0616d',
          '--rounded-box': '0.9rem',
          '--rounded-btn': '0.55rem',
          '--rounded-badge': '1.9rem',
          '--border-btn': '1px',
          '--tab-radius': '0.5rem',
        },
      },
    ],
  },
};

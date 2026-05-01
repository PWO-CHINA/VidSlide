module.exports = {
  darkMode: 'class',
  content: [
    './templates/**/*.html',
    './static/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f6f8fa',
          100: '#eef2f6',
          200: '#dce4ed',
          300: '#bacce0',
          400: '#94b0cf',
          500: '#7394b8',
          600: '#5a7a9e',
          700: '#486180',
          800: '#3e5169',
          900: '#354457',
          950: '#232d3b',
        },
        soft: {
          success: '#34d399',
          warning: '#fbbf24',
          error: '#fb7185',
        },
      },
      boxShadow: {
        'ai-sm': '0 1px 2px rgba(0, 0, 0, 0.04), 0 1px 1px rgba(0, 0, 0, 0.03)',
        'ai-md': '0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -2px rgba(0, 0, 0, 0.03)',
      },
    },
  },
};

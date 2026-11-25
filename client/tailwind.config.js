/**
 * Tailwind theme for Manifold. Every colour is a CSS custom property defined in
 * src/index.css for BOTH themes (dark default, light via [data-theme="light"]);
 * see docs/design/ui-design-system.md.
 *
 *   Only the semantic names exist:
 *     surfaces  bg-app, bg-panel, bg-raised, bg-overlay, bg-field
 *     lines     border-line, border-line-strong, border-line-stronger
 *     text      text-fg, text-muted, text-subtle, text-faint
 *     accent    bg-accent text-accent-fg, text-accent-text, ring-accent
 *     state     good, warn, bad, info, aux (text-good, bg-bad/10, ...)
 *
 *   Tailwind's default palette is replaced, not extended: legacy names
 *   (slate-*, surface-*, rose, amber, emerald, sky, ...) do not exist and
 *   render nothing. src/test/designSystemClasses.test.js fails on them.
 */

/** A themed colour that honours Tailwind's opacity modifier (bg-panel/50). */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    // Small, deliberate radii (controls 4-6px, panels 6px).
    borderRadius: {
      none: '0',
      sm: '2px',
      DEFAULT: '4px',
      md: '4px',
      lg: '6px',
      full: '9999px'
    },
    // Shadows are for true overlays only (menus, dialogs, drawers, toasts).
    boxShadow: {
      none: 'none',
      overlay: 'var(--shadow-overlay)'
    },
    // No coloured shadows: `shadow-overlay` must not also be read as the colour `overlay`.
    boxShadowColor: {},
    // No blur anywhere (the word "blur" in event names must not become a filter).
    blur: { none: '0', DEFAULT: '0' },
    // The palette: semantic tokens only (plus the plain keywords Tailwind needs).
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      inherit: 'inherit',
      white: '#fff',
      black: '#000',
      app: v('bg'),
      panel: v('panel'),
      raised: v('raised'),
      overlay: v('overlay'),
      field: v('field'),
      'control-off': v('control-off'),
      danger: { DEFAULT: v('danger'), hover: v('danger-hover'), fg: v('danger-fg') },
      line: { DEFAULT: v('border'), strong: v('border-strong'), stronger: v('border-stronger') },
      fg: v('text'),
      muted: v('text-muted'),
      subtle: v('text-subtle'),
      faint: v('text-faint'),
      accent: { DEFAULT: v('accent'), hover: v('accent-hover'), fg: v('accent-fg'), text: v('accent-text') },
      good: v('good'),
      warn: v('warn'),
      bad: v('bad'),
      info: v('info'),
      aux: v('aux')
    },
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans Variable"', '"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'Consolas', 'monospace']
      },
      // Type scale: 11 (dense meta only) / 12 / 13 (UI body) / 14 / 16 / 20 / 24.
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }], // 11px
        xs: ['0.75rem', { lineHeight: '1rem' }], // 12px
        sm: ['0.8125rem', { lineHeight: '1.25rem' }], // 13px - default UI text
        base: ['0.875rem', { lineHeight: '1.375rem' }], // 14px
        lg: ['1rem', { lineHeight: '1.5rem' }], // 16px - page titles
        xl: ['1.25rem', { lineHeight: '1.75rem' }], // 20px - stat values
        '2xl': ['1.5rem', { lineHeight: '2rem' }] // 24px - hero numbers
      },
      transitionDuration: { DEFAULT: '140ms' },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)' }
    }
  },
  plugins: []
};

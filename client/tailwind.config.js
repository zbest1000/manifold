/**
 * Tailwind theme for Manifold. Every colour is a CSS custom property defined in
 * src/index.css for BOTH themes (dark default, light via [data-theme="light"]);
 * see docs/design/ui-design-system.md.
 *
 *   New code uses the semantic names only:
 *     surfaces  bg-app, bg-panel, bg-raised, bg-overlay
 *     lines     border-line, border-line-strong
 *     text      text-fg, text-muted, text-subtle, text-faint
 *     accent    bg-accent text-accent-fg, text-accent-text, ring-accent
 *     state     good, warn, bad, info (text-good, bg-bad/10, ...)
 *
 *   Legacy names (slate-*, surface-*, accent-100..700, white/x, black/x, rose,
 *   amber, emerald, sky, ...) are REMAPPED onto those tokens so pages that have
 *   not been migrated yet follow the palette in both themes. Do not use them in
 *   new code; the migration guide maps each one to its replacement.
 */

/** A themed colour that honours Tailwind's opacity modifier (bg-panel/50). */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** A themed colour that IGNORES the opacity modifier: legacy translucent
 *  surfaces (bg-surface-900/60 + backdrop-blur "glass") render as solid layers. */
const solid = (name) => () => `rgb(var(--${name}))`;

const num = (opacityValue) => {
  const n = Number.parseFloat(opacityValue);
  return Number.isFinite(n) ? n : null;
};

/** Legacy `bg-white/x` and `ring-white/x`. Low alpha is a hover/fill tint that
 *  must stay visible on a white page, so it becomes a foreground tint (white in
 *  dark, black in light). High alpha (>= .5) or none is a real white fill. */
const whiteFill = ({ opacityValue }) => {
  const a = num(opacityValue);
  if (a === null || a >= 0.5) return `rgb(255 255 255 / ${opacityValue ?? 1})`;
  return `rgb(var(--tint) / calc(${a} * var(--tint-k)))`;
};

/** Legacy `border-white/x` / `divide-white/x`: hairlines snap to the line tokens. */
const whiteLine = ({ opacityValue }) => {
  const a = num(opacityValue);
  if (a === null || a >= 0.5) return 'rgb(255 255 255)';
  if (a <= 0.12) return 'rgb(var(--border))';
  if (a <= 0.22) return 'rgb(var(--border-strong))';
  return 'rgb(var(--border-stronger))';
};

/** Legacy `bg-black/x` wells: a shade that is a lot lighter on the light theme. */
const blackFill = ({ opacityValue }) => {
  const a = num(opacityValue);
  if (a === null) return 'rgb(0 0 0)';
  return `rgb(0 0 0 / calc(${a} * var(--shade-k)))`;
};

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const family = (fam) => Object.fromEntries(SHADES.map((s) => [s, v(`${fam}-${s}`)]));

// Fixed neutrals for legacy bg-/border-/ring-slate (status fills and the UNS
// paper canvas chips): the same in both themes, never blue-tinted.
const fixedNeutral = {
  50: '#f7f7f8',
  100: '#ececee',
  200: '#dcdce0',
  300: '#c9c9ce',
  400: '#9a9aa1',
  500: '#78787f',
  600: '#5b5b61',
  700: '#404045',
  800: '#2a2a2d',
  900: '#1b1b1d',
  950: '#111112'
};

const good = family('good');
const warn = family('warn');
const bad = family('bad');
const info = family('info');
const aux = family('aux');

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    // Small, deliberate radii (controls 4-6px, panels 8px). Legacy rounded-xl /
    // rounded-2xl collapse onto them, so every page loses the pillowy look.
    borderRadius: {
      none: '0',
      sm: '2px',
      DEFAULT: '4px',
      md: '4px',
      lg: '6px',
      xl: '6px',
      '2xl': '8px',
      '3xl': '8px',
      full: '9999px'
    },
    // Shadows are for true overlays only (menus, dialogs, drawers, toasts).
    boxShadow: {
      none: 'none',
      sm: 'none',
      DEFAULT: 'none',
      md: 'var(--shadow-overlay)',
      lg: 'var(--shadow-overlay)',
      xl: 'var(--shadow-overlay)',
      '2xl': 'var(--shadow-overlay)',
      overlay: 'var(--shadow-overlay)',
      inner: 'none'
    },
    // No coloured shadows (shadow-sky-700/20 and friends render nothing extra).
    boxShadowColor: {},
    // No frosted glass anywhere.
    backdropBlur: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0' },
    blur: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0' },
    extend: {
      colors: {
        // ---- semantic tokens (use these) ----
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
        accent: {
          DEFAULT: v('accent'),
          hover: v('accent-hover'),
          fg: v('accent-fg'),
          text: v('accent-text'),
          // legacy accent-100..950 (compat)
          ...family('accent')
        },
        good: { DEFAULT: v('good'), ...good },
        warn: { DEFAULT: v('warn'), ...warn },
        bad: { DEFAULT: v('bad'), ...bad },
        info: { DEFAULT: v('info'), ...info },

        // ---- legacy names, remapped (compat layer; do not use in new code) ----
        surface: {
          0: solid('panel'),
          50: solid('bg'),
          100: solid('raised'),
          200: solid('border'),
          800: solid('raised'),
          900: solid('panel'),
          950: solid('bg')
        },
        slate: family('n'),
        gray: family('n'),
        zinc: family('n'),
        rose: bad,
        red: bad,
        pink: bad,
        amber: warn,
        yellow: warn,
        orange: warn,
        emerald: good,
        green: good,
        lime: good,
        sky: info,
        blue: info,
        indigo: info,
        teal: family('accent'),
        cyan: family('accent'),
        violet: aux,
        purple: aux,
        fuchsia: aux
      },
      backgroundColor: {
        white: whiteFill,
        black: blackFill,
        slate: fixedNeutral
      },
      borderColor: {
        white: whiteLine,
        slate: fixedNeutral
      },
      divideColor: {
        white: whiteLine
      },
      ringColor: {
        white: whiteLine,
        slate: fixedNeutral
      },
      // Native checkboxes/radios/ranges: every legacy accent-<hue>-500 uses the accent.
      accentColor: {
        sky: family('accent'),
        blue: family('accent'),
        emerald: family('accent')
      },
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
        '2xl': ['1.5rem', { lineHeight: '2rem' }], // 24px - hero numbers
        '3xl': ['1.5rem', { lineHeight: '2rem' }] // legacy: capped at 24px
      },
      transitionDuration: { DEFAULT: '140ms' },
      transitionTimingFunction: { DEFAULT: 'cubic-bezier(0.2, 0, 0, 1)' }
    }
  },
  plugins: []
};

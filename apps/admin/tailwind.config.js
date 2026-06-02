const ch = (v) => `rgb(var(${v}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        canvas: ch("--c-canvas"),
        panel: ch("--c-panel"),
        fg: ch("--c-fg"),
        ink: ch("--c-fg"), // alias (legacy usages)
        muted: ch("--c-muted"),
        line: ch("--c-line"),
        chrome: {
          DEFAULT: ch("--c-chrome"),
          light: ch("--c-chrome-light"),
          rail: ch("--c-chrome-rail"),
          border: ch("--c-chrome-border"),
          fg: ch("--c-chrome-fg"),
        },
        accent: {
          DEFAULT: ch("--c-accent"),
          600: ch("--c-accent-600"),
          700: ch("--c-accent-700"),
          50: ch("--c-accent-50"),
          fg: ch("--c-accent-fg"),
        },
        brand: ch("--c-brand"),
        published: ch("--c-published"),
        draft: ch("--c-draft"),
        danger: ch("--c-danger"),
        ring: ch("--c-ring"),
      },
      fontFamily: {
        sans: "var(--font-ui)",
        display: "var(--font-display)",
        mono: "var(--font-mono)",
      },
      borderRadius: {
        DEFAULT: "var(--radius)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        panel: "var(--shadow-panel)",
        pop: "var(--shadow-pop)",
      },
      transitionTimingFunction: {
        smooth: "var(--ease)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "scale-in": { from: { opacity: "0", transform: "scale(0.97)" }, to: { opacity: "1", transform: "scale(1)" } },
        "toast-in": { from: { opacity: "0", transform: "translateX(12px)" }, to: { opacity: "1", transform: "translateX(0)" } },
      },
      animation: {
        "fade-in": "fade-in var(--dur) var(--ease)",
        "slide-up": "slide-up var(--dur) var(--ease)",
        "scale-in": "scale-in var(--dur) var(--ease)",
        "toast-in": "toast-in var(--dur) var(--ease)",
      },
    },
  },
  plugins: [],
};

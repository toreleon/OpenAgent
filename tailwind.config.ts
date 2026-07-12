import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // CSS-var-driven semantic palette so components use semantic classes.
        sidebar: "rgb(var(--color-sidebar) / <alpha-value>)",
        main: "rgb(var(--color-main) / <alpha-value>)",
        "user-bubble": "rgb(var(--color-user-bubble) / <alpha-value>)",
        "assistant-bubble": "rgb(var(--color-assistant-bubble) / <alpha-value>)",
        composer: "rgb(var(--color-composer) / <alpha-value>)",
        border: "rgb(var(--color-border) / <alpha-value>)",
        "text-primary": "rgb(var(--color-text-primary) / <alpha-value>)",
        "text-secondary": "rgb(var(--color-text-secondary) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        "accent-hover": "rgb(var(--color-accent-hover) / <alpha-value>)",
        hover: "rgb(var(--color-hover) / <alpha-value>)",
        "code-bg": "rgb(var(--color-code-bg) / <alpha-value>)",
        "code-header": "rgb(var(--color-code-header) / <alpha-value>)",
        danger: "rgb(var(--color-danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
      },
      maxWidth: {
        chat: "48rem",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "pulse-cursor": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        // Left-to-right light sweep over the live "Thinking…" label (a clipped
        // gradient panned across the text). See ThinkingBlock / globals.css.
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.2s ease-out",
        "pulse-cursor": "pulse-cursor 1s steps(1) infinite",
        shimmer: "shimmer 1.8s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;

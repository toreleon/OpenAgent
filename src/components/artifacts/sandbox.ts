/**
 * Builders that turn artifact content into a sandboxed-iframe `srcdoc` string.
 *
 * SECURITY MODEL: every preview runs inside an <iframe sandbox="allow-scripts">
 * WITHOUT `allow-same-origin`. The browser therefore treats the frame as an
 * opaque, unique origin: the artifact code cannot read the parent app's DOM,
 * cookies, localStorage, or same-origin network. External libraries (React,
 * Mermaid, Tailwind, Babel) load from public CDNs. This mirrors how Claude
 * Desktop isolates artifact execution.
 *
 * These functions are pure (no DOM, no React) so they can be unit-reasoned and
 * reused by every renderer.
 */

// Pinned CDN URLs — kept here so every renderer resolves the same versions.
const BABEL_URL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js";
const TAILWIND_URL = "https://cdn.tailwindcss.com";
const MERMAID_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

// Import map for React artifacts. `?external=react,react-dom` de-duplicates so
// libraries share the single React instance loaded here (no "invalid hook call").
const REACT_IMPORT_MAP = {
  imports: {
    react: "https://esm.sh/react@18.3.1",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    recharts: "https://esm.sh/recharts@2.13.3?external=react,react-dom",
    "lucide-react": "https://esm.sh/lucide-react@0.456.0?external=react",
    "framer-motion": "https://esm.sh/framer-motion@11?external=react,react-dom",
    "date-fns": "https://esm.sh/date-fns@4",
    "d3": "https://esm.sh/d3@7",
    "three": "https://esm.sh/three@0.169.0",
    clsx: "https://esm.sh/clsx@2",
  },
};

/** Escape a string for safe insertion as HTML *text* (e.g. inside <pre>). */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Neutralize an embedded `</script>` so user content can't break out of a
 * `<script>` block it is inlined into. `<\/script>` is equivalent in JS source.
 */
function guardScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/** True when the HTML already looks like a complete document. */
function isFullDocument(html: string): boolean {
  return /<html[\s>]/i.test(html) || /<!doctype/i.test(html);
}

/**
 * Build the srcdoc for an `html` artifact. A full document is passed through
 * untouched; a fragment is wrapped in a minimal, Tailwind-enabled shell so
 * common generated markup renders correctly on a white canvas.
 */
export function buildHtmlSrcDoc(content: string): string {
  if (isFullDocument(content)) return content;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="${TAILWIND_URL}"></script>
    <style>
      html, body { margin: 0; background: #ffffff; color: #111827; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 16px; }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

/**
 * Build the srcdoc for an `svg` artifact: center the SVG on a white canvas and
 * constrain it to the viewport. The markup is inlined as-is (SVG is rendered,
 * not executed — the iframe sandbox still blocks any embedded scripting from
 * touching the parent).
 */
export function buildSvgSrcDoc(content: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: grid; place-items: center; background: transparent; padding: 16px; box-sizing: border-box; }
      svg { width: 100%; height: 100%; max-width: 100%; max-height: 100%; }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

/**
 * Build the srcdoc for a `mermaid` artifact. The diagram source is placed as the
 * (HTML-escaped) textContent of a `.mermaid` element and rendered client-side by
 * Mermaid loaded from a CDN. Errors are shown inline instead of a blank frame.
 */
export function buildMermaidSrcDoc(content: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: grid; place-items: center; background: transparent; padding: 16px; box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
      .mermaid { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; margin: 0; }
      .mermaid svg { width: 100% !important; height: 100% !important; max-width: 100%; max-height: 100%; }
      #err { color: #b00020; white-space: pre-wrap; font: 13px/1.5 ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <pre class="mermaid">${escapeHtml(content)}</pre>
    <script type="module">
      import mermaid from "${MERMAID_URL}";
      mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "strict" });
      try {
        await mermaid.run();
      } catch (e) {
        document.body.innerHTML = '<pre id="err">' + String((e && e.message) || e) + '</pre>';
      }
    </script>
  </body>
</html>`;
}

/**
 * Rewrite a `export default <X>` into an assignment to a well-known global so
 * the harness can mount the component regardless of whether the default is a
 * named function, a class, or an expression. Other `export` keywords are left
 * intact (harmless inside a module). Only the first default export is rewritten.
 */
function hoistDefaultExport(source: string): string {
  return source.replace(/export\s+default\s+/, "window.__ArtifactComponent = ");
}

/**
 * Build the srcdoc for a `react` artifact. The component source is compiled
 * in-browser by Babel-standalone (JSX + TypeScript) and executed as an ES module
 * so bare imports (`react`, `recharts`, `lucide-react`, …) resolve through the
 * import map. The default export is mounted into #root; runtime and compile
 * errors are surfaced inline.
 */
export function buildReactSrcDoc(content: string): string {
  const userCode = guardScript(hoistDefaultExport(content));
  const importMap = JSON.stringify(REACT_IMPORT_MAP);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="${BABEL_URL}"></script>
    <script src="${TAILWIND_URL}"></script>
    <script type="importmap">${importMap}</script>
    <style>
      html, body { margin: 0; background: #ffffff; color: #111827; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      #root { min-height: 100vh; }
      #__err { color: #b00020; white-space: pre-wrap; padding: 16px; font: 13px/1.5 ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      function __showErr(x) {
        var r = document.getElementById("root");
        if (r) r.innerHTML = '<pre id="__err"></pre>';
        var p = document.getElementById("__err");
        if (p) p.textContent = String((x && x.stack) || x);
      }
      window.addEventListener("error", function (e) { __showErr(e.error || e.message); });
      window.addEventListener("unhandledrejection", function (e) { __showErr(e.reason); });
    </script>
    <script type="text/babel" data-type="module" data-presets="react,typescript">
      import * as __ReactNS from "react";
      import { createRoot as __createRoot } from "react-dom/client";
      window.React = __ReactNS.default || __ReactNS;
      ${userCode}
      let __C = window.__ArtifactComponent;
      try { if (!__C && typeof App !== "undefined") __C = App; } catch (e) {}
      if (__C) {
        __createRoot(document.getElementById("root")).render(
          __ReactNS.createElement(__C)
        );
      } else {
        __showErr("This React artifact has no default export. Add e.g. export default function App() {}.");
      }
    </script>
  </body>
</html>`;
}

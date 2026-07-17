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
 *
 * They are ALSO reused verbatim to render published Sites (see
 * src/app/s/[slug]/route.ts): {@link buildSiteSrcDoc} dispatches by type, and the
 * public route serves the result under a CSP `sandbox` directive so untrusted
 * published content runs in an opaque origin (no access to the app's auth cookie)
 * and can only reach the pinned CDNs below — never the app's own API.
 */
import type { SiteType } from "@/lib/types";

// Pinned CDN URLs — kept here so every renderer resolves the same versions.
const BABEL_URL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js";
const TAILWIND_URL = "https://cdn.tailwindcss.com";
const MERMAID_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
const MARKED_URL = "https://cdn.jsdelivr.net/npm/marked@14/marked.min.js";

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

// Import map for `mobile` (React Native) artifacts. `react-native` is aliased to
// react-native-web so RN primitives render in the browser with no native build.
// react-native-web is `?external=react,react-dom` so it shares the SINGLE react
// instance loaded here (the same de-dup that avoids "invalid hook call" in
// REACT_IMPORT_MAP). Both hosts are esm.sh, already in SITE_CDN_HOSTS — so the CSP
// allow-list is unchanged.
//
// DELIBERATELY MINIMAL — empirically validated in-browser (see the Phase-1 spike).
// The RN ecosystem libraries that seem obvious to add (react-navigation,
// react-native-screens, react-native-safe-area-context, @expo/vector-icons,
// expo-status-bar) all FAIL to resolve through esm.sh in the browser: they reach
// for deep RN internals like `react-native/Libraries/Utilities/codegenNativeComponent`
// that react-native-web does not implement. So this map is core-only; the model is
// steered (in agent.ts) to state-based navigation, RNW's built-in SafeAreaView /
// StatusBar, and emoji/View icons instead of those packages. Do NOT add an RN
// library here without first confirming it resolves + renders in the sandbox.
const MOBILE_IMPORT_MAP = {
  imports: {
    react: "https://esm.sh/react@18.3.1",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "react-native": "https://esm.sh/react-native-web@0.19.13?external=react,react-dom",
    "react-native-web": "https://esm.sh/react-native-web@0.19.13?external=react,react-dom",
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

/**
 * Inline error surface shared by the React + mobile sandboxes: on a thrown error
 * or unhandled rejection it swaps the #root mount point for a `<pre id="__err">`
 * and prints the message there, so a failed compile/runtime shows text instead of
 * a blank frame. Each builder styles `#__err` in its own <style>.
 */
const SANDBOX_ERROR_SCRIPT = `<script>
      function __showErr(x) {
        var r = document.getElementById("root");
        if (r) r.innerHTML = '<pre id="__err"></pre>';
        var p = document.getElementById("__err");
        if (p) p.textContent = String((x && x.stack) || x);
      }
      window.addEventListener("error", function (e) { __showErr(e.error || e.message); });
      window.addEventListener("unhandledrejection", function (e) { __showErr(e.reason); });
    </script>`;

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
    ${SANDBOX_ERROR_SCRIPT}
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

/**
 * Build the srcdoc for a `mobile` artifact: a single-file React Native app.
 *
 * It mirrors {@link buildReactSrcDoc} — same in-browser Babel compile (JSX + TS),
 * same `hoistDefaultExport`, same inline error surface — with three differences:
 *  1. the import map aliases `react-native` → react-native-web (see
 *     {@link MOBILE_IMPORT_MAP}), so RN primitives render in the browser;
 *  2. the root is mounted via RNW's `AppRegistry.runApplication` (not
 *     `createRoot`), which installs RNW's flex-column root reset so RN layout is
 *     faithful; and
 *  3. no Tailwind — RN styles come from `StyleSheet`, not classNames.
 *
 * The document fills its viewport (the "device screen"); the phone bezel is drawn
 * by the panel/preview chrome around this frame, NOT baked in here — so the SAME
 * srcdoc renders identically in the in-app preview and on the published page.
 */
export function buildMobileSrcDoc(content: string): string {
  const userCode = guardScript(hoistDefaultExport(content));
  const importMap = JSON.stringify(MOBILE_IMPORT_MAP);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
    <script src="${BABEL_URL}"></script>
    <script type="importmap">${importMap}</script>
    <style>
      html, body { margin: 0; height: 100%; background: #ffffff; color: #111827; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      #root { display: flex; height: 100%; min-height: 100vh; }
      #root > * { flex: 1; }
      #__err { color: #b00020; white-space: pre-wrap; padding: 16px; font: 13px/1.5 ui-monospace, monospace; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    ${SANDBOX_ERROR_SCRIPT}
    <script type="text/babel" data-type="module" data-presets="react,typescript">
      import * as __ReactNS from "react";
      import { AppRegistry } from "react-native";
      window.React = __ReactNS.default || __ReactNS;
      ${userCode}
      let __C = window.__ArtifactComponent;
      try { if (!__C && typeof App !== "undefined") __C = App; } catch (e) {}
      if (__C) {
        AppRegistry.registerComponent("MobileApp", () => __C);
        AppRegistry.runApplication("MobileApp", {
          rootTag: document.getElementById("root"),
        });
      } else {
        __showErr("This mobile artifact has no default export. Add e.g. export default function App() {}.");
      }
    </script>
  </body>
</html>`;
}

/**
 * Build the srcdoc for a `markdown` document: rendered client-side by `marked`
 * (loaded from a CDN) into a readable prose layout. The source is inlined as a
 * JSON string literal and script-guarded so an embedded `</script>` can't break
 * out. Any raw HTML in the markdown executes only inside the sandbox.
 */
export function buildMarkdownSrcDoc(content: string): string {
  const script = guardScript(`
    (function () {
      var md = ${JSON.stringify(content)};
      var root = document.getElementById("root");
      try { root.innerHTML = window.marked.parse(md); }
      catch (e) { root.textContent = md; }
    })();
  `);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script src="${MARKED_URL}"></script>
    <style>
      html, body { margin: 0; background: #ffffff; color: #1f2328; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; line-height: 1.6; }
      #root { max-width: 760px; margin: 0 auto; padding: 40px 24px; }
      #root h1, #root h2, #root h3 { line-height: 1.25; margin: 1.4em 0 0.6em; }
      #root h1 { font-size: 2em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      #root h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
      #root p, #root ul, #root ol, #root blockquote, #root table { margin: 0 0 1em; }
      #root a { color: #0969da; }
      #root code { background: #f6f8fa; padding: .2em .4em; border-radius: 6px; font: 85% ui-monospace, monospace; }
      #root pre { background: #f6f8fa; padding: 16px; border-radius: 8px; overflow: auto; }
      #root pre code { background: none; padding: 0; }
      #root blockquote { border-left: 4px solid #d0d7de; color: #57606a; padding: 0 1em; }
      #root img { max-width: 100%; }
      #root table { border-collapse: collapse; }
      #root th, #root td { border: 1px solid #d0d7de; padding: 6px 13px; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>${script}</script>
  </body>
</html>`;
}

/**
 * Build the srcdoc for an `image` site: center a single image (URL or data URL)
 * on a neutral canvas. The URL is escaped for safe insertion as an attribute.
 */
export function buildImageSrcDoc(content: string): string {
  const src = content.trim().replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; }
      body { display: grid; place-items: center; background: #ffffff; padding: 16px; box-sizing: border-box; }
      img { max-width: 100%; max-height: 100%; object-fit: contain; }
    </style>
  </head>
  <body><img src="${src}" alt="" /></body>
</html>`;
}

/**
 * Dispatch a Site's stored content + type to the right srcdoc builder. Shared by
 * the public serving route (src/app/s/[slug]/route.ts) and the in-app Site
 * preview so a published site renders exactly like its draft preview.
 */
export function buildSiteSrcDoc(type: SiteType, content: string): string {
  switch (type) {
    case "react":
      return buildReactSrcDoc(content);
    case "mobile":
      return buildMobileSrcDoc(content);
    case "svg":
      return buildSvgSrcDoc(content);
    case "mermaid":
      return buildMermaidSrcDoc(content);
    case "markdown":
      return buildMarkdownSrcDoc(content);
    case "image":
      return buildImageSrcDoc(content);
    case "html":
    default:
      return buildHtmlSrcDoc(content);
  }
}

/**
 * The exact CDN hosts the builders above pull from. The public serving route
 * turns this into the CSP allow-list so published content can reach these — and
 * ONLY these — origins (never the app's own API). Keep in sync with the pinned
 * URLs at the top of this file.
 */
export const SITE_CDN_HOSTS = [
  "https://cdn.jsdelivr.net",
  "https://cdn.tailwindcss.com",
  "https://esm.sh",
] as const;

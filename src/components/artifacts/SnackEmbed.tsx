"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Smartphone } from "lucide-react";

/**
 * Renders a `mobile` artifact in the REAL Expo runtime via an embedded Expo Snack
 * web player. Unlike the local react-native-web preview (buildMobileSrcDoc), Snack
 * bundles arbitrary npm dependencies on demand (Snackager), so it can run apps that
 * use react-navigation / safe-area-context / vector-icons — the libraries the local
 * import map can't resolve — and it is the same runtime that runs on a device.
 *
 * The code is delivered to the cross-origin iframe over postMessage (the handshake
 * Expo's own embed.js performs), NOT in the URL — so there is no URL-length limit
 * and no third-party script is loaded into the app's own origin. Everything runs
 * client-side against Expo's Snack origins; no backend route and no app-side CSP
 * change is involved (the app sets no frame-src on its pages).
 *
 * On-device preview (Expo Go) is delegated to Snack's own site via "Open in Expo
 * Snack": Snack renders the QR and reconciles the Expo Go SDK version there (stock
 * store Expo Go trails the latest SDK).
 */
const SNACK_ORIGIN = "https://snack.expo.dev";

/** npm packages Snack's runtime already provides — never declare these as deps. */
const BUILTIN = new Set(["react", "react-dom", "react-native"]);

/**
 * Best-effort extraction of third-party npm dependencies from RN source so Snack
 * can bundle them (e.g. `@react-navigation/native`). Relative/builtin imports are
 * skipped; a scoped package keeps its `@scope/name`, otherwise the first segment.
 */
export function extractSnackDependencies(src: string): string[] {
  const deps = new Set<string>();
  const add = (spec: string | undefined) => {
    if (!spec || spec.startsWith(".") || spec.startsWith("/")) return;
    const name = spec.startsWith("@")
      ? spec.split("/").slice(0, 2).join("/")
      : spec.split("/")[0];
    if (BUILTIN.has(name) || spec.startsWith("react-native/")) return;
    deps.add(name);
  };
  // Value `import … from '…'` — the negative lookahead skips `import type …`,
  // which is compile-time only and needs no runtime dependency (declaring it
  // could make Snackager fail to resolve a types-only package).
  const valueImport = /import\s+(?!type\s)[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
  // Bare side-effect import `import '…'`.
  const bareImport = /import\s*['"]([^'"]+)['"]/g;
  // `require('…')` and dynamic `import('…')`.
  const call = /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = valueImport.exec(src)) !== null) add(m[1]);
  while ((m = bareImport.exec(src)) !== null) add(m[1]);
  while ((m = call.exec(src)) !== null) add(m[1]);
  return [...deps];
}

/** Detect the app's active theme so the embedded player matches. */
function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  useEffect(() => {
    setTheme(
      document.documentElement.classList.contains("light") ? "light" : "dark",
    );
  }, []);
  return theme;
}

export interface SnackEmbedProps {
  content: string;
  name: string;
}

export function SnackEmbed({ content, name }: SnackEmbedProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // A per-mount id so the handshake targets THIS iframe (matches embed.js).
  const [iframeId] = useState(() => Math.random().toString(36).slice(2, 12));
  const deps = useMemo(() => extractSnackDependencies(content).join(","), [content]);
  const theme = useAppTheme();
  // Whether the frame has completed its one-shot `expoFrameLoaded` handshake, and
  // the exact origin it loaded on (so replies stay symmetric with the receive
  // guard — a *.expo.dev host still works).
  const loadedRef = useRef(false);
  const originRef = useRef(SNACK_ORIGIN);

  // Deliver the code once the frame is ready (waitForData=true), AND re-deliver
  // whenever `content` changes. The frame fires `expoFrameLoaded` only once, so a
  // version switch or streamed update must be HOT-PUSHED to the already-loaded
  // frame (the Expo runtime accepts repeated expoDataEvent). `files` is a JSON
  // STRING keyed by filename — exactly what embed.js delivers — and rides
  // postMessage, not the URL, so there is no size limit.
  useEffect(() => {
    const filesJson = JSON.stringify({
      "App.tsx": { type: "CODE", contents: content },
    });
    const post = () =>
      iframeRef.current?.contentWindow?.postMessage(
        ["expoDataEvent", { iframeId, files: filesJson, dependencies: deps }],
        originRef.current,
      );
    function onMessage(e: MessageEvent) {
      // Guard on shape + iframeId; we only ever post BACK to the frame's own
      // origin, so a spoofed event can't exfiltrate the code. Accept *.expo.dev.
      if (!e.origin.endsWith(".expo.dev") && e.origin !== SNACK_ORIGIN) return;
      const data = e.data;
      if (
        Array.isArray(data) &&
        data[0] === "expoFrameLoaded" &&
        data[1]?.iframeId === iframeId
      ) {
        loadedRef.current = true;
        originRef.current = e.origin;
        post();
      }
    }
    window.addEventListener("message", onMessage);
    // Content changed after the frame already loaded → hot-push the new source.
    if (loadedRef.current) post();
    return () => window.removeEventListener("message", onMessage);
  }, [content, deps, iframeId]);

  const src =
    `${SNACK_ORIGIN}/embedded?iframeId=${iframeId}` +
    `&preview=true&platform=web&supportedPlatforms=web,ios,android` +
    `&theme=${theme}&name=${encodeURIComponent(name)}&waitForData=true`;

  // "Run on device": open the full Snack editor (device tab) with the code, where
  // Snack renders the QR + reconciles the Expo Go SDK. Unlike the embed, the code
  // rides the query string here, so guard the length: past ~14 KB it risks a 414 /
  // truncation, so fall back to the empty editor rather than a broken link.
  const files = JSON.stringify({ "App.tsx": { type: "CODE", contents: content } });
  const fullUrl =
    `${SNACK_ORIGIN}/?platform=mydevice&name=${encodeURIComponent(name)}` +
    `&files=${encodeURIComponent(files)}` +
    (deps ? `&dependencies=${encodeURIComponent(deps)}` : "");
  const tooLargeForLink = fullUrl.length > 14000;
  const openUrl = tooLargeForLink
    ? `${SNACK_ORIGIN}/?platform=mydevice&name=${encodeURIComponent(name)}`
    : fullUrl;

  return (
    <div className="flex h-full w-full flex-col bg-code-bg">
      <iframe
        ref={iframeRef}
        src={src}
        title="Expo Snack preview"
        className="min-h-0 w-full flex-1 border-0"
        allow="clipboard-write; web-share; accelerometer; gyroscope"
      />
      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <Smartphone size={13} />
          Real Expo runtime · resolves npm libraries
        </span>
        <a
          href={openUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={
            tooLargeForLink
              ? "App is large — opens an empty Snack editor; paste from Copy, or use the preview above"
              : "Open in Expo Snack to scan a QR and run on your phone (Expo Go)"
          }
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
        >
          Run on device
          <ExternalLink size={12} />
        </a>
      </div>
    </div>
  );
}

export default SnackEmbed;

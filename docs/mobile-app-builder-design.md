# Mobile App Builder — Enhancement Design

_Status: **Phases 0–2 BUILT & live-verified** (2026-07-18); Phase 3 proposed. Owner: architecture. Extends the unified Artifacts feature (`src/lib/tools/artifacts.ts`, `src/components/artifacts/sandbox.ts`, `src/app/s/[slug]/route.ts`) from web-only to also building mobile apps._

> **Phase 2 build note (2026-07-18):** "Export Expo project" ships — GET `src/app/api/artifacts/[id]/expo/route.ts` generates a real, buildable **Expo SDK 57** project (App.tsx = the artifact source verbatim, since the model is steered to core RN APIs that build natively; + index.ts/package.json/app.json/eas.json/tsconfig/README) as a STORE zip. Versions live in a shared `src/lib/mobile-runtime.ts` (consumed by both the preview importmap and the export, so they can't drift). The panel footer's export is now a dropdown (Expo · native/EAS | Capacitor · web wrapper). No binary is built server-side — the user runs `eas build` (no Mac needed for iOS). Live-verified: export → 200, valid 8-file SDK-57 project (react 19.2.3 / react-native 0.86.0 exact pins, valid reverse-DNS bundle id).

> **Phase 0+1 build note (2026-07-18):** A `mobile` artifact type ships — single-file React Native rendered live via react-native-web in the existing sandbox iframe (`buildMobileSrcDoc` in sandbox.ts), phone-frame preview (`DeviceFrame.tsx` + viewport toggle), publishable via the existing shadow-Site path, and a Capacitor project export (`src/lib/zip.ts` + `src/app/api/artifacts/[id]/capacitor/route.ts`). The importmap was narrowed to **react-native-web core only** after live testing proved react-navigation / react-native-screens / safe-area-context / @expo/vector-icons / expo-status-bar all fail to resolve in-browser (deep RN internals); the model is steered to state-based nav, RNW `SafeAreaView`/`StatusBar`, and emoji icons. A 4-dimension adversarial review (security clean) surfaced 9 low/medium findings, all fixed.

---

## 1. TL;DR / Recommendation

**Ship a phased hybrid that starts at the lowest possible delta and escalates fidelity only when demand proves it out.** Phase 1 is Approach B (a `mobile` artifact type rendered by `react-native-web` inside the existing no-server sandbox iframe, wrapped in a CSS phone frame) fused with Approach A's PWA/Capacitor _exit_ path — because both reuse the importmap + Babel-standalone + `SandboxFrame` + Sites-bindings machinery we already ship, with **no new infra, no cross-origin isolation, and no new CDN host**. Phase 2 adds an "Export Expo project" handoff so the exact same React Native source seeds an EAS cloud build (real signed IPA/APK, no Mac). Phase 3 — real-device preview via an embedded Expo Snack player + QR (Approach C) — is gated behind actual user pull, because it is the only path that breaks our single-file, closed-CSP, opaque-origin model and pulls in an external vendor dependency.

The through-line: **preview and build are two separate planes.** We own the preview plane cheaply in-iframe; we _hand off_ the build plane to Expo/Capacitor rather than standing up a Metro/build farm inside a Next.js + Supabase app.

---

## 2. How Lovable & Emergent.sh actually do it

**Lovable** builds **web only** — it does not generate React Native or Expo. Its official mobile story is exactly our Approach A: make the web app a **PWA** (add-to-home-screen) or wrap the exported Vite/React build with **Capacitor** (a WebView shell) via a third-party GitHub pipeline (Capgo), not an in-product button. Note the trap they document: their new **TanStack Start SSR default breaks Capacitor's static-build requirement** — a WebView wrap needs a static bundle. Their "native mobile app" changelog is _their own_ authoring app, not a capability they give users.

**Emergent.sh** is the one competitor that genuinely generates **Expo / React Native**. Its real-device mechanic is **Expo Go + QR code**: a per-prompt Kubernetes pod runs the Metro dev server, Emergent renders a QR, the user scans it in Expo Go and the RN app loads on a physical phone. Crucially, its **web preview does NOT render the native app** — mobile must be viewed through Expo Go. Whether Emergent itself outputs signed IPA/APK binaries is **contested across sources**; its own tutorial only demonstrates the QR preview and explicitly says you don't install an APK or publish to the store from the product. The "no Mac needed via EAS" marketing is uncorroborated by hands-on teardowns.

**The 5 takeaways that drive this design:**

1. **Nobody builds a signed binary in the browser.** Every serious product hands the user code + a cloud/native build step (EAS for RN, Capacitor CI for web). We should be equally honest: emit an _export + documented build_, not an in-product binary farm.
2. **`react-native-web` in an iframe is the proven zero-infra preview** (a0.dev, Expo Snack's web player). It converts `StyleSheet` → CSS at runtime, needs no server, no `SharedArrayBuffer`, no same-origin — identical constraints to the React preview we already ship.
3. **Device-accurate preview requires a publicly reachable dev server** (Expo Go over a tunnel, or Snack's hosted bundler). A sandboxed no-same-origin iframe _can never host that_. That plane belongs on a vendor's infra, never in our sandbox.
4. **The self-heal loop is the highest-leverage borrow** independent of mobile: postMessage console errors + failed requests from the preview iframe back to the model and silently re-edit until it renders clean (Lovable credits ~90% build-error-rate drop). Applies to every artifact type.
5. **Ownership/export is a trust lever.** "Download the Expo project / push to GitHub" reframes publish as portable output, matching what both products lean on.

---

## 3. Where this app stands today

The builder is the unified **Artifacts** feature. The model calls `create/update/rewrite_artifact` (`src/lib/tools/artifacts.ts`); `/api/chat` intercepts the tool call type-agnostically (`toolNameToArtifactCommand` in `src/lib/artifacts.ts`, ~line 907), `appendVersion()` persists an immutable `ArtifactVersion`, and an `artifact` SSE event (`StreamEvent` union in `src/lib/types.ts:475`) opens the right-hand `ArtifactPanel.tsx`. Every rendered type flows through **one set of pure srcDoc builders** in `src/components/artifacts/sandbox.ts` — `buildReactSrcDoc` (line 161) hoists `export default`, injects the `REACT_IMPORT_MAP` (lines 31–45, all esm.sh `?external=react,react-dom` for single-React dedup), compiles JSX/TS with Babel-standalone in-browser, and mounts into `#root`. `buildSiteSrcDoc(type, content)` (line 280) dispatches by type and is reused verbatim by both the preview and the public serving route.

Publishing an artifact mints a **shadow Site** (`publishArtifact()` in `src/lib/sites.ts:573`), served at `/s/<slug>` (`src/app/s/[slug]/route.ts`) under an opaque-origin CSP `sandbox`, with a **deploy pointer** (`liveVersionId`, `deriveStatus` → draft/deployed/deployed-stale). Published pages get the **mini-app bindings backend** for free via the injected `window.Sites` shim (`src/lib/sites/shim.ts`): KV, append-only docs, blob, per-visitor identity + named accounts, an owner-armed SSRF-guarded fetch proxy, and QuickJS server functions — all isolated in the `sites_data` Postgres schema behind a connection-limited Prisma client (`src/lib/sites/data-db.ts`). The security boundary is `SandboxFrame.tsx` (iframe without `allow-same-origin`) for preview and the CSP `sandbox` header for publish; **`SITE_CDN_HOSTS`** (`sandbox.ts:304` — esm.sh, jsdelivr, tailwindcss) is the single closed allow-list.

**The mobile seam is narrow and known:** a type-enum entry, a renderer, a srcDoc builder, and (only if a new asset host appears) an allow-list addition. Versioning, the deploy pointer, and the bindings backend are all type-agnostic and reusable as-is.

---

## 4. Approach comparison

| Dimension | **A — PWA + Capacitor** (web-artifact → installable) | **B — RN-for-Web `mobile` type** (in-sandbox) | **C — Expo project + Snack + EAS** (real native) |
|---|---|---|---|
| **Preview fidelity** | Responsive web in a phone frame (React DOM) | RN-UI approximation via `react-native-web` (StyleSheet→CSS, real RN primitives) | Device-accurate (real RN on physical phone via Expo Go) |
| **Path to real device** | PWA install (A2HS) now; Capacitor export → store | Publish = web URL; Expo export → EAS for native | Native from day one (Snack/EAS) |
| **Backend reuse** | Full on PWA path (same-origin `window.Sites`); **breaks under Capacitor** (`capacitor://localhost` cross-origin → needs CORS + bearer token) | Full via `window.Sites` on published page (unchanged) | Storage layer only; **cookie visitor identity + pinned connect-src don't transfer** to off-origin native client |
| **Server / infra needed** | New `/manifest.webmanifest` + `/sw.js` routes; CSP `manifest-src`/`worker-src`; **requires `SITES_DOMAIN` real-origin path** | **None** — reuses importmap + iframe + Babel; no new CDN host | Snack embed (cross-origin iframe), EAS build service, poll routes, `MobileBuild` table, CSP widening, new SSE events |
| **Effort** | **L** (routes + CSP + prisma col + UI + docs) | **M** (one builder variant + 19-line renderer + ~6 enum/switch edits) | **XL** (parallel subsystem: multi-file model, vendor integration, build lifecycle) |
| **Fit score** | 8 | 8 | 3 |
| **Key risk** | PWA is **structurally impossible** on the default opaque `/s/<slug>` path; whole feature depends on wildcard DNS/TLS being deployed | `react-native-web` is UI-approximate only — native modules render **blank**, `Platform.OS === 'web'`, `AsyncStorage` **throws** in the opaque sandbox | Breaks every load-bearing assumption (single-file, closed CSP, opaque origin); hard Expo vendor + cost dependency |

**Verdict:** B is the best _fit-per-effort_ for a live in-chat mobile preview and rides our exact model. A supplies the honest _installable/store exit_ for what we already publish. C is deferred until pull exists. Phase them.

---

## 5. Recommended phased roadmap

### Phase 0 — Mobile-first preview chrome (no new type) · Effort: **S**

**Goal:** make the _existing_ html/react artifacts previewable as phones today, and steer the model mobile-first. Zero risk, ships in days, de-risks the phone-frame CSS before any RN work.

- `src/components/artifacts/ArtifactPanel.tsx` — add a **desktop / tablet / phone viewport toggle** that wraps the renderer body in a device-frame div (fixed 390×844, rounded corners, status-bar notch, `env(safe-area-inset-*)`). Purely presentational chrome around the existing `SandboxFrame`.
- `src/components/artifacts/renderers/SandboxFrame.tsx` — accept an optional `maxWidth`/`viewport` prop so the same no-same-origin iframe renders at phone width. **No isolation change.**
- `src/lib/tools/artifacts.ts` — extend `TYPE_DESCRIPTION` (line 23) with mobile-first guidance (viewport meta, ≥44px touch targets, hash-based multi-screen routing within one file).

**End state:** user toggles any artifact into a phone frame; the model tends to produce responsive, touch-friendly layouts. Preview is byte-identical to what publishes.

---

### Phase 1 — The `mobile` artifact type (Approach B) · Effort: **M** · _Ship this quarter_

**Goal:** a first-class `mobile` type whose source is real single-file React Native, previewed live via `react-native-web` in the existing sandbox, publishable to a shareable `/s/<slug>` URL with the full bindings backend.

**Type system — `src/lib/types.ts`:** add `'mobile'` to `ArtifactType` / `ARTIFACT_TYPES` (~704–722) and to `SiteType` / `SITE_TYPES` / `SITE_BUILDABLE_TYPES` (~836–860). `artifactHasPreview()` already returns true for everything but `code`; `isSiteType()` then auto-permits publish. `serializeArtifact`/`appendVersion` validate against `ARTIFACT_TYPES`, so **no data-layer change**.

**Model surface — `src/lib/tools/artifacts.ts`:** add `'mobile'` to the `create_artifact` zod enum (line 50) and a mobile block in `TYPE_DESCRIPTION` (line 23). The `publish_artifact` `isSiteType` gate (line 159) then already allows it. **No `/api/chat` change** — interception is type-agnostic.

**Builder + importmap — `src/components/artifacts/sandbox.ts`:** add `buildMobileSrcDoc()` as a near-clone of `buildReactSrcDoc` (line 161) — same Babel-standalone compile, same `hoistDefaultExport()`, same inline error surface — with three differences:
1. `MOBILE_IMPORT_MAP` extends `REACT_IMPORT_MAP` (see §6 for exact entries), all esm.sh `?external=react,react-dom,react-native` for single-instance dedup.
2. Mount via RNW's `AppRegistry.registerComponent('App', () => window.__ArtifactComponent); AppRegistry.runApplication('App', { rootTag: … })` instead of bare `createRoot` — this installs RNW's flex-column root reset that makes RN layout render faithfully.
3. Bake the CSS phone frame **into the srcDoc body** (not into a React wrapper) so the published `/s/<slug>` page shows identical device chrome with zero route work.

Add a `'mobile'` case to `buildSiteSrcDoc()` (line 280). **`SITE_CDN_HOSTS` (line 304) needs no change** — `react-native-web`, `react-navigation`, safe-area-context, expo-status-bar, and `@expo/vector-icons` all resolve from esm.sh, which is already allow-listed. (Only a custom icon font served off-CDN would require an addition.)

**Renderer — new `src/components/artifacts/renderers/MobileArtifact.tsx`** (mirror `ReactArtifact.tsx`, ~19 lines: `buildMobileSrcDoc(content)` → `SandboxFrame`). Wire a `case 'mobile'` in `ArtifactRenderer.tsx` `renderPreview()` (line 74) and a `'tsx'` return in `codeLanguageFor()` (line 33). Add a phone icon to `TYPE_ICONS` and a `.tsx` mapping in `extensionFor()` in `ArtifactPanel.tsx`.

**Guardrails (system prompt + `TYPE_DESCRIPTION`):** constrain generated RN to web-compatible primitives (`View/Text/Image/ScrollView/FlatList/Pressable/TextInput/Switch/Modal`, `react-navigation`, `StyleSheet`, `Animated`); **forbid native-only modules** (expo-camera/location/notifications, react-native-maps, reanimated worklets); steer persistence to `fetch('/api/kv', …)` via `window.Sites` **not** `AsyncStorage`/`localStorage` (which _throw_ under the opaque origin); note `Platform.OS` reports `'web'`.

**Publish exit (fold in Approach A's Capacitor path) — new `src/app/api/artifacts/[id]/capacitor/route.ts`** + a Download-menu item in `ArtifactPanel.tsx`: zip a Capacitor scaffold (`www/index.html = buildSiteSrcDoc('mobile', content)`, `capacitor.config.ts`, `package.json`, README with `npm i && npx cap sync && cap build`). Reuses the published bundle; no server-side native build.

**End state:** the model emits `type: "mobile"`; the user watches a real RN app render live in a phone frame in-chat, publishes it to a shareable `/s/<slug>` URL that carries the full KV/docs/blob/accounts/proxy backend, and can download a ready-to-build Capacitor project for store submission.

---

### Phase 2 — Native handoff: Expo export + EAS · Effort: **M**

**Goal:** turn the "preview now, native later" promise real without hosting a build farm. Because a `mobile` artifact's content _is_ valid RN source, the same string seeds an Expo project.

- **New `src/app/api/artifacts/[id]/expo/route.ts`** + "Export Expo project" button in `ArtifactPanel.tsx`: zip a scaffold — `App.tsx` = artifact content, plus `app.json` and `package.json` pinning `expo`, `react-native`, `react-navigation`, `react-native-safe-area-context` to the versions `MOBILE_IMPORT_MAP` targeted (keep them in one shared constants module so preview and export never drift).
- README documents `eas build` (Expo cloud, free tier, **builds iOS without a Mac**, produces IPA/APK/AAB) and store submission with the user's own developer accounts.
- **No binary is built on our servers or in-browser.** We hand over a buildable project — exactly the bolt.new / Replit / (honest) Emergent model.

**Honest limit:** an artifact is one content blob, so the export wraps a single `App.tsx`. In-file navigation exports fine; a true multi-file Expo tree needs Phase 3's model.

**End state:** user downloads a buildable Expo project and runs one documented `eas build` command to get a signed binary — no Mac, no in-product build farm.

---

### Phase 3 — Real-device preview via Snack + EAS service (Approach C) · Effort: **XL** · _Gated on demand_

**Goal:** device-accurate preview + in-product build lifecycle. **Only build this if Phase 1/2 usage proves pull** — it introduces a parallel subsystem that breaks our single-file, closed-CSP, opaque-origin assumptions. Track it here so the earlier phases don't paint us into a corner.

- **Multi-file substrate:** reuse the existing per-conversation coding workspace (`.workspaces/<conversationId>/repo` via `src/lib/tools/index.ts`) as the Expo project tree, since `applyArtifactCommand`/`appendVersion` only version a single blob. Needs a sibling "mobile project" concept (workspace pointer + build records), not a pure render-type enum.
- **Snack embed preview — new `src/components/artifacts/renderers/SnackEmbed.tsx`:** a **cross-origin** iframe to `snack.expo.dev` (deliberately _not_ wrapped in `SandboxFrame`, which forbids same-origin and pins CDNs) + a client-generated **QR** encoding the Snack URL for Expo Go. Snack bundles server-side (snackager) and relays via SnackPub, so we host no Metro server.
- **CSP widening (scoped):** add `snack.expo.dev` / Expo asset hosts to `frame-src`/`connect-src` **only for the mobile authoring panel** — must NOT leak into `OPAQUE_CSP`/`REAL_ORIGIN_CSP` on the public `/s/<slug>` serving route.
- **Build service — new `src/app/api/mobile/build/route.ts`** + status-poll route (template: the scheduled-tasks poll pattern): trigger EAS Build with the user's stored `EXPO_TOKEN`, persist a **new `MobileBuild` table** (buildId, platform, status, artifact URLs, snack URL) in prisma, surface IPA/APK/AAB URLs. **New `StreamEvent` variants** (`snack-ready`, `build-status`) in `src/lib/types.ts` + `src/store/chat.ts` handling.
- **Backend access gap:** the `sites_data` store (`data-db.ts`) is reusable, but its cookie-based visitor identity (`src/lib/sites/visitor.ts`) and pinned `connect-src` do **not** work for an off-origin native client — reusing the backend from a device app requires net-new CORS + bearer-token auth.

**End state:** user scans a QR, sees the real app on a physical phone, and triggers a cloud build to a downloadable signed binary from inside the product.

---

## 6. Preview strategy (per phase)

**Phase 0/1 — phone-frame iframe + `react-native-web` importmap (the workhorse).** The user sees the app live in the existing `ArtifactPanel` right pane. `buildMobileSrcDoc()` feeds the same no-same-origin `SandboxFrame`; the phone chrome is pure CSS baked into the srcDoc body (fixed device viewport, notch, bezel), responsive to full-bleed via media query when opened on a real phone. Entirely client-side — Babel + esm.sh over postMessage isolation, no dev server, no tunnel, no `SharedArrayBuffer`. Native-only components render **blank** (not crash); compile/runtime errors reuse `buildReactSrcDoc`'s inline error surface.

**`MOBILE_IMPORT_MAP` (`sandbox.ts`) — VALIDATED in the Phase-1 spike (2026-07-18):**

```
"react-native":     "https://esm.sh/react-native-web@0.19.13?external=react,react-dom",
"react-native-web": "https://esm.sh/react-native-web@0.19.13?external=react,react-dom",
```
(plus the four core `react` / `react-dom` entries.) `react-native-web` is `?external=react,react-dom` so it shares the single React instance (the de-dup that avoids invalid-hook-call). Host is esm.sh → **no `SITE_CDN_HOSTS` change**.

> **Empirical correction to the original design.** The obvious additions —
> `react-navigation` (native-stack + bottom-tabs), `react-native-screens`,
> `react-native-safe-area-context`, `@expo/vector-icons`, `expo-status-bar` — were
> each tested in the real sandbox and **all fail to resolve through esm.sh**: they
> import deep RN internals such as
> `react-native/Libraries/Utilities/codegenNativeComponent` that react-native-web
> does not implement (safe-area-context, screens, native-stack), fail to fetch
> (@expo/vector-icons), or lack the expected named export (`expo-status-bar` only
> ships a `default`). The importmap is therefore **core-only**, and the model is
> steered (agent.ts) to: **state-based navigation** (a `useState` screen switcher +
> a hand-built tab bar), **`SafeAreaView` + `StatusBar` from `react-native`**, and
> **emoji / `View` shapes for icons**. Validated working in-browser: `View`, `Text`,
> `Image`, `ScrollView`, `FlatList`, `Pressable`, `TouchableOpacity`, `TextInput`,
> `Switch`, `Modal`, `StyleSheet`, `Animated`, `SafeAreaView`, `useState` +
> `onPress` interactivity, and state-based multi-screen navigation.

**Phase 3 — Snack embed + QR.** Device-accurate preview inherently needs a publicly reachable dev server that the opaque sandbox can never host, so it lives on Expo's infra: a cross-origin `SnackEmbed` iframe to `snack.expo.dev` (Snack bundles server-side) plus a QR the user scans in Expo Go. An optional in-sandbox `react-native-web` render can give fast approximate feedback between device scans — but **two previews that disagree is a real UX/QA risk** (§8).

---

## 7. Backend & publish

**Backend — reuse the mini-app bindings verbatim.** `resolveBackendSite()` (`src/lib/sites/gate.ts`) keys off the link+live+enabled predicate regardless of content type, so a published `mobile` artifact gets KV / append-only docs / blob / per-visitor accounts / owner-armed fetch proxy (secrets injected server-side) / QuickJS functions for free via the injected `window.Sites` shim (`src/lib/sites/shim.ts`), isolated in the `sites_data` schema. **No new table, no `siteStore` method, no gate change.** The critical model guardrail: because `AsyncStorage`/`localStorage` throw under the opaque sandbox, generated apps must persist through `fetch('/api/kv', …)` via the shim, not RN's native storage. In the in-app preview there is no backend (same as every type today); bindings light up only on the published page.

**Publish — reuse the deploy pointer.** `publishArtifact()` (`src/lib/sites.ts:573`) mints the shadow Site; `/s/<slug>/route.ts` calls `buildSiteSrcDoc('mobile', content)` and serves it phone-framed under the existing `OPAQUE_CSP`. Result: a real, linkable URL rendering the app in a device frame in any browser — the RNW showcase plane. Auto-publish stays gated by `User.sitesAutoDeploy`.

**How a finished mobile app actually ships — three honest exits, in fidelity order:**
1. **PWA install (Approach A, requires `SITES_DOMAIN`):** only on the real-origin subdomain path (`REAL_ORIGIN_CSP`, sandbox dropped) can a service worker register. Inject `<link rel=manifest>` + SW registration in `s/[slug]/route.ts`, add `/manifest.webmanifest` + `/sw.js` sibling routes, add `manifest-src 'self'`/`worker-src 'self'` to `REAL_ORIGIN_CSP`, and a `Site.installable` flag. **This is impossible on the default opaque `/s/<slug>` path** — verify wildcard DNS/TLS is deployed before promising it, and disable/hint the toggle when `SITES_DOMAIN` is unset. iOS caps are real (~50MB cache, ~7-day eviction, no background sync/silent push).
2. **Capacitor export (Phase 1):** zip the published web bundle as a Capacitor project → user runs `cap build` on a Mac or CI (Appflow/Capgo/GitHub Actions) for a signed AAB/IPA. Caveat: the `window.Sites` same-origin backend **breaks** under `capacitor://localhost` — store apps needing the backend require absolute-URL fetches + CORS + bearer token (the host-only app cookie is unreachable cross-origin by design).
3. **EAS build (Phase 2/3):** export the Expo project → `eas build` in Expo's cloud produces a signed binary without a Mac. Store submission (paid Apple/Google accounts, signing, review) stays user-driven and outside the product.

---

## 8. Risks, open questions, and what to prototype first

**Prototype first (1–2 day spike, de-risks the whole plan):** a hand-written `buildMobileSrcDoc()` with the §6 importmap rendering a `View/Text/FlatList/Pressable` + `react-navigation` app inside the current `SandboxFrame`. Validate: (a) esm.sh resolves `react-native-web`'s transitive deps without a version-skew blank frame; (b) `AppRegistry.runApplication` mounts correctly with `SafeAreaProvider`/`NavigationContainer` and a full-height flex root, in **both** the light preview and the published `/s/<slug>` path (they share the srcDoc); (c) the CSS phone frame + safe-area insets look right. This single spike validates Phase 1's core bet.

**Risks & constraints:**
- **The sandbox is opaque by design.** `SandboxFrame` omits `allow-same-origin`; the published page enforces CSP `sandbox`. This permanently blocks service workers, PWA install, and native device APIs on the preview/opaque path — RNW previews can never themselves become installable apps. Communicate this ceiling; don't paper over it.
- **`react-native-web` is UI-approximation, not native.** Native-only modules render blank, `Platform.OS === 'web'` so OS-branched code silently takes the web path, and `AsyncStorage` throws. Hard-constrain the allowed library set in model guidance; a bare specifier not in `MOBILE_IMPORT_MAP` **fails silently** under the strict CSP — surface it in the inline error box.
- **esm.sh version skew** between `react-native-web` and a `react-navigation` build can produce a blank frame with a cryptic module error. Pin versions in one shared constants module (used by both `MOBILE_IMPORT_MAP` and the Phase 2 export) and add a smoke test per bump.
- **PWA depends on infra we may not have.** The entire installable-PWA story requires the `SITES_DOMAIN` real-origin path (wildcard DNS + TLS). Confirm it's deployed before promising PWA install; otherwise Capacitor export is the only real installable and the PWA UI must be gated/hinted.
- **Expectation gap.** A convincing phone-framed preview implies a native app when publish only yields a web URL and native requires a manual EAS export. Copy must set expectations honestly at every surface.
- **Phase 3 cost/vendor dependence.** EAS build minutes and Snack limits are metered and outside our control; users must supply an Expo token (onboarding friction + credential surface). CSP widening for the Snack embed must be tightly scoped to the authoring panel, never the public serving route. Two disagreeing previews (approximate RNW vs on-device Expo Go) generate QA noise — decide whether to show both.

**Open questions:**
- Manifest **icon generation** per site is unspecified — without a real icon, PWA install prompts degrade. Need a default or a generated icon.
- Should Phase 1 add a `mobile` enum entry purely for UI labeling, or treat mobile as a normal `react` artifact with a phone frame? (Design assumes a real `mobile` type for clean renderer routing and export affordances.)
- Do we invest in the **self-heal loop** (§2 takeaway 4) alongside Phase 1? It compounds value across all artifact types and directly reduces blank-frame confusion for mobile.

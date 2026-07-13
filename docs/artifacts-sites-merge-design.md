# Merging Artifacts + Sites into one Claude‑Desktop‑style Artifacts feature

**Status:** Research / design only — nothing built.
**Reconciled with commit `9e140fc` (SQLite → local Supabase Postgres).**

> ⚠️ **This file was swept once by a concurrent process on the shared working tree**
> (it was uncommitted; the tree was reset to `9e140fc`). Durable copies live in the
> session's memory + the published visual brief artifact. **Commit this doc to preserve
> it.**

Produced by two research workflows: an 11‑agent design study (4 code‑mappers · 3
Claude‑Desktop web‑researchers · 3 designs · 1 judge), then a 5‑agent adversarial
reconciliation against the Postgres migration (4 claim‑verifiers · 1 completeness critic).

**Ask:** *"Merge the current Artifacts and Sites into one Artifacts like Claude Desktop
where you manage the live artifacts, clone exactly how Claude Desktop does it."*

---

## 0. TL;DR — the recommendation

> **Ship one unified "Artifacts" experience on top of the two tables we already have.**
> The repo's split — an *ephemeral, conversation‑scoped* `Artifact` vs a *durable,
> user‑owned, publishable* `Site` — is **already Claude Desktop's own
> "private‑in‑chat‑until‑you‑Publish" model.** We are not missing a data model; we are
> missing the *unification of the surface.* Do the merge as **one additive column + UX
> consolidation**, not a table rebuild.

- **Data (Phase 0):** keep `Artifact/ArtifactVersion` and `Site/SiteVersion` physically
  separate. Add one **plain pointer** `Artifact.publishedSiteId` (+ `remixedFromSiteId`).
  On Postgres this is a schema edit + **`npm run db:push`** (the sanctioned path now).
- **Tools (Phase 2):** four verbs on one noun — `create_artifact` / `update_artifact` /
  `rewrite_artifact` / **`publish_artifact`**. Retire the site tools from the model.
- **UI (Phase 1):** one sidebar **"Artifacts"**, one gallery, one panel, one chip.
  `ArtifactLibrary.tsx` **already exists** (184‑line gallery on `/api/artifacts`) — Phase 1
  *adapts* it, it doesn't build it from scratch.
- **The Sites mini‑app backend stays LIVE** as a gated *"Advanced: connected app"* tier —
  the faithful analog of Claude's June‑2025 `window.claude.complete` AI‑apps, and now
  **production‑hardened** by the Postgres migration (atomic quota, advisory locks, 503
  backpressure).
- **Single‑primitive collapse** (fold `Site` into `Artifact`) is the correct *north‑star*
  but stays an **optional, decision‑gated Phase 4**. It got *cheaper* on Postgres (trivial
  `DROP NOT NULL`) but is not free.

**Judge scores:** Design 3 (Faithful, phased) **8.3** · Design 2 (One library, two tables)
**8.0** · Design 1 (Artifact‑is‑the‑primitive) **6.4**.

---

## 1. What the SQLite → Postgres migration (`9e140fc`) changed for this plan

The merge was first designed against a SQLite datastack. Commit `9e140fc` moved **both**
stores (primary app DB + the isolated Sites mini‑app data plane) to **local Supabase
Postgres**. The design survives — the recommendation is unchanged — but five load‑bearing
assumptions had to be re‑derived (all verified against the commit + tree):

| Old (SQLite) assumption | Reconciled reality (Postgres) |
|---|---|
| "Write the migration as **hand‑SQL via `sqlite3`; NEVER `prisma db push`** (`dev.db` has 17 orphan tables)" | **`npm run db:push` is the sanctioned path** (`prisma db push` for both schemas). Hand‑SQL `scripts/migrate-*.sql` were **deleted**. The orphan‑table hazard was a `dev.db` artifact — gone on greenfield Postgres. *(`prisma migrate` only for a hosted deploy.)* |
| "FK enforcement is off app‑wide; **all delete cascades are emulated**" | **Declared `@relation onDelete:Cascade` are now real Postgres FK cascades** (16 of them, incl. `Artifact→Conversation` `schema.prisma:180`, `ArtifactVersion→Artifact` `:198`, `Site→User` `:243`, `SiteVersion→Site` `:267`). **Only plain pointer columns** (`parentId`, `liveVersionId`, `sourceArtifactId`, `createdInConversationId`, `pluginId`) + the cross‑schema plane purge stay app‑emulated. |
| "`sites-data.db` — a **separate SQLite DB file**; no cross‑**DB** FK" | The plane is a **`sites_data` Postgres SCHEMA** in the one DB, reached by a connection‑limited role (`openagent_sites_rw`) via a **separate Prisma client + capped pool**. DoS isolation is now **connection‑budget partitioning**, not single‑writer‑per‑file. Barrier is "**no cross‑SCHEMA FK**". "Never remap `Site.id`" still holds. |
| Phase 4: "relax `conversationId NOT NULL` needs a **big‑bang SQLite table rebuild**" | `ALTER TABLE "Artifact" ALTER COLUMN "conversationId" DROP NOT NULL` is **catalog‑only online DDL** (no rewrite). Phase 4 got materially cheaper — *but* gained a new FK hazard (see §6 Phase 4). |
| Phase 0: "build the **missing** `ArtifactLibrary.tsx` (broken `/artifacts` page)" | `ArtifactLibrary.tsx` **now exists** (184‑line Claude‑style gallery). Phase 1 *adapts* it. *(Orthogonal to `9e140fc` — concurrent UI work.)* |

**Net:** the merge direction is *reinforced*. The mini‑app plane the design votes to keep
is now hardened, and the one genuinely new *design* constraint is a Postgres transaction
subtlety in the Phase‑2 publish path (§6 Phase 2).

---

## 2. The reference model — how Claude Desktop actually does it

Grounded from Anthropic's help center + launch posts (§Appendix). The load‑bearing facts:

- **Private by default.** An in‑chat artifact is *ephemeral to the chat until you click
  Publish* → **exactly our `Artifact` (ephemeral) vs `Site` (published) split.**
- Types (docs/code/HTML/SVG/Mermaid/React) → **our 7 artifact types already match.**
- **Every edit = a new version**; a bottom version selector steps through history; viewing
  an old version doesn't erase the model's memory → **our append‑only `ArtifactVersion`.**
- Lower‑right of the panel: view code / copy / download → **our panel already matches.**
- **Publish** (Free/Pro/Max) mints a **persistent public link** on a Claude‑owned host
  (`claude.site/artifacts/<uuid>` / `claude.ai/public/artifacts/<uuid>`); no account to
  view → **our `/s/<slug>` under the CSP `sandbox` opaque‑origin header is the same thing.**
- **Same URL, auto‑latest by default, pin a version optionally** → **our `liveVersionId`
  pointer + `deployed-stale` status.**
- **Customize / Remix**: a signed‑in viewer copies a shared artifact into a *new*
  conversation → *net‑new `remixSiteToArtifact` reverse bridge.*
- **Publish promotes the artifact into the sidebar Artifacts space** (a full‑window card
  gallery, launched 2025‑06‑25) — an in‑chat artifact does not auto‑appear.
- **June 2025 "AI‑powered apps":** React artifacts call Claude via `window.claude.complete`;
  **inference billed to the viewer** → **the direct analog of our Sites mini‑app backend.**

**Punch‑line:** Claude Desktop has **no separate "Sites."** An artifact **is** the thing
you publish. The merge = **stop presenting our already‑built publishing (Sites) as a second
product.** The repo already has the bridge (`createSiteFromArtifact`) and the library.

---

## 3. Current state — the duplication inventory

Concrete seams a merge collapses:

**Data / persistence** — `applyArtifactCommand` (`artifacts.ts:370`) ↔ `applySiteCommand`
(`sites.ts:756`); `toolNameToArtifactCommand` ↔ `toolNameToSiteCommand`; `ArtifactVersion`
(`schema.prisma:186`) ↔ `SiteVersion` (`:250`, adds `commit`+`label`); `ARTIFACT_TYPES` ↔
`SITE_TYPES` (`SITE = ARTIFACT preview − 'code'`).

**Chat wiring** — route interception `route.ts:911‑935` (artifact) ↔ `:939‑972` (site),
both suppress the generic tool card; `StreamEvent` `{type:'artifact'}` ↔ `{type:'site'}`;
`ArtifactRef`/`Message.artifactRefs` ↔ `SiteRef`/`Message.siteRefs`; store `applyEvent`
`chat.ts:919` (upsert + open panel) ↔ `:992` (ref‑only, **no** panel) — post‑actions differ.

**UI** — `ArtifactChip` opens the **in‑chat panel**; `SiteChip` **navigates to `/sites/[id]`**;
`ArtifactsApp`/`ArtifactLibrary` ↔ `SitesApp`/`SitesList` duplicate the shell + grid; parallel
`Sidebar` nav.

**The bridge that already exists** — `createSiteFromArtifact` (`sites.ts:521`) +
`PublishSiteButton` (POST `/api/sites {fromArtifactId}`). *A Site is a promoted, detached,
user‑owned artifact.* **This is the merge seam.**

---

## 4. Designs considered

| # | Name | Effort | Score | One‑liner |
|---|------|--------|-------|-----------|
| 3 | **Faithful Claude Desktop Clone, Phased** | M | **8.3** | Reframe the existing two‑object split as Claude's draft‑then‑Publish; keep both tables; `createSiteFromArtifact` becomes canonical "Publish"; mini‑app = gated advanced tier. |
| 2 | **One Library, Two Tables** | M | **8.0** | Collapse the *user‑facing* surface into one library + panel + chip; "Publish" is an artifact action that links a Site underneath; "Sites" disappears from the UI. |
| 1 | **Artifact is the Primitive** | L | **6.4** | Fold `Site` into `Artifact` → one user‑owned versioned primitive. Correct *north‑star*; a bigger cutover that also freezes the mini‑app. |

**Recommendation = 3's safe additive base + 2's tool consolidation & in‑place publish; 1 held
as the optional destination.** The three are one trajectory: 1 is the end‑state, 2/3 are the
safe way to start.

---

## 5. Recommended design (the synthesis)

### 5.1 Unified data model (additive only)
Keep `Artifact/ArtifactVersion` (conversation‑scoped, ephemeral) and `Site/SiteVersion`
(user‑owned, durable) **physically separate**. Add:

- `Artifact.publishedSiteId String?` — forward pointer to the shadow Site.
- `Artifact.remixedFromSiteId String?` — provenance for Customize/remix.

**Keep `publishedSiteId` a PLAIN pointer, NOT a declared `@relation`** — for
dangling‑tolerance and to match the app's pointer convention (it mirrors `liveVersionId`
and `Site.sourceArtifactId`). So when a published Site is deleted, the Artifact is simply
left with a nulled pointer.

> **Corrected rationale (an adversarial verifier caught the original reasoning inverting
> Prisma's `onDelete` direction):** `onDelete` sits on the *child* (FK‑holding) side and
> fires when the *parent* is deleted. `Artifact.publishedSiteId → Site` makes **Artifact the
> child, Site the parent**, so a cascading FK there would mean *"delete the Artifact when the
> Site is deleted"* — the **opposite** problem (it would yank a published artifact's source
> out of its chat), and it would **never** threaten the Site's survival. The real
> *"a published Site must outlive its chat"* hazard lives on the **reverse** pointer
> `Site.sourceArtifactId` (`Site→Artifact`), which is **already** a plain app‑nulled column
> precisely so that deleting the source Artifact — or its Conversation (via the now‑real
> `Artifact→Conversation` cascade at `schema.prisma:180`) — cannot cascade into deleting the
> Site.

**Invariants preserved:** `@@unique([conversationId,identifier])`,
`@@unique([artifactId,version])`, `@@unique([siteId,version])`, the `liveVersionId`
plain‑pointer contract + `deriveStatus` dangling tolerance, `User.sitesAutoDeploy` as the
publish gate. **Never remap a `Site.id`** — no cross‑schema FK, so it orphans all `sites_data`
rows.

### 5.2 Tool surface — four verbs, one noun
Keep `create/update/rewrite_artifact`. **Retire `create_site` + `update_site` from the
model** (DB code stays). **Replace `deploy_site` with `publish_artifact(identifier,
visibility?, version?)`** — a single choke‑point: resolve artifact → `createSiteFromArtifact`
(reuse the bridge + `isSiteType` guard; `'code'` rejected) → `appendVersion` → deploy **iff**
`User.sitesAutoDeploy`. It is the **only** path that mutates the
`publishedSiteId ↔ sourceArtifactId` pair. Widen `isArtifactToolName`; preserve the route's
ordered fan‑out + break‑to‑suppress‑generic‑card + `tool_result` skip. Net‑new server
function `remixSiteToArtifact(userId,{siteId,conversationId})` (copies the **live**
`SiteVersion`, never the draft) for Customize.

> ⚠️ **Postgres transaction constraint (new, from the reconciliation).** Both
> `appendVersion` retry‑on‑collision loops (`artifacts.ts:197`, `sites.ts:378`) catch a
> unique‑violation and retry by re‑reading `MAX(version)+1`. This works **only** because each
> Prisma call is its own implicit transaction. **Postgres aborts the entire transaction on a
> unique‑constraint violation** (SQLSTATE 25P02) — unlike SQLite, where the failed statement
> leaves the tx usable. So `publish_artifact` / `remixSiteToArtifact` **must not wrap
> `appendVersion` inside a `prisma.$transaction()`** (the retry's re‑read would throw "current
> transaction is aborted" and the collision would not recover). Keep `appendVersion` outside
> any interactive tx, or open a fresh tx per retry attempt.

### 5.3 UI — one library, one panel, one publish flow
1. **Adapt the existing `ArtifactLibrary.tsx`** (184‑line gallery on `loadUserArtifacts` +
   `GET /api/artifacts`) into a full‑window card gallery with two sections: **"Your
   artifacts"** = published objects (today's Sites, via a reframed `SitesList`/`SiteCard`,
   showing live link + `deriveStatus`) and **"Recent"** = in‑chat artifacts across chats.
2. **One sidebar "Artifacts" entry.** Delete the Globe "Sites" entry + `/sites` rows.
3. **`ArtifactPanel` stays** the in‑chat right‑hand split view. Footer: Copy / Download /
   version‑selector; **"Publish as Site" → "Publish"**; once published, a **"Published ▾"**
   menu (Copy public link · Open live · View versions · Pin‑vs‑always‑latest · Unpublish ·
   Manage backend). **Publishing updates the same open panel in place** — no `router.push`.
4. **`MessageItem` stops rendering `SiteChip`**; a small adapter maps historical `siteRefs`
   into `ArtifactChip` DTOs. Preserve single‑occupancy + the svg/mermaid/image no‑auto‑open
   policy.
5. **`SiteDetailView` survives only** as the re‑skinned per‑published‑artifact management
   page / "Advanced" backend drawer.

### 5.4 Publish / live‑URL / share mechanics
Private by default. Publish is explicit — human via POST `/api/sites` (relabeled) or model
via `publish_artifact` **only when `sitesAutoDeploy` is on**. Publish creates/links the shadow
Site, flips `visibility` private→`link`, `appendVersion`s, `deploySite` moves `liveVersionId`.
Durable URL = existing global‑unique unguessable `/s/<slug>` under the CSP `sandbox`
opaque‑origin header + shared `buildSiteSrcDoc`/`SITE_CDN_HOSTS`; add a **`/a/<slug>` alias**
so new links read as "artifacts". Default auto‑latest at the same link; a **Pin** control
freezes `liveVersionId`. **Unpublish** nulls `liveVersionId` + sets private (link 404s) +
clears `publishedSiteId`, **but keeps the slug** so republish is one click (drop Claude's
can't‑republish quirk). Deleting the chat deletes the ephemeral Artifact but leaves the
published Site **live**. Customize = `remixSiteToArtifact` (signed‑in only). Single public
tier; `workspace` deferred.

> If `/a/<slug>` serves the mini‑app backend via its own `/api/` handler (not a pure rewrite
> to `/s/`), it **must replicate `isPoolBusy → 503 + Retry‑After`** (added to
> `s/[slug]/api/[...path]/route.ts` in `9e140fc`), or a write flood regresses to an opaque 500
> and the connection‑budget DoS story silently breaks on the new path.

### 5.5 Fate of the mini‑app backend — **PRESERVED, now hardened**
The `sites_data` Postgres schema, tenant‑scoped `siteStore`, arming/approval model,
KEK‑encrypted write‑only secrets, SSRF‑guarded proxy, QuickJS functions, and quota limiter
are large, security‑reviewed work — **and the faithful analog of Claude's
`window.claude.complete` AI‑apps tier.** Commit `9e140fc` **production‑hardened exactly this
plane**: `bumpUsage` → atomic increment (closes a quota **bypass** the SQLite single‑writer
had masked), `consumeEndpointBudget` → atomic guarded `updateMany` (daily‑budget bypass),
`kvPut`/`kvDelete` → `pg_advisory_xact_lock` (counter‑drift + ABBA‑deadlock), pool
exhaustion → 503. So the "keep it live, ~free" call is now **materially safer**.
- Relocate its UI into **"Published ▾ → Manage backend"** / an "Advanced: connected app"
  drawer. Only published artifacts (those with a shadow Site) get a backend.
- Keep the **identical public‑gate predicate** in `loadPublicSite` **and**
  `resolveBackendSite` byte‑for‑byte (no existence‑oracle regression).
- **Caveat:** the plane is no longer literally free‑standing — it now depends on the local
  Supabase stack **plus** the bootstrap migration
  (`supabase/migrations/20260713000000_bootstrap_sites_plane.sql`) that creates the
  `sites_data` schema + the connection‑limited `openagent_sites_rw` role.

---

## 6. Phased plan

**Phase 0 — Safe base (self‑contained; commit early — the tree sweeps).**
Edit `prisma/schema.prisma`: add `Artifact.publishedSiteId String?` + `remixedFromSiteId
String?` (plain columns). Apply with **`npm run db:push`** then `npm run db:generate` — **not**
`sqlite3`, **not** hand‑SQL. Backfill `publishedSiteId` from `Site.sourceArtifactId` with a
**same‑schema trivial `UPDATE`** (both tables live in `public`; no cross‑schema barrier).
`ArtifactLibrary.tsx` already exists — no build needed.
*Deliverables:* the additive columns + guarded backfill, regenerated client.

**Phase 1 — Unified UX (hunk‑stage shared files).**
One sidebar "Artifacts"; delete Sites nav. Two‑section gallery (adapt `ArtifactLibrary`).
"Publish as Site" → "Publish" + "Published ▾" menu; publish updates the same panel in place.
`siteRefs → ArtifactChip` adapter. Preserve single‑occupancy + no‑auto‑open.

**Phase 2 — Tool‑surface consolidation.**
Add `publish_artifact` (single choke‑point folding `createSiteFromArtifact` + version +
`canDeploy`). Retire `create/update_site` from the model. Add `remixSiteToArtifact`.
**Honor the Postgres tx constraint in §5.2** — do not wrap `appendVersion` in an interactive
transaction.

**Phase 3 — Advanced tier + parity extras.**
Mini‑app backend only via "Published ▾ → Manage backend"; arming/approval + secrets +
two‑schema isolation unchanged. `/a/<slug>` alias (must carry the 503 backpressure).
*Optional:* `window.claude.complete`‑style bridge + KV storage for published React artifacts
(flagged); embed code + Allowed‑domains; Markdown in‑place "Edit with Claude."

**Phase 4 — OPTIONAL single‑primitive fold (decision‑gated).**
Cheaper on Postgres — `ALTER TABLE "Artifact" ALTER COLUMN "conversationId" DROP NOT NULL` is
catalog‑only online DDL (no rewrite) and real FK cascades cut hand‑cascade risk. **But still
gated, and with a NEW Postgres hazard:**
- **Flip `Artifact→Conversation` from `Cascade` to `SetNull`** (together with making
  `conversationId` nullable). A folded, durable published artifact whose origin conversation
  is later deleted would otherwise be **DB‑cascade‑deleted** by the now‑real FK — destroying
  live published content. (Invisible under SQLite, where the cascade was app‑emulated.)
- The `sites_data` plane keys every row by a plain `siteId` with **no cross‑schema FK**, so an
  **id‑preserving fold is still mandatory** to avoid orphaning the mini‑app plane.
- `liveVersionId` stays an app‑emulated plain pointer (avoids a required‑FK cycle); an
  `Artifact↔Site` FK would be a *convention choice* (same schema), not an impossibility.
*Net:* cheaper, not free — or an explicit decision to stay dual‑table permanently (legitimate).

---

## 7. Migration & shared‑tree safety notes (Postgres)

- **`prisma db push` is the sanctioned path** (`npm run db:push` runs it for `public` +
  `sites_data`). The repo is "a db‑push shop" (see `docs/supabase-local-migration-design.md`
  §7); adopt `prisma migrate` only for a persistent/hosted Supabase. `DATABASE_URL` (runtime)
  vs `DIRECT_URL` (schema ops) — CLI ops need the direct/session endpoint.
- **Cascade reality is now split, not "all emulated":** declared `@relation onDelete`
  cascades are **DB‑enforced FKs**; only plain pointers (`parentId`, `liveVersionId`,
  `sourceArtifactId`, `createdInConversationId`, `pluginId`) + the cross‑schema plane purge
  stay app‑emulated. Re‑scope any "preserve the emulated cascades verbatim" instruction to
  those, not to all cascades.
- **`deleteUserSites`‑first is now load‑bearing (HIGH).** `Site→User` is a real FK cascade, so
  `prisma.user.delete` (`user/route.ts:117`) auto‑cascades away the `Site`+`SiteVersion` rows.
  But that cascade **does not reach** the `sites_data` schema rows or the on‑disk blobs (no
  cross‑schema FK). So `deleteUserSites` (`route.ts:114`) must **enumerate site ids and run
  `siteStore.purgeSite` (8 `sites_data` tables) + `removeSiteBlobs` FIRST**, while the Sites
  still exist to enumerate — else the plane orphans permanently. *(Stale comment to fix:
  `sites.ts:611` still says "isolated sites-data.db".)*
- **Two‑SCHEMA isolation** (not two files): the plane is a `sites_data` schema reached by a
  connection‑limited role via a **separate Prisma client + capped pool** — a public write
  flood at `/s/<slug>` queues on that pool and can't starve the app. Keeping it a **separate
  client** (not one `multiSchema` client) is load‑bearing. **Never remap `Site.id`.**
- **Shared working tree.** It's hot with concurrent WIP and **already swept this doc + other
  uncommitted files once.** Commit self‑contained new files (this doc, Phase‑0 columns) early;
  hunk‑stage shared files (`route.ts`, `types.ts`, `Sidebar`, `MessageItem`, `store/chat.ts`).

---

## 8. Open questions (need a human decision)

1. Take the Phase‑4 table‑fold (now cheaper on Postgres) or stay dual‑table permanently?
   Decide at the Phase‑4 gate.
2. Build the on‑model backend piece — a scoped `window.claude.complete`‑style completion
   bridge (inference billed to the viewer) + KV storage for published React artifacts?
3. Audit historical live Sites with the backend **enabled** before any UI deprecation so no
   live `/s/[slug]/api/*` consumer 404s.
4. Markdown in‑place "Edit with Claude" — build or defer?
5. Org/Team share tier (`visibility='workspace'`, stubbed) — build, or ship a single public
   tier and label the gap a deliberate cut?
6. Opening a published artifact from the gallery — fresh chat or detached view? *(Recommend
   detached, with a back‑pointer.)*
7. `shareLatest` default — auto‑latest vs pin; may the model (via `sitesAutoDeploy`)
   auto‑advance the live pointer, or only humans?
8. `publishedSiteId` as a second source of truth alongside `Site.sourceArtifactId` — periodic
   consistency check, or is the single publish/unpublish/delete choke‑point enough? *(Recommend
   choke‑point is enough.)*

---

## Appendix — key sources (Claude Desktop behavior)

- Anthropic help — *What are artifacts* — support.claude.com/en/articles/9487310
- Anthropic help — *Publish and share artifacts* — support.claude.com/en/articles/9547008
- Anthropic — *Build & share AI‑powered apps* (2025‑06‑25) — claude.com/blog/claude-powered-artifacts
- Anthropic — *Artifacts space* (2025‑06‑25) — claude.com/blog/build-artifacts
- Anthropic — *Artifacts GA* (2024‑08‑27) — anthropic.com/news/artifacts
- Anthropic — *Artifacts in Claude Code* / live artifacts (2026‑06) — claude.com/blog/artifacts-in-claude-code
- Simon Willison — *AI‑powered apps with Claude* (2025‑06‑25) — simonwillison.net/2025/Jun/25/ai-powered-apps-with-claude/

*Full per‑agent research, the three design proposals, and the 5‑agent Postgres reconciliation
are archived in this session's workflow transcripts. Repo migration facts:
`docs/supabase-local-migration-design.md` + commit `9e140fc`.*

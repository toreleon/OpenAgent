# Migrating OpenAgent's datastack to local Supabase (Studio) — design & research

**Status:** Research / design. Nothing built. Supersedes the narrower "Supabase = just
Postgres" framing in the `docker-supabase-deploy` memory by covering the **full local
Supabase Studio stack** and the **Sites mini-app data plane** explicitly.

**Scope:** move the two SQLite stores (`prisma/dev.db`, `prisma/sites-data.db`) onto the
Postgres that `supabase start` manages, use **Studio** as the admin surface, and decide —
component by component — what else of the Supabase platform to adopt vs. keep app-managed.

**Method:** a 6-dimension parallel research workflow (stack fundamentals, primary DB, the
mini-app plane, file/blob storage, auth, dev/ops) grounded in the current code + Supabase/
Prisma/Postgres docs. Citations are collected per dimension at the end.

---

## 1. TL;DR — the recommended path

Adopt **only Postgres + Studio** from Supabase. Everything else stays exactly as it is.

| Supabase component | Decision | Why |
|---|---|---|
| **Postgres** (:54322) | **Adopt** | The only load-bearing piece. Prisma talks to it directly. |
| **Studio** (:54323) | **Adopt** | Free admin win — table editor + SQL editor over both schemas. |
| **Auth / GoTrue** | **Keep NextAuth** | Folding in GoTrue rewrites ~40 server + ~9 client files for *zero* datastore-parity benefit. |
| **Storage** | **Keep on filesystem** | Local Storage serves on `localhost:54321` — unreachable by OpenAI's attachment fetch. Executable trees (`.workspaces`, `.plugins`) are categorically wrong for an object store. |
| **PostgREST / Realtime / Kong / edge-runtime** | **Ignore** | No code consumes them. Trim them from the local stack. |
| **Vault** (secrets) | **Keep app-managed** | `SITES_SECRETS_KEK`, `NEXTAUTH_SECRET`, MCP OAuth token columns stay where they are. |

The migration is therefore **a database move, not a platform re-architecture.** That framing
is the single most important decision in this document — it keeps the blast radius tiny.

**The two things that are genuinely non-trivial:**

1. **A latent quota-bypass concurrency bug** in the mini-app plane that SQLite masked for
   free and Postgres will not (§4.2). This is the crown-jewel finding — fix it or the
   per-site byte quota can be bypassed under a public write flood.
2. **Reproducing the mini-app's DoS isolation** without SQLite's single-writer-per-file
   property — done by keeping a **separate Prisma client with a capped connection pool**
   backed by a **connection-limited Postgres role** (§4.1).

Everything else — the provider flip, the env changes, the dev loop — is mechanical.

---

## 2. Where we are today (verified against the tree)

**Two SQLite stores, two Prisma clients:**

- **Primary** — `prisma/schema.prisma` (`provider = sqlite`, `DATABASE_URL="file:./dev.db"`),
  default `@prisma/client`, singleton in `src/lib/db.ts`. 16 models. NextAuth 4 +
  `@next-auth/prisma-adapter`. Deliberate conventions: **no enums, no `Json` columns** (all
  structured data is JSON-in-`String`), several **emulated FK pointers** (no Prisma relation:
  `Message.parentId`, `Conversation.activeLeafId`, `Site.liveVersionId`/`sourceArtifactId`/
  `createdInConversationId`, `McpServer.pluginId`), cuid ids, some app-code cascades.

- **Sites mini-app plane** — `prisma/sites-data.prisma` (`provider = sqlite`,
  `SITES_DATA_URL="file:./sites-data.db"`), a **separate custom-path client** at
  `src/generated/sites-data-client`, accessed only through `src/lib/sites/data-db.ts`. 10
  models. **Its whole reason for being a second file:** SQLite is single-writer-per-file, so
  anonymous **public** writes at `/s/<slug>` (guestbook/poll/form) can't contend for the
  same write lock as authenticated login/chat traffic → a public write flood can't DoS the
  app. No cross-DB FKs; tenancy enforced by `siteId`-first-arg repository methods.

**Raw SQL is tiny:** one `$executeRaw` at `conversations/[id]/route.ts:275` (already
Postgres-safe — double-quoted PascalCase identifiers, which Postgres *requires*), plus the
two SQLite-only `PRAGMA` calls in `data-db.ts`.

**Four on-disk sinks:** `public/uploads` (attachments + project files, served statically),
`.sites-blob/<siteId>` (per-site blobs, served via an app route), `.workspaces/<id>/.snap.git`
(coding-agent shadow-git), `.plugins/<userId>` (installed plugin trees).

**Tooling:** Docker present; `supabase` CLI **not installed**. The prior Docker+Postgres
work described in memory is **uncommitted and absent from this checkout** — treat it as
precedent, not a starting point. One live footgun it flagged: the generated
`src/generated/sites-data-client` currently holds an **inline postgresql** schema (leftover
from that uncommitted work) while the source `.prisma` says sqlite — a stale mismatch that
must be regenerated in lockstep with any flip.

---

## 3. Primary DB migration (SQLite → Postgres)

**The provider flip is nearly the only mandatory schema edit.** The schema uses zero enums,
zero `Json` columns, zero `@db.*` native types, no `@@map`, no autoincrement — only
`String`/`Int`/`Boolean`/`DateTime`. Type mapping is automatic and clean:

| Prisma type here | Postgres | Note |
|---|---|---|
| `String` (incl. all JSON-in-String) | `text` | **Leave as text.** Do *not* convert to `jsonb`. |
| `Int` | `integer` | |
| `Boolean` | `boolean` | |
| `DateTime` | `timestamp(3)` (not `timestamptz`) | App treats times as UTC via JS `Date`; fine for fresh data. |
| `@default(cuid())`, `@updatedAt` | client-side | Generated by Prisma, no DB sequence/trigger. |
| declared `@relation` | **enforced FK** | New: Postgres *enforces* these (SQLite didn't). |
| emulated pointers | plain `@index` text | Still tolerate dangles — they're not FKs. |

**Keep JSON columns as `text`, not `jsonb`.** The app treats them as opaque blobs
(`JSON.stringify`/`JSON.parse` in TS), never queries *inside* them. `jsonb` would churn ~10
columns + every call site, retype to `Prisma.JsonValue`, and reformat stored bytes (key
reorder / whitespace strip — risky for anything that hashes the raw string) for a benefit
nobody uses. Convert a *single* column to `jsonb` later only if a concrete server-side JSON
query appears.

**NextAuth adapter works unchanged.** `User`/`Account`/`Session`/`VerificationToken` are
ordinary tables that move with the schema. `String`→`text` (unlimited) means the token
fields never truncate, so the docs' `@db.Text` hint is a redundant no-op — skip it. Sessions
are **JWT** (`session.strategy: "jwt"`), so the `Session` table is effectively unused. Email
is lowercased before the unique lookup, so no `citext` needed.

**The one raw `$executeRaw` needs no change** — it already double-quotes identifiers
(`UPDATE "Conversation" SET "activeLeafId" = $1 WHERE "id" = $2`), which is exactly what
Postgres requires for Prisma's PascalCase tables. The two `$transaction([...])` array forms
(`schedules/[id]/route.ts`, `plugins/store.ts`) are single fast round-trips — pooler-safe.

**Go greenfield, not a data copy.** It's throwaway dev data; three of four persistence sinks
live outside the DB anyway; sessions are JWT (nothing to migrate); and Postgres will *enforce*
the FK constraints SQLite ignored, so a naive copy of orphan rows would abort. `prisma db
push` to the empty Postgres + re-register is faster and dodges every marshalling pitfall. If
a copy is ever truly wanted, use a **Prisma-based export/import script** (two clients, insert
in FK-topological order, pass explicit id/createdAt/updatedAt) — *not* pgloader, which carries
SQLite's `0/1` booleans and epoch-ms datetimes into types Postgres rejects.

---

## 4. The Sites mini-app data plane — the crux

This is where the migration earns its research. SQLite gave the plane two things for free
that Postgres does not: **write-lock isolation** and **snapshot-forced-rollback**. Both are
reproducible, and one hides a real bug.

### 4.1 Isolation: partition the *connection budget*, not the file

On one physical Postgres instance the truly shared resources are `max_connections`, backend
CPU/IO, WAL, and autovacuum. A separate *database* shares all of those exactly as much as a
separate *schema* does — so **a second database buys zero extra DoS isolation here**, and it
would be invisible to Studio, `supabase migration`, and `db reset`.

**Recommendation:**
- Put the 10 mini-app tables in a **separate schema `sites_data`** inside the single
  Supabase-managed `postgres` database (`SITES_DATA_URL=...&schema=sites_data`).
- **Keep the two Prisma clients separate — do NOT fold into one `multiSchema` client.** One
  client = one pool; merging pools is precisely what reintroduces the DoS (a public flood
  exhausts the shared pool and starves login/chat). *The second client IS the isolation
  mechanism.*
- Give the sites client its **own small `connection_limit`** (e.g. 5) and back it with a
  **dedicated non-superuser role** created `CONNECTION LIMIT 5 NOSUPERUSER NOBYPASSRLS`, with
  `GRANT USAGE` scoped to `sites_data` only.

**Why this reproduces (and improves on) the SQLite guarantee:** `connection_limit` is
per-`PrismaClient`, so two clients = two independent pools. Public writes can hold at most N
backends; a flood queues *client-side* on the sites pool (`pool_timeout` → 503) and can never
reach into the primary pool. App writers keep their own reserved backends. The per-role
`CONNECTION LIMIT` is a server-side backstop (enforced only for non-superusers — hence
`NOSUPERUSER`). The residual shared resource is WAL/IO/autovacuum, bounded by the existing
durable `SiteRateBucket` per-IP limiter (ports unchanged) + optional `statement_timeout`.

The **second-database** option stays documented as the escape hatch for moving the plane onto
a *physically separate* Postgres later (the only thing that gives true instance-level
blast-radius separation).

### 4.2 ⚠️ The quota-bypass bug: `bumpUsage()` must become an atomic increment

`bumpUsage()` (data-db.ts ~622–643) does **read → compute-in-JS → absolute-SET**:

```
const current = await tx.siteUsage.findUnique(...)   // non-locking MVCC snapshot read
const nextBytes = (current?.bytes ?? 0) + deltaBytes  // arithmetic in app code
... tx.siteUsage.upsert({ update: { bytes: clampedBytes, rows: clampedRows } })  // absolute write
```

Under Postgres **READ COMMITTED**, two concurrent public writes both read the same pre-write
count, both compute from the stale value, and the second's absolute SET clobbers the first —
a **lost update AND a quota bypass** (both can pass the cap). **SQLite masked this for free:**
in WAL, a read-snapshot txn that then writes after another commits gets `SQLITE_BUSY_SNAPSHOT`
and rolls back rather than silently under-counting.

**Fix — move the arithmetic into the write so it rides the row lock:**

```
const row = await tx.siteUsage.upsert({
  where:  { siteId },
  create: { siteId, bytes: Math.max(0, deltaBytes), rows: Math.max(0, deltaRows) },
  update: { bytes: { increment: deltaBytes }, rows: { increment: deltaRows } },
});
if (deltaBytes > 0 && row.bytes > quota) throw new SiteQuotaExceededError(siteId, row.bytes, quota);
```

`ON CONFLICT DO UPDATE` takes a `FOR UPDATE` row lock before applying, so a concurrent
increment blocks until the first commits, then applies to the true cumulative and RETURNs it
— the post-increment check is correct under READ COMMITTED with no `SELECT FOR UPDATE` and no
SERIALIZABLE retry loop. Over-rejection (both roll back) is possible but errs safe. **Deletes:**
atomic decrements can transiently under-run 0 — clamp with `GREATEST(0, …)` or a periodic
reconcile instead of the current stale-read `Math.max`. **This is the single most important
correctness change in the whole migration.**

### 4.3 The rest of the plane ports cleanly

- **WAL/busy_timeout PRAGMAs** in `ensureSitesData()` — guard behind an `isSqlite` flag
  (`SITES_DATA_URL.startsWith("file:")`) and early-return on Postgres. Nothing replaces them:
  Postgres WAL is always-on server-side, and MVCC means readers never block writers, so
  `busy_timeout` has no analogue. (Optionally `SET statement_timeout`/`lock_timeout` on the
  sites pool.) These are the only two raw-SQLite statements in the module.
- `checkWriteRate` (SiteRateBucket `increment`) — atomic `ON CONFLICT DO UPDATE`, unchanged.
- `consumeEndpointBudget` — same non-locking-read shape but idempotent-enough (over-spend by
  at most in-flight concurrency); optionally tighten to an atomic conditional update.
- `purgeSite` `$transaction([...deleteMany])`, all `findUnique`/`upsert` — port unchanged.

### 4.4 RLS — note as future, not now

RLS is **inert** on the Prisma path today: Prisma connects as the `postgres` owner/superuser,
which **bypasses row security** unless you create a dedicated non-owner/non-superuser/
non-BYPASSRLS role *and* `ENABLE + FORCE ROW LEVEL SECURITY` *and* inject the tenant per-txn
(`SET LOCAL app.site_id`). And Supabase's anon/authenticated RLS story is built for
**PostgREST**, which this app doesn't use. Tenancy is already enforced structurally
(`siteId`-first-arg → a forgotten filter is a *type error*). So RLS is additive-but-redundant
now; spend the role budget on `CONNECTION LIMIT` + schema-scoped `GRANT`s instead. Adopt RLS
only if the plane ever grows a PostgREST/anon Data-API surface (where it becomes mandatory).

---

## 5. File & blob storage — keep on the filesystem

**Move nothing to Supabase Storage for this migration.** Decision per sink:

| Sink | Decision | Why |
|---|---|---|
| `public/uploads` | **Keep on FS** (Storage only for a future *cloud* deploy) | `agent.ts` hands attachment URLs to **OpenAI's servers to fetch**; local Storage serves `localhost:54321`, as unreachable as the app origin — moving it buys nothing locally and breaks nothing only because you *don't* move it. |
| `.sites-blob/<siteId>` | **Keep on FS** | Already served through `/s/<slug>/api/[...path]` which stamps the load-bearing contract (sandbox CSP + `nosniff` + forced attachment + site gate + caps/quota). Storage can't carry that; you'd still serve through the route → pure churn. |
| `.workspaces/.snap.git` | **Keep on FS, always** | Executable **tree** state: git object DB, exec bits, symlinks, in-place mutation, realpath path-jail. An S3-style flat object store has none of those semantics. Category mismatch. |
| `.plugins/<userId>` | **Keep on FS, always** | Same class — git clones + skill trees read/executed from disk. |

For container durability, back the sinks with **Docker named volumes** — that's the
durability people reach for Storage to get, with no code change and no new dependency. A
Storage move for `public/uploads` is worth revisiting **only** for a stateless cloud runtime
where a public bucket URL is both durable and reachable by OpenAI — a separate, later
hardening phase (and note: Storage does *not* enforce your MIME allowlist, so `validateFile`
stays; project-file text extraction reads the blob back from disk today and would need to
download-first).

---

## 6. Auth — keep NextAuth (Option A)

Run NextAuth's four adapter tables on Supabase's Postgres; leave GoTrue idle (or
`[auth] enabled=false` in `config.toml`). **Zero auth-logic churn.**

Option B (adopt GoTrue) has a large, off-goal blast radius — measured by grep: **100
`getServerSession` call sites across ~38 files, 102 `authOptions` refs, 56 `next-auth`
imports across 44 files**, plus `middleware.ts` (`withAuth`), the `[...nextauth]` handler,
`SessionProvider`, ~9 client components (`useSession`/`signIn`/`signOut`) — on top of
reimplementing credential login, migrating bcrypt hashes into GoTrue, re-registering GitHub
OAuth, and adding `supabase-js` as brand-new runtime coupling the app doesn't have today.

- **No schema collision:** NextAuth tables live in `public.\"User\"`; GoTrue owns `auth.users`.
  Different schema + different casing. Nothing to rename.
- **One accepted tradeoff (document it):** app users are `public.User` rows — browsable in
  Studio's **Table Editor** but **not** in Studio's **Authentication** tab (which only lists
  GoTrue `auth.users`). Disabling GoTrue prevents someone creating a Studio "auth user" that
  can't log in.
- **Untouched by either option:** the Sites `SiteAccount` per-visitor identity (bcrypt, in the
  sites plane) and the `McpServer` OAuth *client* credentials (app→external MCP, not user
  auth). Both confirmed independent.

---

## 7. Dev workflow, env & ops

**The loop:**
```
brew install supabase/tap/supabase
supabase init                 # commit supabase/config.toml ; leave supabase/migrations empty
supabase start                # Postgres :54322, Studio :54323, API/Kong :54321, Mailpit :54324
npm run db:push               # Prisma owns the schema — pushes BOTH schemas into empty PG
npm run dev                   # next dev on the HOST at :3000, pointing at 127.0.0.1:54322
```

Run the **app on the host**, not in a container, for the local loop — the in-process
scheduler (`instrumentation.ts`, `SCHEDULER_ENABLED=1`) + SSE streaming need a long-lived
Node process, and `next dev` provides it with no `host.docker.internal` indirection.
`supabase start` **replaces the hand-rolled Postgres container** from the prior docker
precedent; app-in-Docker stays a separate deploy concern.

**Prisma stays the schema owner (`db push`), Supabase migrations stay empty.** The repo has no
migration files and ships a `db:push` script — it's already a db-push shop. Adopt `prisma
migrate` only when a persistent/hosted Supabase needs reproducible, drift-free history.

**Connection wiring — go direct locally.** The local Supavisor pooler is
`[db.pooler].enabled=false` by default, and this is a single always-on process, so the pooler
buys nothing. Point both runtime and CLI at direct `:54322`. Add a `directUrl` field now so a
future serverless deploy can flip `DATABASE_URL` to the transaction pooler (`:6543`,
`?pgbouncer=true`) without another schema edit — and even then **don't** set `connection_limit=1`
(that's the serverless-per-Lambda recipe, wrong for a persistent server).

**Env changes (`.env` / `.env.example`):**

| Key | From | To (local) |
|---|---|---|
| `DATABASE_URL` | `file:./dev.db` | `postgresql://postgres:postgres@127.0.0.1:54322/postgres?schema=public` |
| `DIRECT_URL` | — (**new**) | same as `DATABASE_URL` locally (required: `db push`/migrate can't use a tx pooler) |
| `SITES_DATA_URL` | `file:./sites-data.db` | `postgresql://openagent_sites_rw:…@127.0.0.1:54322/postgres?schema=sites_data&connection_limit=5&pool_timeout=10` |
| `SITES_DATA_DIRECT_URL` | — (**new**) | direct `:54322`, `schema=sites_data` |
| `SITES_DATA_IS_SQLITE` | — (**new**) | unset on Postgres; set on the SQLite rollback branch to keep the PRAGMA path |

Keep the pooled/serverless forms **commented** in `.env.example`. Secrets stay app-managed
(`NEXTAUTH_SECRET`, `SITES_SECRETS_KEK`, `CRON_SECRET`, MCP OAuth columns) — `SUPABASE_URL`/
`ANON_KEY`/`SERVICE_ROLE_KEY` are only needed *if* Storage is later adopted (and the local
ones are fixed well-known demo keys, safe to commit as `LOCAL DEMO ONLY`).

**`package.json` scripts:**
- `supabase:start` / `supabase:stop`
- `db:generate` = `prisma generate && prisma generate --schema=prisma/sites-data.prisma`
  (fix the latent gap: `predev`/`build` regenerate only the *default* client today)
- `db:push` = `prisma db push && prisma db push --schema=prisma/sites-data.prisma`
- `db:reset` = **`supabase db reset && npm run db:push`** — ⚠️ a bare `supabase db reset`
  re-applies only `supabase/migrations` + `seed.sql` (both empty here) and leaves a
  **schemaless DB**; always chain the push.

**Standalone build:** `next.config.js` `experimental.outputFileTracingIncludes` must bundle
`./src/generated/sites-data-client/**` — standalone tracing drops the custom-path Postgres
query engine otherwise (already noted in the docker precedent).

**Rollback:** Prisma bakes `provider` in at generate-time, so a rollback is **not** a `.env`
swap — cut a `sqlite-legacy` git branch/tag at the last SQLite commit; rollback =
`git checkout sqlite-legacy` + restore `file:` URLs. The migration never drops
`prisma/dev.db` (161 MB) or `sites-data.db`, so the SQLite data survives intact.

---

## 8. Phased rollout (synthesized)

The critic pass didn't complete (session limit); this ordering is my synthesis across the
six dimensions, sequenced so each phase is independently verifiable and reversible.

| Phase | Does | Deliverable / gate |
|---|---|---|
| **0. Scaffold** | `brew install supabase`; `supabase init`; add npm scripts. SQLite still default — no behavior change. | `supabase/config.toml` committed; `supabase start` boots; Studio reachable. |
| **1. Schema portability** *(branch)* | Flip both `provider`s → `postgresql`; add `directUrl`; guard PRAGMAs behind `SITES_DATA_IS_SQLITE`; **rewrite `bumpUsage()` to atomic increment**; regenerate BOTH clients. | `tsc` green; both generated clients match source. |
| **2. Roles + schema** | Init SQL: `CREATE SCHEMA sites_data`; `CREATE ROLE openagent_sites_rw … CONNECTION LIMIT 5 NOSUPERUSER NOBYPASSRLS`; scoped GRANTs. Set the 4 DB URLs. `npm run db:push` (both, greenfield). | 16 tables in `public`, 10 in `sites_data`, visible in Studio. |
| **3. Verify E2E** | Register/login (NextAuth→PG), chat persists, artifact + Site publish, **an anonymous public write to a Site** (exercises the plane + the quota path), scheduler ticks. | All green in Studio; quota enforced under a concurrent-write probe. |
| **4. Storage decision** | Default **no-op** — files stay on FS. (Docker volumes if containerizing.) | Documented; no new keys. |
| **5. Deploy** *(separate concern, last)* | App container → `host.docker.internal:54322`; `output:"standalone"` + `binaryTargets`. | Out of scope for the local loop. |

---

## 9. Risk register (cross-cutting, ranked)

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | **Quota bypass** — porting `bumpUsage()` as-is → lost update under READ COMMITTED lets a site exceed its byte quota under a write flood. | **High** | Atomic-increment rewrite (§4.2). The one must-fix. |
| 2 | **Public-write DoS regression** — folding the two clients into one pool (or an uncapped sites pool) lets a `/s/<slug>` flood starve login/chat. | **High** | Two clients / two pools; small `connection_limit`; non-superuser `CONNECTION LIMIT` role; keep `SiteRateBucket`. |
| 3 | **PRAGMAs fatal on PG** — `ensureSitesData()` throws on first sites write. | **High** | Guard behind `isSqlite`, early-return on PG. |
| 4 | **"Migrate = move files to Storage"** — someone ports `public/uploads` locally → attachments silently break (OpenAI can't fetch `localhost:54321`). | High | Scope the migration to the DB; keep files on FS locally. |
| 5 | **Stale generated client** — `src/generated/sites-data-client` holds an inline-postgresql schema over a sqlite source right now. | Med | Flip source first, then regenerate both clients in lockstep; treat `src/generated` as a build artifact. |
| 6 | **`supabase db reset` → schemaless DB** — empty migrations dir. | Med | `db:reset` = `supabase db reset && npm run db:push`. |
| 7 | **Rollback ≠ `.env` swap** — `provider` is compile-time. | Med | `sqlite-legacy` branch/tag; SQLite files never dropped. |
| 8 | **Wrong pooler mode** — tx pooler for an always-on server, or `connection_limit=1`, starves the ticker/SSE and disables prepared statements. | Med | Direct `:54322` (or session pooler `:5432`) for this persistent server; reserve tx-mode+`pgbouncer=true` for a future serverless target. |
| 9 | **New FKs reject a data copy** — orphan rows SQLite tolerated. | Med | Greenfield; if copying, FK-topological order + pre-clean orphans. |
| 10 | **RLS false security** — toggled on while Prisma connects as owner/superuser → silently bypassed. | Med | Don't rely on RLS now; keep repository-layer tenancy. |

---

## 10. Open questions for the user

1. **Is a persistent/hosted Supabase also in scope, or local-only?** Local-only favors
   `db push` + greenfield; hosted justifies adopting `prisma migrate` + a real `directUrl`
   now, and would revive the Storage-for-uploads question (cloud FS is ephemeral and a public
   bucket URL becomes reachable by OpenAI).
2. **Any dev data worth keeping** from `prisma/dev.db`, or is a clean re-register fine? This
   is the single decision that flips greenfield vs. the optional Prisma copy script.
3. **Pin Postgres 15 or 17?** Must match the intended production Supabase project version.
4. **Concrete pool sizing** — the sites `CONNECTION LIMIT` + primary pool must stay under the
   instance `max_connections`; pick numbers at implementation time.

---

## 11. Sources

Supabase local dev / CLI / config, Prisma+Supabase, Supavisor/pgbouncer, Postgres roles /
`CREATE ROLE` / UPSERT / transaction isolation / RLS, NextAuth/Auth.js Prisma adapter,
Supabase Storage & security. Full per-dimension citation lists are preserved in the research
journal at `…/subagents/workflows/wf_65c7fff5-846/journal.jsonl`. Key references:

- https://supabase.com/docs/guides/local-development/cli/getting-started
- https://supabase.com/docs/guides/local-development/cli/config
- https://supabase.com/docs/guides/database/prisma
- https://www.prisma.io/docs/orm/overview/databases/supabase
- https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer
- https://www.postgresql.org/docs/current/sql-createrole.html
- https://www.postgresql.org/docs/current/transaction-iso.html
- https://wiki.postgresql.org/wiki/UPSERT
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://authjs.dev/getting-started/adapters/prisma
- https://supabase.com/docs/guides/storage/buckets/fundamentals

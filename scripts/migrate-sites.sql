-- Sites feature — additive migration (SQLite / dev.db).
-- This repo has no prisma/migrations dir; schema changes are applied with
-- hand-written additive SQL (same approach used for Project/Plugin), then
-- `prisma generate` regenerates the client. NEVER run
-- `prisma db push --accept-data-loss` here — it drops unrelated orphan tables.
--
-- Apply:  sqlite3 prisma/dev.db < scripts/migrate-sites.sql
-- Safe to re-run: guarded with IF NOT EXISTS where SQLite allows it. The two
-- ALTER TABLE statements are NOT idempotent — run them once (they error
-- harmlessly with "duplicate column name" if the column already exists).

-- New columns on existing tables.
ALTER TABLE "User" ADD COLUMN "sitesAutoDeploy" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "siteRefs" TEXT;

-- Site: first-class, user-owned, publishable web page/app.
CREATE TABLE IF NOT EXISTS "Site" (
  "id"                      TEXT PRIMARY KEY NOT NULL,
  "userId"                  TEXT NOT NULL,
  "slug"                    TEXT NOT NULL,
  "name"                    TEXT NOT NULL,
  "description"             TEXT,
  "draftType"               TEXT NOT NULL DEFAULT 'html',
  "draftContent"            TEXT NOT NULL DEFAULT '',
  "draftLanguage"           TEXT,
  "liveVersionId"           TEXT,
  "deployedAt"              DATETIME,
  "visibility"              TEXT NOT NULL DEFAULT 'private',
  "sourceType"              TEXT NOT NULL DEFAULT 'tool',
  "sourceArtifactId"        TEXT,
  "createdInConversationId" TEXT,
  "manifest"                TEXT,
  "createdAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Site_slug_key" ON "Site" ("slug");
CREATE INDEX IF NOT EXISTS "Site_userId_idx" ON "Site" ("userId");
CREATE INDEX IF NOT EXISTS "Site_createdInConversationId_idx" ON "Site" ("createdInConversationId");

-- SiteVersion: immutable build snapshots of a Site's draft.
CREATE TABLE IF NOT EXISTS "SiteVersion" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "siteId"          TEXT NOT NULL,
  "version"         INTEGER NOT NULL,
  "type"            TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "language"        TEXT,
  "content"         TEXT NOT NULL,
  "commit"          TEXT NOT NULL,
  "label"           TEXT,
  "sourceMessageId" TEXT,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "SiteVersion_siteId_version_key" ON "SiteVersion" ("siteId", "version");
CREATE INDEX IF NOT EXISTS "SiteVersion_siteId_idx" ON "SiteVersion" ("siteId");

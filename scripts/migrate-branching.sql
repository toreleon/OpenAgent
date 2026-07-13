-- Message-branching feature (edit / regenerate with version
-- history) — additive migration (SQLite / dev.db).
--
-- This repo has no prisma/migrations dir; schema changes are applied with
-- hand-written additive SQL (same approach used for Project/Plugin/Site), then
-- `prisma generate` regenerates the client. NEVER run
-- `prisma db push --accept-data-loss` here — it drops unrelated orphan tables.
--
-- Apply:  sqlite3 prisma/dev.db < scripts/migrate-branching.sql
--
-- The two ALTER TABLE statements are NOT idempotent — they error harmlessly
-- with "duplicate column name" if the columns already exist. The backfill is
-- branch-safe and idempotent: it linearizes only conversations that have NO
-- parent links yet, so re-running it can never reparent a legitimate edit/
-- regenerate sibling (a second NULL-parent root) under another branch.

-- 1) New columns. Message.parentId links a message to its parent in the tree;
--    Conversation.activeLeafId points at the leaf of the currently-visible branch.
ALTER TABLE "Message" ADD COLUMN "parentId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "activeLeafId" TEXT;

CREATE INDEX IF NOT EXISTS "Message_parentId_idx" ON "Message" ("parentId");

-- 2) Backfill existing conversations as linear chains. Every message's parent
--    becomes the immediately-preceding message (by createdAt, then id as a
--    stable tiebreaker) within the same conversation. Roots (the first message)
--    keep parentId = NULL.
--
--    IMPORTANT: only linearize conversations that have NO parent links at all
--    yet. Once a conversation has branched (an edit/regenerate created a second
--    NULL-parent root), a blanket "parentId IS NULL" backfill would reparent
--    that legitimate sibling root under a message from another branch and
--    corrupt the tree. The NOT EXISTS guard makes this a no-op for any already-
--    migrated or already-branched conversation, so it is safe to re-run.
WITH ordered AS (
  SELECT
    m."id"                                    AS id,
    m."conversationId"                        AS cid,
    LAG(m."id") OVER (
      PARTITION BY m."conversationId"
      ORDER BY m."createdAt" ASC, m."id" ASC
    )                                         AS prev_id
  FROM "Message" m
)
UPDATE "Message"
SET "parentId" = (SELECT prev_id FROM ordered WHERE ordered.id = "Message"."id")
WHERE "parentId" IS NULL
  AND (SELECT prev_id FROM ordered WHERE ordered.id = "Message"."id") IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Message" x
    WHERE x."conversationId" = "Message"."conversationId"
      AND x."parentId" IS NOT NULL
  );

-- 3) Point each conversation's activeLeafId at its last message (the tail of the
--    linear chain). Only fills conversations that don't already have one.
WITH last_msg AS (
  SELECT
    "conversationId" AS cid,
    "id"             AS mid,
    ROW_NUMBER() OVER (
      PARTITION BY "conversationId"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "Message"
)
UPDATE "Conversation"
SET "activeLeafId" = (
  SELECT mid FROM last_msg WHERE last_msg.cid = "Conversation"."id" AND last_msg.rn = 1
)
WHERE "activeLeafId" IS NULL
  AND EXISTS (SELECT 1 FROM "Message" WHERE "Message"."conversationId" = "Conversation"."id");

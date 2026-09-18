-- ──────────────────────────────────────────────
-- Class-room chat (Phase 9)
--
-- One table: chat_messages. The room is (branchId, classId, sectionId);
-- membership is derived from live enrollments at request time, so no room
-- table exists. Author name is stamped at send (single-index reads, stable
-- bylines). hiddenAt is the soft-mute for moderation. Append-only: no
-- edit/delete columns on purpose.
-- ──────────────────────────────────────────────

CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "hiddenAt" TIMESTAMP(3),

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_branchId_classId_sectionId_createdAt_idx"
    ON "chat_messages"("branchId", "classId", "sectionId", "createdAt");

-- Foreign key removed intentionally? No — author cascade matches device_tokens
-- (account gone → its messages go). One FK, one index.
ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

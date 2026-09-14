-- ──────────────────────────────────────────────
-- Push device registry (BUILD_PLAN 5.4)
--
-- The mobile app registers its FCM token after login; the dispatcher
-- resolves a PUSH NotificationLog row's recipientId (a userId) to these
-- rows. Tokens are unique — a device re-registering replaces nothing, it
-- is the same row upserted by the app. `onDelete: Cascade` mirrors the
-- user lifecycle: no orphaned tokens after a GDPR-style purge.
-- ──────────────────────────────────────────────

CREATE TABLE "device_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");
CREATE INDEX "device_tokens_userId_idx" ON "device_tokens"("userId");

ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

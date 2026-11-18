CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "endpointUrl" TEXT NOT NULL,
  "eventTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "signingSecretEncrypted" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "lastDeliveryAt" TIMESTAMP(3),
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "lastHttpStatus" INTEGER,
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDeliveryAttempt" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "status" TEXT NOT NULL,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "durationMs" INTEGER,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookSubscription_workspaceId_id_key"
  ON "WebhookSubscription"("workspaceId", "id");
CREATE INDEX IF NOT EXISTS "WebhookSubscription_workspaceId_status_createdAt_idx"
  ON "WebhookSubscription"("workspaceId", "status", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_id_key"
  ON "WebhookDelivery"("workspaceId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDelivery_workspace_subscription_event_key"
  ON "WebhookDelivery"("workspaceId", "subscriptionId", "eventId");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_status_nextAttemptAt_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_status_nextAttemptAt_idx"
  ON "WebhookDelivery"("workspaceId", "status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_workspaceId_createdAt_idx"
  ON "WebhookDelivery"("workspaceId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "WebhookDeliveryAttempt_deliveryId_attemptNumber_key"
  ON "WebhookDeliveryAttempt"("deliveryId", "attemptNumber");
CREATE INDEX IF NOT EXISTS "WebhookDeliveryAttempt_workspaceId_startedAt_idx"
  ON "WebhookDeliveryAttempt"("workspaceId", "startedAt");
CREATE INDEX IF NOT EXISTS "WebhookDeliveryAttempt_workspaceId_deliveryId_attemptNumber_idx"
  ON "WebhookDeliveryAttempt"("workspaceId", "deliveryId", "attemptNumber");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"WebhookSubscription"'::regclass AND conname = 'WebhookSubscription_workspaceId_fkey') THEN
    ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"WebhookDelivery"'::regclass AND conname = 'WebhookDelivery_workspaceId_fkey') THEN
    ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"WebhookDelivery"'::regclass AND conname = 'WebhookDelivery_workspaceId_subscriptionId_fkey') THEN
    ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_subscriptionId_fkey"
      FOREIGN KEY ("workspaceId", "subscriptionId") REFERENCES "WebhookSubscription"("workspaceId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '"WebhookDeliveryAttempt"'::regclass AND conname = 'WebhookDeliveryAttempt_workspaceId_deliveryId_fkey') THEN
    ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_workspaceId_deliveryId_fkey"
      FOREIGN KEY ("workspaceId", "deliveryId") REFERENCES "WebhookDelivery"("workspaceId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

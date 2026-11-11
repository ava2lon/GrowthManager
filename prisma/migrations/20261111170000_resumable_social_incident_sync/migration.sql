CREATE TABLE "SocialIncidentSyncState" (
    "phase" TEXT NOT NULL,
    "cursor" TEXT,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SocialIncidentSyncState_pkey" PRIMARY KEY ("phase")
);

CREATE INDEX "SocialIncidentSyncState_leaseUntil_idx"
ON "SocialIncidentSyncState"("leaseUntil");

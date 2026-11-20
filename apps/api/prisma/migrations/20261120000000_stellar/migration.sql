-- The market moves from EVM to Stellar: EVM-era quotes, matcher transactions and
-- indexer cursors mean nothing on the new chain and are dropped first (a fresh
-- database has none).
DELETE FROM "p2p_quote";
DELETE FROM "p2p_matcher_tx";
DELETE FROM "p2p_chain_cursor";
-- DropIndex
DROP INDEX "p2p_matcher_tx_tier_network_fromAddress_nonce_key";

-- AlterTable
ALTER TABLE "p2p_quote" ADD COLUMN     "kind" TEXT NOT NULL,
ADD COLUMN     "qrHash" TEXT;

-- AlterTable
ALTER TABLE "p2p_order" ADD COLUMN     "qrPayload" TEXT;

-- AlterTable
ALTER TABLE "p2p_matcher_tx" DROP COLUMN "minedBlock",
DROP COLUMN "nonce",
DROP COLUMN "toAddress",
ADD COLUMN     "ledger" INTEGER,
ADD COLUMN     "maxTime" TIMESTAMP(3),
ADD COLUMN     "operation" TEXT NOT NULL,
ADD COLUMN     "sequence" BIGINT,
ALTER COLUMN "hash" DROP NOT NULL,
ALTER COLUMN "raw" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'queued';

-- AlterTable
ALTER TABLE "p2p_chain_cursor" DROP COLUMN "lastBlock",
ADD COLUMN     "cursor" TEXT,
ADD COLUMN     "lastLedger" INTEGER NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "siwe_nonce";

-- DropTable
DROP TABLE "p2p_account_challenge";

-- CreateTable
CREATE TABLE "auth_challenge" (
    "nonce" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "organizationId" TEXT,
    "tier" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenge_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "app_profile" (
    "address" TEXT NOT NULL,
    "handle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_profile_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "app_transfer" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "toAccount" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "origin" TEXT NOT NULL DEFAULT 'app',
    "hash" TEXT,
    "eventId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_incoming_scan" (
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "lastLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_incoming_scan_pkey" PRIMARY KEY ("address","network")
);

-- CreateTable
CREATE TABLE "p2p_submission" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "feeBumpHash" TEXT,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "organizationId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "envelope" TEXT NOT NULL,
    "outer" TEXT,
    "sponsored" BOOLEAN NOT NULL,
    "feeStroops" BIGINT NOT NULL DEFAULT 0,
    "reserveStroops" BIGINT NOT NULL DEFAULT 0,
    "clientKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "maxTime" TIMESTAMP(3) NOT NULL,
    "ledger" INTEGER,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_charge_payment" (
    "id" TEXT NOT NULL,
    "chargeId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_charge_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_challenge_expiresAt_idx" ON "auth_challenge"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_profile_handle_key" ON "app_profile"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "app_transfer_eventId_key" ON "app_transfer"("eventId");

-- CreateIndex
CREATE INDEX "app_transfer_fromAddress_network_createdAt_idx" ON "app_transfer"("fromAddress", "network", "createdAt");

-- CreateIndex
CREATE INDEX "app_transfer_toAccount_network_createdAt_idx" ON "app_transfer"("toAccount", "network", "createdAt");

-- CreateIndex
CREATE INDEX "app_transfer_hash_idx" ON "app_transfer"("hash");

-- CreateIndex
CREATE INDEX "app_transfer_status_updatedAt_idx" ON "app_transfer"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_submission_hash_key" ON "p2p_submission"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_submission_feeBumpHash_key" ON "p2p_submission"("feeBumpHash");

-- CreateIndex
CREATE INDEX "p2p_submission_source_createdAt_idx" ON "p2p_submission"("source", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_submission_clientKey_createdAt_idx" ON "p2p_submission"("clientKey", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_submission_status_updatedAt_idx" ON "p2p_submission"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_submission_createdAt_idx" ON "p2p_submission"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_charge_payment_hash_key" ON "p2p_charge_payment"("hash");

-- CreateIndex
CREATE INDEX "p2p_charge_payment_chargeId_status_idx" ON "p2p_charge_payment"("chargeId", "status");

-- CreateIndex
CREATE INDEX "p2p_charge_payment_payerAddress_createdAt_idx" ON "p2p_charge_payment"("payerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_charge_payment_status_updatedAt_idx" ON "p2p_charge_payment"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_matcher_tx_network_status_createdAt_idx" ON "p2p_matcher_tx"("network", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_matcher_tx_tier_network_fromAddress_sequence_key" ON "p2p_matcher_tx"("tier", "network", "fromAddress", "sequence");

-- AddForeignKey
ALTER TABLE "p2p_charge_payment" ADD CONSTRAINT "p2p_charge_payment_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "p2p_charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;


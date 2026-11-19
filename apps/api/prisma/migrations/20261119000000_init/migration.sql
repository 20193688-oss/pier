
-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "system" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "siwe_nonce" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "siwe_nonce_pkey" PRIMARY KEY ("nonce")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttemptAt" TIMESTAMP(3),
    "lastStatus" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "displayName" TEXT,
    "merchantStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "cancelledOrders" INTEGER NOT NULL DEFAULT 0,
    "disputesLost" INTEGER NOT NULL DEFAULT 0,
    "medianReleaseSeconds" INTEGER,
    "lastActiveAt" TIMESTAMP(3),
    "operators" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_account_challenge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_account_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_payment_method" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_payment_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_offer" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rails" TEXT[],
    "price" TEXT NOT NULL,
    "priceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "priceTtlSeconds" INTEGER NOT NULL,
    "minFiat" TEXT NOT NULL,
    "maxFiat" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_quote" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "endUserAddress" TEXT,
    "side" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "tokenAmount" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "protocolFee" TEXT NOT NULL,
    "integratorFeeBps" INTEGER NOT NULL,
    "integratorFee" TEXT NOT NULL,
    "integratorAddress" TEXT,
    "bond" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_order" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "endUserAddress" TEXT,
    "network" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "merchantAccountId" TEXT,
    "merchantOrganizationId" TEXT NOT NULL,
    "merchantAddress" TEXT NOT NULL,
    "merchantDisplayName" TEXT,
    "merchantPaymentMethodId" TEXT,
    "offerId" TEXT,
    "offerSnapshot" JSONB NOT NULL,
    "quoteId" TEXT,
    "price" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "tokenAmount" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "integratorFeeBps" INTEGER NOT NULL,
    "integratorAddress" TEXT,
    "sellerAddress" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "bond" TEXT NOT NULL,
    "acceptWindow" INTEGER NOT NULL,
    "paymentWindow" INTEGER NOT NULL,
    "settleWindow" INTEGER NOT NULL,
    "openerAddress" TEXT NOT NULL,
    "onchainId" TEXT,
    "chainStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "acceptDeadline" TIMESTAMP(3),
    "paymentDeadline" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "openTxHash" TEXT,
    "acceptTxHash" TEXT,
    "paidTxHash" TEXT,
    "releaseTxHash" TEXT,
    "cancelTxHash" TEXT,
    "disputeTxHash" TEXT,
    "resolveTxHash" TEXT,
    "settlement" JSONB,
    "payerInfo" TEXT,
    "beneficiary" TEXT,
    "paidReference" TEXT,
    "failureReason" TEXT,
    "chargeId" TEXT,
    "payoutBatchId" TEXT,
    "externalReference" TEXT,
    "payerTokenHash" TEXT,
    "clientKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_charge" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "payeeName" TEXT NOT NULL,
    "description" TEXT,
    "multiUse" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "paidCount" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_payout_batch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sellerAddress" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "failedItems" JSONB,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_payout_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_matcher_tx" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT,
    "toAddress" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'signed',
    "sentAt" TIMESTAMP(3),
    "minedBlock" BIGINT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_matcher_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_chain_cursor" (
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_chain_cursor_pkey" PRIMARY KEY ("tier","network","contract")
);

-- CreateIndex
CREATE INDEX "member_address_idx" ON "member"("address");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_address_key" ON "member"("organizationId", "address");

-- CreateIndex
CREATE INDEX "siwe_nonce_expiresAt_idx" ON "siwe_nonce"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_tokenHash_key" ON "session"("tokenHash");

-- CreateIndex
CREATE INDEX "session_address_idx" ON "session"("address");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_hash_key" ON "api_key"("hash");

-- CreateIndex
CREATE INDEX "api_key_organizationId_tier_idx" ON "api_key"("organizationId", "tier");

-- CreateIndex
CREATE INDEX "audit_log_resourceType_resourceId_idx" ON "audit_log"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "webhook_endpoint_organizationId_tier_idx" ON "webhook_endpoint"("organizationId", "tier");

-- CreateIndex
CREATE INDEX "webhook_event_organizationId_tier_createdAt_idx" ON "webhook_event"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "webhook_delivery_endpointId_createdAt_idx" ON "webhook_delivery"("endpointId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_delivery_eventId_endpointId_key" ON "webhook_delivery"("eventId", "endpointId");

-- CreateIndex
CREATE INDEX "p2p_account_organizationId_tier_createdAt_idx" ON "p2p_account"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_account_tier_address_key" ON "p2p_account"("tier", "address");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_account_challenge_nonce_key" ON "p2p_account_challenge"("nonce");

-- CreateIndex
CREATE INDEX "p2p_account_challenge_organizationId_tier_address_idx" ON "p2p_account_challenge"("organizationId", "tier", "address");

-- CreateIndex
CREATE INDEX "p2p_account_challenge_expiresAt_idx" ON "p2p_account_challenge"("expiresAt");

-- CreateIndex
CREATE INDEX "p2p_payment_method_organizationId_tier_createdAt_idx" ON "p2p_payment_method"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_payment_method_accountId_rail_currency_active_idx" ON "p2p_payment_method"("accountId", "rail", "currency", "active");

-- CreateIndex
CREATE INDEX "p2p_offer_tier_network_token_currency_side_active_idx" ON "p2p_offer"("tier", "network", "token", "currency", "side", "active");

-- CreateIndex
CREATE INDEX "p2p_offer_organizationId_tier_createdAt_idx" ON "p2p_offer"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_quote_organizationId_tier_createdAt_idx" ON "p2p_quote"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_quote_expiresAt_idx" ON "p2p_quote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_ref_key" ON "p2p_order"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_quoteId_key" ON "p2p_order"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_payerTokenHash_key" ON "p2p_order"("payerTokenHash");

-- CreateIndex
CREATE INDEX "p2p_order_organizationId_tier_createdAt_idx" ON "p2p_order"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_order_merchantOrganizationId_tier_createdAt_idx" ON "p2p_order"("merchantOrganizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_order_endUserAddress_tier_createdAt_idx" ON "p2p_order"("endUserAddress", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_order_merchantAccountId_status_idx" ON "p2p_order"("merchantAccountId", "status");

-- CreateIndex
CREATE INDEX "p2p_order_status_updatedAt_idx" ON "p2p_order"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_order_chargeId_status_idx" ON "p2p_order"("chargeId", "status");

-- CreateIndex
CREATE INDEX "p2p_order_payoutBatchId_idx" ON "p2p_order"("payoutBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_tier_network_contract_onchainId_key" ON "p2p_order"("tier", "network", "contract", "onchainId");

-- CreateIndex
CREATE INDEX "p2p_charge_organizationId_tier_createdAt_idx" ON "p2p_charge"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_payout_batch_organizationId_tier_createdAt_idx" ON "p2p_payout_batch"("organizationId", "tier", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_matcher_tx_hash_key" ON "p2p_matcher_tx"("hash");

-- CreateIndex
CREATE INDEX "p2p_matcher_tx_status_updatedAt_idx" ON "p2p_matcher_tx"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_matcher_tx_orderId_idx" ON "p2p_matcher_tx"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_matcher_tx_tier_network_fromAddress_nonce_key" ON "p2p_matcher_tx"("tier", "network", "fromAddress", "nonce");

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "webhook_event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_account" ADD CONSTRAINT "p2p_account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_payment_method" ADD CONSTRAINT "p2p_payment_method_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "p2p_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_offer" ADD CONSTRAINT "p2p_offer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "p2p_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_quote" ADD CONSTRAINT "p2p_quote_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "p2p_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "p2p_charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_payoutBatchId_fkey" FOREIGN KEY ("payoutBatchId") REFERENCES "p2p_payout_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_charge" ADD CONSTRAINT "p2p_charge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_payout_batch" ADD CONSTRAINT "p2p_payout_batch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


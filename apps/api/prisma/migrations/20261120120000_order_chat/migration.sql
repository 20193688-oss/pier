-- Order chat: messages between an order's creator and its merchant (transfer
-- receipts included), sealed at rest, and a summary of the chat on each order.
-- AlterTable
ALTER TABLE "p2p_order" ADD COLUMN     "chatCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chatLastAt" TIMESTAMP(3),
ADD COLUMN     "chatLastFrom" TEXT;

-- CreateTable
CREATE TABLE "p2p_order_message" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "senderOrganizationId" TEXT NOT NULL,
    "senderAddress" TEXT,
    "text" TEXT,
    "attachmentName" TEXT,
    "attachmentType" TEXT,
    "attachmentSize" INTEGER,
    "attachmentData" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_order_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "p2p_order_message_orderId_createdAt_idx" ON "p2p_order_message"("orderId", "createdAt");

-- AddForeignKey
ALTER TABLE "p2p_order_message" ADD CONSTRAINT "p2p_order_message_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "p2p_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateEnum
CREATE TYPE "AIProvider" AS ENUM ('OPENAI', 'GEMINI');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "aiEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiModel" TEXT NOT NULL DEFAULT 'gpt-4o-mini',
ADD COLUMN     "aiProvider" "AIProvider" NOT NULL DEFAULT 'OPENAI',
ADD COLUMN     "systemPrompt" TEXT,
ADD COLUMN     "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.7;

-- CreateTable
CREATE TABLE "Tool" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parameters" JSONB,
    "actionType" TEXT NOT NULL,
    "actionConfig" JSONB,
    "status" "ToolStatus" NOT NULL DEFAULT 'ACTIVE',
    "flowId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationLog" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolName" TEXT,
    "toolArgs" JSONB,
    "toolResult" JSONB,
    "tokenCount" INTEGER,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tool_botId_idx" ON "Tool"("botId");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_botId_name_key" ON "Tool"("botId", "name");

-- CreateIndex
CREATE INDEX "ConversationLog_sessionId_idx" ON "ConversationLog"("sessionId");

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tool" ADD CONSTRAINT "Tool_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationLog" ADD CONSTRAINT "ConversationLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

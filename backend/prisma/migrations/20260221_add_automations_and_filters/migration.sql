-- CreateEnum
CREATE TYPE "AutomationEvent" AS ENUM ('INACTIVITY');

-- AlterTable
ALTER TABLE "Bot" ADD COLUMN     "excludeGroups" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ignoredLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Automation" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "event" "AutomationEvent" NOT NULL,
    "labelName" TEXT NOT NULL,
    "timeoutMs" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Automation_botId_idx" ON "Automation"("botId");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_botId_fkey" FOREIGN KEY ("botId") REFERENCES "Bot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

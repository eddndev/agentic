-- AlterTable
ALTER TABLE "Bot" ADD COLUMN "thinkingLevel" TEXT DEFAULT 'LOW';

-- Update default provider and model for new bots
ALTER TABLE "Bot" ALTER COLUMN "aiModel" SET DEFAULT 'gemini-2.5-flash';
ALTER TABLE "Bot" ALTER COLUMN "aiProvider" SET DEFAULT 'GEMINI';

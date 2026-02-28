-- Revert TriggerTarget columns
ALTER TABLE "Trigger" DROP COLUMN "targetType";
ALTER TABLE "Trigger" DROP COLUMN "toolName";
ALTER TABLE "Trigger" ALTER COLUMN "flowId" SET NOT NULL;

-- Drop unused enum
DROP TYPE "TriggerTarget";

-- Add TOOL to StepType
ALTER TYPE "StepType" ADD VALUE 'TOOL';

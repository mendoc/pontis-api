-- AlterEnum
ALTER TYPE "ProjectType" ADD VALUE 'docker';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "healthcheckPath" TEXT NOT NULL DEFAULT '/health',
ADD COLUMN     "internalPort" INTEGER NOT NULL DEFAULT 8000;

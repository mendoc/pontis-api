-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "imageTag" TEXT;

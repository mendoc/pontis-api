-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "deployedById" TEXT;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_deployedById_fkey" FOREIGN KEY ("deployedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

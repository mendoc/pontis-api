-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('developer', 'admin');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "role" "UserRole" NOT NULL DEFAULT 'developer';

-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('git', 'static');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('pending', 'building', 'success', 'failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "gitlabId" INTEGER,
    "gitlabToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "type" "ProjectType" NOT NULL,
    "domain" TEXT,
    "status" TEXT NOT NULL DEFAULT 'inactive',

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "commitSha" TEXT,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'pending',
    "logs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvVar" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueEncrypted" TEXT NOT NULL,

    CONSTRAINT "EnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Port" (
    "id" TEXT NOT NULL,
    "portNumber" INTEGER NOT NULL,
    "projectId" TEXT NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Port_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_gitlabId_key" ON "User"("gitlabId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Port_portNumber_key" ON "Port"("portNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Port_projectId_key" ON "Port"("projectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnvVar" ADD CONSTRAINT "EnvVar_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Port" ADD CONSTRAINT "Port_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

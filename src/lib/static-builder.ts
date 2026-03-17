import Dockerode from 'dockerode'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import unzipper from 'unzipper'
import tar from 'tar-fs'

const APP_DOMAIN = process.env.APP_DOMAIN ?? 'app.ongoua.pro'
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'pontis_network'

async function extractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const { Readable } = require('node:stream')
    const readable = Readable.from(zipBuffer)
    readable
      .pipe(unzipper.Extract({ path: destDir }))
      .on('close', resolve)
      .on('error', reject)
  })
}

async function normalizeToSiteDir(extractDir: string, siteDir: string): Promise<void> {
  const entries = await fs.readdir(extractDir)
  // Filtrer les entrées cachées et __MACOSX
  const visibleEntries = entries.filter((e) => !e.startsWith('.') && e !== '__MACOSX')

  if (visibleEntries.length === 1) {
    const single = path.join(extractDir, visibleEntries[0])
    const stat = await fs.stat(single)
    if (stat.isDirectory()) {
      // Déplacer le contenu du sous-dossier vers siteDir
      await fs.rename(single, siteDir)
      return
    }
  }

  // Sinon renommer extractDir en siteDir directement
  await fs.rename(extractDir, siteDir)
}

async function buildDockerImage(docker: Dockerode, siteDir: string, imageTag: string): Promise<void> {
  // Écrire le Dockerfile
  const dockerfile = `FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n`
  await fs.writeFile(path.join(siteDir, 'Dockerfile'), dockerfile)

  // Créer l'archive tar du contexte de build
  const tarStream = tar.pack(siteDir)

  const buildStream = await docker.buildImage(tarStream as any, { t: imageTag })

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(buildStream, (err: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export async function buildAndRunStaticProject(
  docker: Dockerode,
  _projectId: string,
  slug: string,
  zipBuffer: Buffer
): Promise<string> {
  const tmpBase = path.join(os.tmpdir(), randomUUID())
  const extractDir = path.join(tmpBase, 'extract')
  const siteDir = path.join(tmpBase, 'site')

  await fs.mkdir(extractDir, { recursive: true })

  try {
    await extractZip(zipBuffer, extractDir)
    await normalizeToSiteDir(extractDir, siteDir)

    const imageTag = `pontis-${slug}:latest`
    await buildDockerImage(docker, siteDir, imageTag)

    const containerName = `pontis-${slug}`
    const domain = `${slug}.${APP_DOMAIN}`

    // Supprimer un container existant du même nom si présent
    try {
      const existing = docker.getContainer(containerName)
      await existing.stop()
      await existing.remove()
    } catch {
      // Pas de container existant, c'est normal
    }

    const container = await docker.createContainer({
      Image: imageTag,
      name: containerName,
      Labels: {
        'traefik.enable': 'true',
        [`traefik.http.routers.${slug}.rule`]: `Host(\`${domain}\`)`,
        [`traefik.http.routers.${slug}.entrypoints`]: 'websecure',
        [`traefik.http.routers.${slug}.tls`]: 'true',
        [`traefik.http.routers.${slug}.tls.certresolver`]: 'letsencrypt',
        [`traefik.http.services.${slug}.loadbalancer.server.port`]: '80',
      },
      HostConfig: {
        NetworkMode: DOCKER_NETWORK,
      },
    })

    await container.start()

    return domain
  } finally {
    // Nettoyer le dossier temporaire
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
}

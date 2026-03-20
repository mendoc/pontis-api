import Dockerode from 'dockerode'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import unzipper from 'unzipper'
import tar from 'tar-fs'
import { writeProjectCompose } from './compose-writer'

const APP_DOMAIN = process.env.APP_DOMAIN ?? 'app.ongoua.pro'
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'pontis_network'

async function extractZip(zipBuffer: Buffer, destDir: string): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const { Readable } = require('node:stream')
      const readable = Readable.from(zipBuffer)
      readable
        .pipe(unzipper.Extract({ path: destDir }))
        .on('close', resolve)
        .on('error', reject)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('invalid signature') || msg.includes('end of central directory')) {
      throw new Error('Le fichier fourni n\'est pas un ZIP valide.')
    }
    throw err
  }
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

async function buildDockerImage(
  docker: Dockerode,
  siteDir: string,
  primaryTag: string,
  extraTags: string[]
): Promise<string> {
  // Écrire le Dockerfile
  const dockerfile = `FROM nginx:alpine\nCOPY . /usr/share/nginx/html\nEXPOSE 80\n`
  await fs.writeFile(path.join(siteDir, 'Dockerfile'), dockerfile)

  // Créer l'archive tar du contexte de build
  const tarStream = tar.pack(siteDir)

  const buildStream = await docker.buildImage(tarStream as any, { t: primaryTag })

  const logLines: string[] = []

  function timestamp(): string {
    return new Date().toLocaleTimeString('fr-FR', {
      timeZone: 'Europe/Paris',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(
      buildStream,
      (err: Error | null) => {
        if (err) reject(err)
        else resolve()
      },
      (event: { stream?: string; error?: string }) => {
        if (event.stream) {
          const line = event.stream.replace(/\n$/, '')
          if (line.trim()) logLines.push(`[${timestamp()}] ${line}\n`)
        }
        if (event.error) logLines.push(`[${timestamp()}] ERROR: ${event.error}\n`)
      }
    )
  })

  // Appliquer les tags supplémentaires (ex: :deploy-{deploymentId})
  for (const extra of extraTags) {
    const [repo, tag] = extra.split(':')
    await docker.getImage(primaryTag).tag({ repo, tag })
  }

  return logLines.join('')
}

export async function buildAndRunStaticProject(
  docker: Dockerode,
  _projectId: string,
  slug: string,
  zipBuffer: Buffer,
  deploymentId: string
): Promise<{ domain: string; logs: string }> {
  const tmpBase = path.join(os.tmpdir(), randomUUID())
  const extractDir = path.join(tmpBase, 'extract')
  const siteDir = path.join(tmpBase, 'site')

  await fs.mkdir(extractDir, { recursive: true })

  try {
    await extractZip(zipBuffer, extractDir)
    await normalizeToSiteDir(extractDir, siteDir)

    const latestTag = `pontis-${slug}:latest`
    const versionedTag = `pontis-${slug}:deploy-${deploymentId}`

    const logs = await buildDockerImage(docker, siteDir, latestTag, [versionedTag])

    const containerName = `pontis-${slug}`
    const domain = `${slug}.${APP_DOMAIN}`

    // Supprimer un container existant du même nom si présent
    try {
      await docker.getContainer(containerName).remove({ force: true })
    } catch {
      // Pas de container existant, c'est normal
    }

    const container = await docker.createContainer({
      Image: latestTag,
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
    await writeProjectCompose(slug, domain, DOCKER_NETWORK, versionedTag)

    return { domain, logs }
  } finally {
    // Nettoyer le dossier temporaire
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
}

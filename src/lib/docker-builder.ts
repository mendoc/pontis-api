import Dockerode from 'dockerode'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import unzipper from 'unzipper'
import tar from 'tar-fs'
import { writeProjectCompose } from './compose-writer'
import { decrypt } from './crypto'

const APP_DOMAIN = process.env.APP_DOMAIN ?? 'app.ongoua.pro'
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'pontis_network'

/**
 * Extract a ZIP to destDir, skipping vendor/ and __MACOSX/ entries.
 */
async function extractZipFiltered(zipBuffer: Buffer, destDir: string): Promise<void> {
  const { Readable } = await import('node:stream')
  await new Promise<void>((resolve, reject) => {
    const readable = Readable.from(zipBuffer)
    readable
      .pipe(unzipper.Parse())
      .on('entry', (entry: unzipper.Entry) => {
        const entryPath: string = entry.path
        // Skip vendor/, __MACOSX/, and hidden files at root
        if (
          entryPath.startsWith('vendor/') ||
          entryPath.startsWith('__MACOSX/') ||
          entryPath.startsWith('.')
        ) {
          entry.autodrain()
          return
        }
        const fullPath = path.join(destDir, entryPath)
        if (entry.type === 'Directory') {
          fs.mkdir(fullPath, { recursive: true }).catch(() => null)
          entry.autodrain()
        } else {
          fs.mkdir(path.dirname(fullPath), { recursive: true })
            .then(() => {
              entry.pipe(createWriteStream(fullPath)).on('error', reject)
            })
            .catch(reject)
        }
      })
      .on('close', resolve)
      .on('error', (err: Error) => {
        const msg = err.message
        if (msg.includes('invalid signature') || msg.includes('end of central directory')) {
          reject(new Error('Le fichier fourni n\'est pas un ZIP valide.'))
        } else {
          reject(err)
        }
      })
  })
}

/**
 * If the extracted directory contains a single subdirectory (macOS zip pattern),
 * move its contents up to destDir.
 */
async function normalizeToAppDir(extractDir: string, appDir: string): Promise<void> {
  const entries = await fs.readdir(extractDir)
  const visibleEntries = entries.filter((e) => !e.startsWith('.') && e !== '__MACOSX')

  if (visibleEntries.length === 1) {
    const single = path.join(extractDir, visibleEntries[0])
    const stat = await fs.stat(single)
    if (stat.isDirectory()) {
      await fs.rename(single, appDir)
      return
    }
  }

  await fs.rename(extractDir, appDir)
}

function timestamp(): string {
  return new Date().toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

async function buildDockerImageFromDockerfile(
  docker: Dockerode,
  appDir: string,
  primaryTag: string,
  extraTags: string[],
  logFile?: string
): Promise<string> {
  const tarStream = tar.pack(appDir)
  const buildStream = await docker.buildImage(tarStream as any, { t: primaryTag })

  const logLines: string[] = []

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
          if (line.trim()) {
            const entry = `[${timestamp()}] ${line}\n`
            logLines.push(entry)
            if (logFile) fs.appendFile(logFile, entry).catch(() => null)
          }
        }
        if (event.error) {
          const entry = `[${timestamp()}] ERROR: ${event.error}\n`
          logLines.push(entry)
          if (logFile) fs.appendFile(logFile, entry).catch(() => null)
          reject(new Error(event.error))
        }
      }
    )
  })

  for (const extra of extraTags) {
    const [repo, tag] = extra.split(':')
    await docker.getImage(primaryTag).tag({ repo, tag })
  }

  return logLines.join('')
}

function buildTraefikLabels(slug: string, domain: string, internalPort: number): Record<string, string> {
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${slug}.rule`]: `Host(\`${domain}\`)`,
    [`traefik.http.routers.${slug}.entrypoints`]: 'websecure',
    [`traefik.http.routers.${slug}.tls`]: 'true',
    [`traefik.http.routers.${slug}.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.services.${slug}.loadbalancer.server.port`]: String(internalPort),
  }
}

async function ensureVolume(docker: Dockerode, volumeName: string): Promise<void> {
  try {
    await docker.getVolume(volumeName).inspect()
  } catch {
    await docker.createVolume({ Name: volumeName })
  }
}

export async function buildAndRunDockerProject(opts: {
  docker: Dockerode
  slug: string
  zipBuffer: Buffer
  deploymentId: string
  internalPort: number
  healthcheckPath: string
  envVars: Array<{ key: string; valueEncrypted: string }>
  logFile?: string
}): Promise<{ domain: string; logs: string }> {
  const { docker, slug, zipBuffer, deploymentId, internalPort, healthcheckPath, envVars } = opts

  const tmpBase = path.join(os.tmpdir(), randomUUID())
  const extractDir = path.join(tmpBase, 'extract')
  const appDir = path.join(tmpBase, 'app')

  await fs.mkdir(extractDir, { recursive: true })

  try {
    await extractZipFiltered(zipBuffer, extractDir)
    await normalizeToAppDir(extractDir, appDir)

    const latestTag = `pontis-${slug}:latest`
    const versionedTag = `pontis-${slug}:deploy-${deploymentId}`

    const logs = await buildDockerImageFromDockerfile(docker, appDir, latestTag, [versionedTag], opts.logFile)

    const containerName = `pontis-${slug}`
    const domain = `${slug}.${APP_DOMAIN}`
    const volumeName = `pontis-${slug}-storage`

    // Supprimer un container existant du même nom si présent
    try {
      await docker.getContainer(containerName).remove({ force: true })
    } catch {
      // Pas de container existant, c'est normal
    }

    // Créer le volume de stockage persistant si inexistant
    await ensureVolume(docker, volumeName)

    // Déchiffrer les env vars
    const env = envVars.map(({ key, valueEncrypted }) => `${key}=${decrypt(valueEncrypted)}`)

    const container = await docker.createContainer({
      Image: latestTag,
      name: containerName,
      Env: env,
      ExposedPorts: { [`${internalPort}/tcp`]: {} },
      Labels: buildTraefikLabels(slug, domain, internalPort),
      HostConfig: {
        NetworkMode: DOCKER_NETWORK,
        Binds: [`${volumeName}:/var/www/html/storage`],
      },
    })

    await container.start()
    await writeProjectCompose(slug, domain, DOCKER_NETWORK, versionedTag, internalPort, healthcheckPath)

    return { domain, logs }
  } finally {
    await fs.rm(tmpBase, { recursive: true, force: true })
  }
}

/**
 * Recreate a docker-type container from a given image tag (used for restart and rollback).
 */
export async function recreateDockerContainer(opts: {
  docker: Dockerode
  slug: string
  domain: string
  imageTag: string
  internalPort: number
  healthcheckPath: string
  envVars: Array<{ key: string; valueEncrypted: string }>
}): Promise<void> {
  const { docker, slug, domain, imageTag, internalPort, healthcheckPath, envVars } = opts
  const containerName = `pontis-${slug}`
  const volumeName = `pontis-${slug}-storage`

  try {
    await docker.getContainer(containerName).remove({ force: true })
  } catch {
    // Container inexistant — pas un problème
  }

  await ensureVolume(docker, volumeName)

  const env = envVars.map(({ key, valueEncrypted }) => `${key}=${decrypt(valueEncrypted)}`)

  const container = await docker.createContainer({
    Image: imageTag,
    name: containerName,
    Env: env,
    ExposedPorts: { [`${internalPort}/tcp`]: {} },
    Labels: buildTraefikLabels(slug, domain, internalPort),
    HostConfig: {
      NetworkMode: DOCKER_NETWORK,
      Binds: [`${volumeName}:/var/www/html/storage`],
    },
  })

  await container.start()
  await writeProjectCompose(slug, domain, DOCKER_NETWORK, imageTag, internalPort, healthcheckPath).catch(() => null)
}

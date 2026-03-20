import path from 'node:path'
import fs from 'node:fs/promises'

export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? '/var/lib/pontis/projects'

export function generateComposeContent(slug: string, domain: string, network: string): string {
  return `version: "3.8"

services:
  app:
    image: pontis-${slug}:latest
    container_name: pontis-${slug}
    restart: unless-stopped
    networks:
      - ${network}
    labels:
      traefik.enable: "true"
      traefik.http.routers.${slug}.rule: "Host(\`${domain}\`)"
      traefik.http.routers.${slug}.entrypoints: websecure
      traefik.http.routers.${slug}.tls: "true"
      traefik.http.routers.${slug}.tls.certresolver: letsencrypt
      traefik.http.services.${slug}.loadbalancer.server.port: "80"

networks:
  ${network}:
    external: true
`
}

export async function writeProjectCompose(slug: string, domain: string, network: string): Promise<void> {
  const projectDir = path.join(PROJECTS_DIR, slug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'docker-compose.yml'), generateComposeContent(slug, domain, network), 'utf-8')
}

export async function removeProjectDir(slug: string): Promise<void> {
  await fs.rm(path.join(PROJECTS_DIR, slug), { recursive: true, force: true })
}

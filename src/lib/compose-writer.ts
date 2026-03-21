import path from 'node:path'
import fs from 'node:fs/promises'

export const PROJECTS_DIR = process.env.PROJECTS_DIR ?? '/var/lib/pontis/projects'

export function generateComposeContent(slug: string, domain: string, network: string, imageTag: string): string {
  return `version: "3.8"

services:
  app:
    image: ${imageTag}
    container_name: pontis-${slug}
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:80/ || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
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

export async function writeProjectCompose(slug: string, domain: string, network: string, imageTag: string): Promise<void> {
  const projectDir = path.join(PROJECTS_DIR, slug)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'docker-compose.yml'), generateComposeContent(slug, domain, network, imageTag), 'utf-8')
}

export async function removeProjectDir(slug: string): Promise<void> {
  await fs.rm(path.join(PROJECTS_DIR, slug), { recursive: true, force: true })
}

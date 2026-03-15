// Serveur webhook — aucune dépendance externe
// Route: POST /deploy/:slug
// Récupère docker-compose.yml depuis GitHub, l'écrit dans $APPS_DIR/<slug>/,
// puis exécute docker compose pull + up -d + image prune.
// Vérifie les signatures HMAC-SHA256 de GitHub.

'use strict';

const http   = require('http');   // serveur HTTP entrant
const https  = require('https');  // fetch GitHub sortant
const crypto = require('crypto');
const { execFile } = require('child_process');
const path = require('path');
const fs   = require('fs');

const PORT         = 9000;
const SECRET       = process.env.GITHUB_WEBHOOK_SECRET;
const APPS_DIR     = process.env.APPS_DIR;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null; // optionnel, requis pour les dépôts privés
const PATHS_CONFIG = process.env.PATHS_CONFIG || null; // chemin vers le fichier JSON de surcharge slug→chemin (optionnel)

if (!SECRET) {
  console.error('FATAL : GITHUB_WEBHOOK_SECRET n\'est pas défini');
  process.exit(1);
}
if (!APPS_DIR) {
  console.error('FATAL : APPS_DIR n\'est pas défini');
  process.exit(1);
}
if (!GITHUB_TOKEN) {
  console.warn('[webhook] GITHUB_TOKEN non défini — seuls les dépôts publics fonctionneront');
}

// Garde : un seul déploiement à la fois par slug
const running = new Set();

function resolveProjectDir(slug) {
  if (PATHS_CONFIG) {
    try {
      const raw = fs.readFileSync(PATHS_CONFIG, 'utf8');
      const map = JSON.parse(raw);
      if (map[slug]) {
        console.log(`[${slug}] Chemin personnalisé : ${map[slug]}`);
        return map[slug];
      }
    } catch (err) {
      console.warn(`[${slug}] Impossible de lire ${PATHS_CONFIG} : ${err.message} — chemin par défaut utilisé`);
    }
  }
  return path.join(APPS_DIR, slug);
}

function verifySignature(secret, body, sigHeader) {
  if (!sigHeader || !sigHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

function runStep(cmd, args, slug) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (stdout) console.log(`[${slug}]`, stdout.trim());
      if (stderr) console.log(`[${slug}]`, stderr.trim());
      if (err) reject(err);
      else resolve();
    });
  });
}

// Tente de récupérer un fichier brut depuis GitHub. Résout avec le contenu si trouvé (200),
// résout avec null si introuvable (404), rejette pour toute autre erreur.
function fetchRaw(url) {
  const options = { headers: { 'User-Agent': 'pontis-webhook/1.0' } };
  if (GITHUB_TOKEN) options.headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, options, (res) => {
      if (res.statusCode === 404) {
        res.resume(); // vider le flux
        resolve(null);
        return;
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume();
        reject(new Error(`Accès refusé (${res.statusCode}) — GITHUB_TOKEN est-il défini ?`));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Statut inattendu ${res.statusCode} pour ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error(`Délai dépassé pour ${url}`));
    });
  });
}

// Essaie docker-compose.yml puis compose.yml. Retourne { content, filename }.
async function fetchComposeFile(fullName, branch) {
  const candidates = ['docker-compose.yml', 'compose.yml'];
  const base = `https://raw.githubusercontent.com/${fullName}/${branch}`;

  for (const filename of candidates) {
    const content = await fetchRaw(`${base}/${filename}`);
    if (content !== null) {
      return { content, filename };
    }
  }
  throw new Error(`Aucun fichier compose (${candidates.join(', ')}) trouvé dans ${fullName}@${branch}`);
}

function writeComposeFile(slug, dir, filename, content) {
  const file = path.join(dir, filename);
  return new Promise((resolve, reject) => {
    fs.mkdir(dir, { recursive: true }, (err) => {
      if (err) { reject(err); return; }
      fs.writeFile(file, content, 'utf8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

async function runDeploy(slug, fullName, branch) {
  if (running.has(slug)) {
    console.log(`[${slug}] Déploiement déjà en cours, ignoré.`);
    return;
  }

  running.add(slug);
  console.log(`[${slug}] Démarrage du déploiement (${fullName}@${branch})...`);
  try {
    console.log(`[${slug}] Récupération du fichier compose depuis ${fullName}@${branch}...`);
    const { content, filename } = await fetchComposeFile(fullName, branch);
    console.log(`[${slug}] Fichier trouvé : ${filename}`);
    const projectDir = resolveProjectDir(slug);
    await writeComposeFile(slug, projectDir, filename, content);
    console.log(`[${slug}] ${filename} écrit dans ${projectDir}/`);

    const composeFile = path.join(projectDir, filename);
    await runStep('docker', ['compose', '-f', composeFile, 'pull'], slug);
    await runStep('docker', ['compose', '-f', composeFile, 'up', '-d'], slug);
    await runStep('docker', ['image', 'prune', '-f'], slug);
    console.log(`[${slug}] Déploiement réussi.`);
  } catch (err) {
    console.error(`[${slug}] Échec du déploiement :`, err.message);
  } finally {
    running.delete(slug);
  }
}

const server = http.createServer((req, res) => {
  const match = req.method === 'POST' && req.url.match(/^\/deploy\/([a-z0-9_-]+)$/);
  if (!match) {
    res.writeHead(404).end('Not found');
    return;
  }
  const slug = match[1];

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const sig  = req.headers['x-hub-signature-256'];

    if (!verifySignature(SECRET, body, sig)) {
      res.writeHead(400).end('Invalid signature');
      return;
    }

    // Ping GitHub (envoyé à la création du webhook)
    if (req.headers['x-github-event'] === 'ping') {
      res.writeHead(200).end('pong');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400).end('Invalid JSON');
      return;
    }

    if (payload.ref !== `refs/heads/${payload.repository?.default_branch}`) {
      res.writeHead(200).end('Ignored (not default branch)');
      return;
    }

    res.writeHead(202).end('Accepted');
    const fullName = payload.repository.full_name;
    const branch   = payload.ref.replace('refs/heads/', '');
    runDeploy(slug, fullName, branch);
  });
});

server.listen(PORT, () => {
  console.log(`[webhook] En écoute sur le port ${PORT}`);
  console.log(`[webhook] Répertoire des applications : ${APPS_DIR}`);
});

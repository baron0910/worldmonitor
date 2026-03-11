#!/usr/bin/env node
/**
 * zeabur-server.js — Production server for Zeabur deployment.
 *
 * Serves:
 *  1. Static frontend assets from the `dist/` directory.
 *  2. All Vercel-style API functions from the `api/` directory.
 *  3. SPA fallback — all unknown routes return `dist/index.html`.
 *
 * Run:
 *   npm run build:zeabur
 *   node zeabur-server.js
 *
 * Env vars:
 *   PORT                 (default 3000)
 *   EXTRA_ALLOWED_ORIGINS  comma-separated origins to whitelist (e.g. https://my-app.zeabur.app)
 */

import http from 'node:http';
import https from 'node:https';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, 'dist');
const API_DIR = join(__dirname, 'api');
const PORT = Number(process.env.PORT) || 3000;

// ─────────────────────────────────────────────────────────────
// MIME types
// ─────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.wasm': 'application/wasm',
  '.xml':  'application/xml',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// ─────────────────────────────────────────────────────────────
// Cache-Control by path pattern
// ─────────────────────────────────────────────────────────────
function getCacheControl(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') return 'no-cache, no-store, must-revalidate';
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  if (urlPath.startsWith('/favico/')) return 'public, max-age=604800';
  if (urlPath === '/sw.js') return 'public, max-age=0, must-revalidate';
  if (urlPath === '/manifest.webmanifest') return 'public, max-age=86400';
  return 'public, max-age=3600';
}

// ─────────────────────────────────────────────────────────────
// Build a map of API route -> handler module path
//   api/version.js           -> /api/version
//   api/news/[slug].js       -> /api/news/[slug]   (Vercel catch-all, not used here directly)
//   api/[domain]/v1/[rpc].js -> handled via gateway
// ─────────────────────────────────────────────────────────────
async function buildApiHandlerMap(dir, prefix = '') {
  const map = new Map(); // url-path -> absolute file path
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await buildApiHandlerMap(fullPath, `${prefix}/${entry.name}`);
      for (const [k, v] of sub) map.set(k, v);
    } else if (entry.name.endsWith('.js') && !entry.name.startsWith('_') && !entry.name.endsWith('.test.js') && !entry.name.endsWith('.test.mjs')) {
      const routeName = entry.name.slice(0, -3); // remove .js
      const routeKey = `${prefix}/${routeName}`;
      map.set(routeKey, fullPath);
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
// Convert Node IncomingMessage -> Web Standard Request
// ─────────────────────────────────────────────────────────────
function toWebRequest(req, body) {
  const scheme = req.socket?.encrypted ? 'https' : 'http';
  const host = req.headers['host'] || `localhost:${PORT}`;
  const url = new URL(req.url, `${scheme}://${host}`);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return new Request(url.toString(), {
    method: req.method,
    headers,
    body: body && body.length > 0 ? body : undefined,
  });
}

// ─────────────────────────────────────────────────────────────
// Read request body
// ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────
// Write Web Response -> Node ServerResponse
// ─────────────────────────────────────────────────────────────
async function writeWebResponse(webRes, res) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webRes.status, headers);
  const body = await webRes.arrayBuffer();
  res.end(Buffer.from(body));
}

// ─────────────────────────────────────────────────────────────
// Serve a static file
// ─────────────────────────────────────────────────────────────
async function serveStatic(filePath, urlPath, res) {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': getCacheControl(urlPath),
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Serve index.html (SPA fallback)
// ─────────────────────────────────────────────────────────────
async function serveIndex(res) {
  const data = await readFile(join(DIST_DIR, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  });
  res.end(data);
}

// ─────────────────────────────────────────────────────────────
// Startup: build api handler map once
// ─────────────────────────────────────────────────────────────
const apiHandlerMap = await buildApiHandlerMap(API_DIR);
console.log(`[Server] Loaded ${apiHandlerMap.size} API routes`);

// Cache loaded handlers to avoid re-importing on every request
const handlerCache = new Map();

async function getApiHandler(filePath) {
  if (handlerCache.has(filePath)) return handlerCache.get(filePath);
  try {
    const mod = await import(filePath);
    const handler = mod.default || mod.handler;
    if (typeof handler !== 'function') return null;
    handlerCache.set(filePath, handler);
    return handler;
  } catch (err) {
    console.error(`[Server] Failed to load api handler: ${filePath}`, err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Request routing
// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const urlPath = new URL(req.url, 'http://localhost').pathname;

  try {
    // 1. API routes
    if (urlPath.startsWith('/api/')) {
      // Match route: strip trailing slash, normalize
      const routeKey = urlPath.replace(/\/+$/, '');

      // Try exact match first
      let handlerPath = apiHandlerMap.get(routeKey);

      // Try parent catch-all for sebuf RPC: /api/seismology/v1/list-earthquakes → api/[domain]/v1/[rpc].js
      if (!handlerPath) {
        const parts = routeKey.split('/'); // ['', 'api', 'seismology', 'v1', 'list-earthquakes']
        if (parts.length === 5 && parts[3] === 'v1') {
          const catchAll = `/[domain]/v1/[rpc]`;
          handlerPath = apiHandlerMap.get(catchAll);
        }
      }

      if (handlerPath) {
        const handler = await getApiHandler(handlerPath);
        if (handler) {
          const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;
          const webReq = toWebRequest(req, body);
          const webRes = await handler(webReq);
          await writeWebResponse(webRes, res);
          return;
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'API route not found', path: urlPath }));
      return;
    }

    // 2. Static file from dist/
    const staticPath = join(DIST_DIR, urlPath === '/' ? 'index.html' : urlPath);
    let fileStat;
    try {
      fileStat = await stat(staticPath);
    } catch {
      fileStat = null;
    }

    if (fileStat?.isFile()) {
      await serveStatic(staticPath, urlPath, res);
      return;
    }

    // 3. SPA fallback — serve index.html for unknown paths
    await serveIndex(res);

  } catch (err) {
    console.error(`[Server] Unhandled error for ${urlPath}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[Server] worldmonitor running on http://0.0.0.0:${PORT}`);
  console.log(`[Server] Serving static from: ${DIST_DIR}`);
  console.log(`[Server] API handlers loaded: ${apiHandlerMap.size}`);
  if (process.env.EXTRA_ALLOWED_ORIGINS) {
    console.log(`[Server] Extra CORS origins: ${process.env.EXTRA_ALLOWED_ORIGINS}`);
  }
  if (process.env.WS_RELAY_URL) {
    console.log(`[Server] Relay URL: ${process.env.WS_RELAY_URL}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

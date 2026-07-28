// Local dev/test server for the Family Archive.
//
// Same static serving as serve.mjs, PLUS a local implementation of the
// /api/ics serverless proxy (which only exists on Vercel in production). That
// means the Calendar works locally exactly like production — you can log in
// with your real account and see your real Google Calendar events.
//
//   node serve-local.mjs
//   → open http://localhost:3000/app/
//
// This file is for LOCAL TESTING ONLY. Production uses serve.mjs + Vercel's
// api/ics.js. Not part of the deploy.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Mirror api/ics.js: only proxy Google calendar ids (email-like or
// *.calendar.google.com), never arbitrary URLs.
const NO_URL_CHARS = /^[^\s/?]+$/;
const isGoogleId = (id) =>
  NO_URL_CHARS.test(id) && !id.includes('://') && id.includes('@') && /@[^@\s]+\.[^@\s]+$/.test(id);

async function handleIcs(req, res, url) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const id = url.searchParams.get('src') || '';
  if (!id || !isGoogleId(id)) { res.writeHead(400).end('bad_src'); return; }
  const upstream = `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;
  try {
    const r = await fetch(upstream, { headers: { 'User-Agent': 'FamilyArchive-LocalProxy/1.0' } });
    if (!r.ok) { res.writeHead(r.status === 404 ? 404 : 502).end('upstream_error'); return; }
    const text = await r.text();
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8' });
    res.end(text);
  } catch {
    res.writeHead(502).end('fetch_failed');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Local serverless-proxy stand-in.
  if (url.pathname === '/api/ics') { await handleIcs(req, res, url); return; }

  try {
    let urlPath = decodeURIComponent(url.pathname);
    if (urlPath === '/') urlPath = '/index.html';
    const safe = normalize(urlPath).replace(/^\/+/, '');
    const filePath = join(ROOT, safe);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    const s = await stat(filePath);
    if (s.isDirectory()) {
      const data = await readFile(join(filePath, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    }
    const data = await readFile(filePath);
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`\n  Family Archive — LOCAL test server`);
  console.log(`  ➜  App:      http://localhost:${PORT}/app/`);
  console.log(`  ➜  Landing:  http://localhost:${PORT}/`);
  console.log(`  (/api/ics proxy is live, so the Calendar works with real Google events)\n`);
});

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, isSea } from 'node:sea';
import { Mr100RouterClient } from './src/router-client.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.APP_HOST || '127.0.0.1';
const PORT = Number(process.env.APP_PORT || 3781);
const SESSION_TTL = 30 * 60 * 1000;
const sessions = new Map();

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
});

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cache-Control', 'no-store');
}

function json(response, status, data, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  response.end(JSON.stringify(data));
}

function parseCookies(request) {
  const out = {};
  for (const item of String(request.headers.cookie ?? '').split(';')) {
    const separator = item.indexOf('=');
    if (separator > 0) out[item.slice(0, separator).trim()] = item.slice(separator + 1).trim();
  }
  return out;
}

function getSession(request) {
  const id = parseCookies(request).mr100_session;
  const session = id ? sessions.get(id) : null;
  if (!session) return null;
  if (Date.now() - session.touchedAt > SESSION_TTL) {
    sessions.delete(id);
    session.client.logout().catch(() => {});
    return null;
  }
  session.touchedAt = Date.now();
  return session;
}

function requireSession(request) {
  const session = getSession(request);
  if (!session) {
    const error = new Error('Connect to the router first');
    error.status = 401;
    error.code = 'NOT_CONNECTED';
    throw error;
  }
  return session;
}

function verifyMutation(request, session) {
  if (request.headers['x-csrf-token'] !== session.csrf) {
    const error = new Error('Your app session is no longer valid. Refresh and reconnect.');
    error.status = 403;
    error.code = 'INVALID_CSRF';
    throw error;
  }
}

async function readJson(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 65536) {
      const error = new Error('Request is too large');
      error.status = 413;
      throw error;
    }
  }
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch {
    const error = new Error('Invalid JSON request');
    error.status = 400;
    throw error;
  }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/session') {
    const session = getSession(request);
    return json(response, 200, session ? {
      connected: true,
      csrf: session.csrf,
      router: { host: session.client.host, username: session.client.username, info: session.client.info },
    } : { connected: false });
  }

  if (request.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(request);
    const prior = getSession(request);
    if (prior) {
      sessions.delete(prior.id);
      await prior.client.logout().catch(() => {});
    }
    const client = new Mr100RouterClient(body);
    const router = await client.login();
    const id = crypto.randomBytes(24).toString('base64url');
    const session = { id, csrf: crypto.randomBytes(24).toString('base64url'), client, touchedAt: Date.now() };
    sessions.set(id, session);
    return json(response, 200, { connected: true, csrf: session.csrf, router }, {
      'Set-Cookie': `mr100_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`,
    });
  }

  const session = requireSession(request);
  if (request.method !== 'GET') verifyMutation(request, session);

  if (request.method === 'GET' && url.pathname === '/api/messages') {
    const result = await session.client.getMessages(url.searchParams.get('box') || 'inbox', url.searchParams.get('page') || 1);
    return json(response, 200, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/messages/send') {
    const body = await readJson(request);
    return json(response, 200, await session.client.sendSms(body.to, body.content));
  }
  if (request.method === 'POST' && url.pathname === '/api/messages/draft') {
    const body = await readJson(request);
    return json(response, 200, await session.client.saveDraft(body.to, body.content));
  }
  if (request.method === 'PATCH' && url.pathname === '/api/messages/read') {
    const body = await readJson(request);
    return json(response, 200, await session.client.markRead(body.stack));
  }
  if (request.method === 'DELETE' && url.pathname === '/api/messages') {
    const body = await readJson(request);
    return json(response, 200, await session.client.deleteMessage(body.box, body.stack));
  }
  if (request.method === 'DELETE' && url.pathname === '/api/messages/batch') {
    const body = await readJson(request);
    return json(response, 200, await session.client.deleteMessages(body.box, body.stacks));
  }
  if (request.method === 'DELETE' && url.pathname === '/api/messages/all') {
    const body = await readJson(request);
    if (body.box !== 'inbox' || body.confirmation !== 'DELETE ALL') {
      const error = new Error('Type DELETE ALL to confirm emptying the inbox');
      error.status = 400;
      error.code = 'CONFIRMATION_REQUIRED';
      throw error;
    }
    return json(response, 200, await session.client.deleteAllInbox());
  }
  if (request.method === 'POST' && url.pathname === '/api/logout') {
    await session.client.logout().catch(() => {});
    sessions.delete(session.id);
    return json(response, 200, { connected: false }, {
      'Set-Cookie': 'mr100_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
  }
  return json(response, 404, { error: { code: 'NOT_FOUND', message: 'API endpoint not found' } });
}

async function readPublicFile(filePath) {
  if (!isSea()) return fs.readFile(filePath);
  const key = `public/${path.relative(PUBLIC, filePath).split(path.sep).join('/')}`;
  try {
    return Buffer.from(getAsset(key));
  } catch (error) {
    if (error.code === 'ERR_SINGLE_EXECUTABLE_APPLICATION_ASSET_NOT_FOUND') error.code = 'ENOENT';
    throw error;
  }
}

async function serveStatic(response, url) {
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const filePath = path.resolve(PUBLIC, relative);
  if (!filePath.startsWith(`${PUBLIC}${path.sep}`) && filePath !== path.join(PUBLIC, 'index.html')) {
    return json(response, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden' } });
  }
  try {
    const data = await readPublicFile(filePath);
    response.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    response.end(data);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = await readPublicFile(path.join(PUBLIC, 'index.html'));
    response.writeHead(200, { 'Content-Type': MIME['.html'] });
    response.end(data);
  }
}

const server = http.createServer(async (request, response) => {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else if (request.method === 'GET' || request.method === 'HEAD') await serveStatic(response, url);
    else json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' } });
  } catch (error) {
    const status = Number(error.status) || 500;
    json(response, status, {
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || 'Unexpected application error',
      },
    });
  }
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.touchedAt > SESSION_TTL) {
      sessions.delete(id);
      session.client.logout().catch(() => {});
    }
  }
}, 60_000);
cleanup.unref();

server.listen(PORT, HOST, () => {
  console.log(`MR100 SMS Manager is running at http://${HOST}:${server.address().port}`);
});

async function shutdown() {
  for (const session of sessions.values()) await session.client.logout().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };

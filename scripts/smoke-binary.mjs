import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, readdir, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
const filename = `mr100-sms-manager-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const source = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'dist', filename);
const directory = await mkdtemp(path.join(os.tmpdir(), 'mr100-standalone-'));
const executable = path.join(directory, filename);
let child;
let copied = false;
try {
  await copyFile(source, executable);
  copied = true;
  child = spawn(executable, [], {
    cwd: directory,
    env: {
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
      PATH: '', HOME: directory, TEMP: directory, TMP: directory,
      APP_HOST: '127.0.0.1', APP_PORT: '0',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Executable did not start within 15 seconds.\n${output}`)), 15000);
    const finish = (error, url) => {
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(url);
    };
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => finish(new Error(`Executable exited (${code}).\n${output}`)));
    child.stderr.on('data', (data) => { output += data; });
    child.stdout.on('data', (data) => {
      output += data;
      const match = /running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) finish(null, match[1]);
    });
  });
  const get = (route) => fetch(`${origin}${route}`, { signal: AbortSignal.timeout(5000) });
  const session = await get('/api/session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { connected: false });
  const restricted = await get('/api/messages?box=sent');
  assert.equal(restricted.status, 401, 'binary must retain authentication checks');
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.equal(await home.text(), await readFile(path.join(root, 'public', 'index.html'), 'utf8'));
  assert.equal(home.headers.get('content-security-policy').includes('cdnjs'), false);

  let assetCount = 0;
  const digest = (data) => createHash('sha256').update(data).digest('hex');
  async function verifyAssets(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) { await verifyAssets(file); continue; }
      const relative = path.relative(path.join(root, 'public'), file).split(path.sep).join('/');
      const response = await get(`/${relative}`);
      assert.equal(response.status, 200, relative);
      assert.equal(digest(Buffer.from(await response.arrayBuffer())), digest(await readFile(file)), `${relative} must be embedded intact`);
      if (file.endsWith('.woff2')) assert.equal(response.headers.get('content-type'), 'font/woff2');
      assetCount += 1;
    }
  }
  await verifyAssets(path.join(root, 'public'));
  const head = await fetch(`${origin}/styles.css`, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const fallback = await get('/missing-file');
  assert.equal(fallback.status, 200, 'missing embedded assets retain source-server fallback behavior');
  assert.match(await fallback.text(), /MR100 SMS Desk/);
  assert.deepEqual(await readdir(directory), [filename], 'runtime must not extract assets or need sidecar files');
  console.log(`Standalone smoke test passed: ${assetCount} embedded assets, login page, session API, and authentication checks.`);
  console.log('Verified from an empty temporary folder with an empty PATH; no router was contacted.');
} finally {
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, 'close');
    child.kill();
    await closed;
  }
  if (copied) await unlink(executable);
  await rmdir(directory);
}

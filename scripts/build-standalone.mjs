import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { vendorAssets } from './vendor-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 25 || (major === 25 && minor < 5)) {
  console.error('Standalone builds require Node.js 25.5 or newer (Node 26 recommended). Running from source still supports Node 22+.');
  process.exit(1);
}
if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
  console.error(`Standalone builds are not configured for ${process.platform}.`);
  process.exit(1);
}
if (process.platform === 'darwin' && process.arch !== 'arm64') {
  console.error('This standalone build supports macOS ARM64 only. Use npm start on Intel Macs.');
  process.exit(1);
}
if (process.argv.length > 2) {
  console.error('This command builds for the current OS and architecture. Run it on the target machine to build for another platform.');
  process.exit(1);
}

const work = path.join(root, '.build');
const dist = path.join(root, 'dist');
const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux';
const filename = `mr100-sms-manager-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;
const executable = path.join(dist, filename);
const bundle = path.join(work, 'server.cjs');
await mkdir(work, { recursive: true });
await mkdir(dist, { recursive: true });
await vendorAssets();

const { build } = await import('esbuild');
await build({
  absWorkingDir: root,
  entryPoints: ['server.js'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // SEA's __filename is the executable path; preserve asset path validation.
  define: { 'import.meta.url': '__appImportMetaUrl' },
  banner: { js: "const __appImportMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  logLevel: 'info',
});

const assets = {};
async function collectAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectAssets(file);
    else if (entry.isFile()) assets[path.relative(root, file).split(path.sep).join('/')] = file;
    else throw new Error(`Refusing to embed a symlink or special file: ${file}`);
  }
}
await collectAssets(path.join(root, 'public'));
assets['README.md'] = path.join(root, 'README.md');
const configFile = path.join(work, 'sea-config.json');
await writeFile(configFile, JSON.stringify({
  main: bundle,
  mainFormat: 'commonjs',
  output: executable,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: 'none',
  assets,
}, null, 2));

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}`);
}
run(process.execPath, ['--build-sea', configFile]);
if (process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', executable]);
const bytes = await readFile(executable);
const sha256 = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${executable}.sha256`, `${sha256}  ${filename}\n`);
console.log(`Built ${executable} (${(bytes.length / 1024 / 1024).toFixed(1)} MiB)`);
console.log(`Embedded ${Object.keys(assets).length} assets with Node ${process.versions.node}.`);
console.log('Copy the executable alone to the target machine; Node.js is not required there.');

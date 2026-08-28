import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function releaseNotes(changelog, tag, packageVersion) {
  const version = typeof tag === 'string' && tag.startsWith('v') ? tag.slice(1) : '';
  const parsed = semver.exec(version);
  if (!parsed || parsed[0] !== version || parsed[4]?.split('.').some((part) => /^0\d+$/.test(part))) {
    throw new Error('Release tags must use vMAJOR.MINOR.PATCH, optionally with a SemVer prerelease/build suffix.');
  }
  if (version !== packageVersion) {
    throw new Error(`Tag ${tag} does not match package.json version ${packageVersion}.`);
  }

  const lines = String(changelog).replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current;
  let fence;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      current?.lines.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = marker[1];
      current?.lines.push(line);
      continue;
    }
    if (/^##[ \t]+/.test(line)) {
      const heading = /^##[ \t]+(?:\[([^\]]+)\]|([^\s]+))(?:[ \t].*)?$/.exec(line);
      const headingVersion = (heading?.[1] || heading?.[2] || '').replace(/^v/, '');
      current = { version: headingVersion, lines: [] };
      sections.push(current);
    } else {
      current?.lines.push(line);
    }
  }
  const matches = sections.filter((section) => section.version === version);
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md must contain exactly one "## [${version}]" section; found ${matches.length}.`);
  }
  const notes = matches[0].lines.join('\n').trim();
  if (!notes.replace(/<!--[\s\S]*?-->/g, '').replace(/^#{1,6}[ \t]+.*$/gm, '').trim()) {
    throw new Error(`The changelog entry for ${tag} is empty.`);
  }
  return { version, prerelease: Boolean(parsed[4]), notes: `${notes}\n` };
}

async function main() {
  const [tag, output = '.build/release-notes.md', ...extra] = process.argv.slice(2);
  if (!tag || extra.length) throw new Error('Usage: node scripts/release-notes.mjs <v1.0.0> [output.md]');
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.version !== manifest.version || lock.packages[''].version !== manifest.version) {
    throw new Error('package-lock.json and package.json versions differ. Run npm install --package-lock-only.');
  }
  const metadata = releaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), tag, manifest.version);
  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, metadata.notes);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${metadata.version}\nprerelease=${metadata.prerelease}\n`);
  }
  console.log(`Validated ${tag}; release notes written to ${outputPath}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

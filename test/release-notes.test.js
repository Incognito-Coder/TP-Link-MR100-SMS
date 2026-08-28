import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { releaseNotes } from '../scripts/release-notes.mjs';

const changelog = `# Changelog

## [Unreleased]

- Work in progress.

## [1.0.0] - 2026-08-28

### Added

- Standalone executables.

### Fixed

- Folder synchronization.

## [0.9.0] - 2026-08-27

- Older changes.
`;

test('release body contains only the tagged version and preserves Markdown', () => {
  assert.deepEqual(releaseNotes(changelog, 'v1.0.0', '1.0.0'), {
    version: '1.0.0', prerelease: false,
    notes: '### Added\n\n- Standalone executables.\n\n### Fixed\n\n- Folder synchronization.\n',
  });
});

test('release notes support CRLF, plain headings, and v-prefixed headings', () => {
  for (const heading of ['## 1.0.0', '## v1.0.0', '## [v1.0.0]']) {
    const result = releaseNotes(`${heading} - 2026-08-28\r\n\r\n- Change.\r\n`, 'v1.0.0', '1.0.0');
    assert.equal(result.notes, '- Change.\n');
  }
});

test('prerelease tags are distinguished from stable tags with build metadata', () => {
  const pre = releaseNotes('## [1.1.0-rc.1]\n\n- Candidate.', 'v1.1.0-rc.1', '1.1.0-rc.1');
  assert.equal(pre.prerelease, true);
  const stable = releaseNotes('## [1.0.0+build.01]\n\n- Build.', 'v1.0.0+build.01', '1.0.0+build.01');
  assert.equal(stable.prerelease, false);
});

test('release version must match package.json exactly', () => {
  assert.throws(() => releaseNotes(changelog, 'v1.0.0', '1.0.1'), /does not match/);
});

test('invalid tags cannot enter workflow outputs or shell commands', () => {
  for (const tag of ['1.0.0', 'vlatest', 'v1.0', 'v01.0.0', 'v1.0.0-01', 'v1.0.0-rc.01', 'v1.0.0-rc..1', 'v1.0.0\n', 'v1.0.0\nprerelease=false', 'v1.0.0;echo bad']) {
    assert.throws(() => releaseNotes(changelog, tag, tag.slice(1)), /Release tags must/);
  }
});

test('missing or duplicate changelog entries fail the release', () => {
  assert.throws(() => releaseNotes(changelog, 'v2.0.0', '2.0.0'), /found 0/);
  assert.throws(() => releaseNotes(`${changelog}\n## [1.0.0]\n- Duplicate.`, 'v1.0.0', '1.0.0'), /found 2/);
});

test('empty entries and entries with only headings or comments fail', () => {
  for (const body of ['', '\n### Added\n', '\n<!-- TODO: release notes -->\n']) {
    assert.throws(() => releaseNotes(`## [1.0.0]\n${body}\n## [0.9.0]\n- Old.`, 'v1.0.0', '1.0.0'), /empty/);
  }
});

test('headings inside fenced code do not split changelog entries', () => {
  for (const fence of ['```', '~~~~']) {
    const body = `- Example:\n\n${fence}markdown\n## [0.0.0]\nnot another release\n${fence}\n`;
    assert.equal(releaseNotes(`## [1.0.0]\n${body}\n## [0.9.0]\n- Old.`, 'v1.0.0', '1.0.0').notes, body);
  }
});

test('a non-version level-two heading also ends the current entry', () => {
  const result = releaseNotes('## [1.0.0]\n- Change.\n\n## Maintenance\nNot part of the release.', 'v1.0.0', '1.0.0');
  assert.equal(result.notes, '- Change.\n');
});

test('CLI validates the project changelog and writes notes and GitHub outputs', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mr100-release-notes-'));
  const notesPath = path.join(directory, 'notes.md');
  const outputsPath = path.join(directory, 'github-output');
  try {
    const result = spawnSync(process.execPath, ['scripts/release-notes.mjs', `v${manifest.version}`, notesPath], {
      cwd: root, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GITHUB_OUTPUT: outputsPath },
    });
    assert.equal(result.status, 0, result.stderr);
    const expected = releaseNotes(await readFile(path.join(root, 'CHANGELOG.md'), 'utf8'), `v${manifest.version}`, manifest.version);
    assert.equal(await readFile(notesPath, 'utf8'), expected.notes);
    assert.equal(await readFile(outputsPath, 'utf8'), `version=${expected.version}\nprerelease=${expected.prerelease}\n`);
  } finally {
    await unlink(notesPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await unlink(outputsPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
});

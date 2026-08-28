# MR100 SMS Desk

A private, local Node.js web app for managing SMS on TP-Link TL-MR100-style routers that use the encrypted `/cgi_gdpr` interface.

## Features

- Logs in with the router's local account using its RSA + AES-128-CBC protocol.
- Reads paginated Inbox, Sent, and Draft folders.
- Sends GSM-7 and Unicode messages with multipart counting.
- Saves drafts, marks inbox messages read, and deletes messages.
- Correctly renders Persian/RTL messages and the router's embedded line separators.
- Stores credentials, cookies, AES keys, and SMS data in memory only.
- Listens on `127.0.0.1` by default and has no third-party runtime dependencies.

## Run

Requirements: Node.js 22 or newer and a computer connected to the router's LAN.

```powershell
cd C:\path\to\mr100-sms-manager
npm start
```

Open [http://127.0.0.1:3781](http://127.0.0.1:3781), then enter:

- Router address: usually `192.168.0.1` or `192.168.1.1`
- Username: usually `admin`
- The router's **local** password (TP-Link cloud login is not supported)

The router may allow only one management session. Close or log out of its original web UI if the app reports that the router is busy.

## Standalone executable

The standalone build contains the Node.js runtime, server, HTML, JavaScript, CSS,
icons, and fonts. The destination computer does not need Node.js, npm, or the
source folder. A browser and a connection to the router's LAN are still required;
the interface does not download assets from a CDN.

### Build

Use **Node.js 25.5 or newer** on the build machine (Node 26 recommended). Running
the source with `npm start` still supports Node 22 or newer.

```powershell
npm ci
npm test
npm run build
npm run test:binary
```

`npm run build:exe` is an alias for `npm run build`. Build dependencies are pinned
in `package-lock.json`; the first `npm ci` requires internet access. The build
itself uses the installed Node binary, without downloading another runtime.

Build on the destination OS and CPU architecture. This command does **not**
cross-compile Windows and Linux executables in one run.

| Build machine | Output |
| --- | --- |
| Windows x64 | `dist/mr100-sms-manager-win-x64.exe` |
| Linux x64 | `dist/mr100-sms-manager-linux-x64` |
| Linux ARM64 | `dist/mr100-sms-manager-linux-arm64` |
| macOS ARM64 | `dist/mr100-sms-manager-macos-arm64` |

The output targets the operating systems supported by the Node version used to
build it; a Linux binary is not fully static. macOS builds require `codesign`
and receive an ad-hoc signature. Other platform builds must be tested on those
platforms. Windows builds are unsigned; sign releases with your own certificate
if distributing them to other users.

The build also writes a `.sha256` checksum beside the executable. Rebuild with an
updated Node version to include runtime security updates. The implementation uses
[Node single executable applications](https://nodejs.org/api/single-executable-applications.html).

### Run

Copy only the executable to any folder and launch it:

```powershell
.\mr100-sms-manager-win-x64.exe
```

On Linux/macOS:

```sh
chmod +x ./mr100-sms-manager-linux-x64
./mr100-sms-manager-linux-x64
```

Use the matching output filename for your platform. Open
[http://127.0.0.1:3781](http://127.0.0.1:3781) in your browser, and keep the terminal
running. Press Ctrl+C to stop it. `APP_HOST` and `APP_PORT` work as described below;
stop the source server first or choose a different port.

`npm run test:binary` copies the executable into an otherwise empty temporary
folder, launches it with an empty `PATH`, and verifies every embedded asset plus
the unauthenticated API. It never logs into the router or sends/deletes SMS.

Font Awesome files and their license are kept in `public/vendor/fontawesome`.
Run `npm run vendor:assets` to refresh them from the pinned build dependency.

## GitHub Releases

`.github/workflows/release.yml` runs when a tag matching `v*` is pushed. Keep this
project at the repository root so GitHub can discover the workflow.

Each tag starts native builds on Windows x64, Linux x64, Linux ARM64, and macOS
ARM64 runners. Every job runs `npm ci`, the test suite, the standalone build, and
the isolated binary smoke test. The release is published only after all four
platforms pass, with four executables and their four `.sha256` files attached.
All builds use the same resolved Node 26 version. The release workflow uses
pinned official GitHub actions and the repository's automatic `GITHUB_TOKEN`;
no personal access token or additional secret is required.

The release body is the matching version section from `CHANGELOG.md`, preserving
its Markdown. `Unreleased` and older versions are excluded. A missing, duplicate,
or empty entry stops the release, as does a mismatch between the tag,
`package.json`, and `package-lock.json` versions. Prerelease tags such as
`v1.1.0-rc.1` create a GitHub prerelease and are not marked Latest.

### Publish a version

1. Update the package version, for example `npm version 1.0.1 --no-git-tag-version`.
2. Add `## [1.0.1] - YYYY-MM-DD` to `CHANGELOG.md` with the changes for that version.
3. Validate the notes and commit the changes, then push the matching tag:

```sh
npm test
npm run release:notes -- v1.0.1
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release v1.0.1"
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin HEAD
git push origin v1.0.1
```

Commit the workflow and its helper scripts before pushing the first release tag.
The existing `1.0.0` changelog entry can be used for the first `v1.0.0` release.
Tag pushes publish automatically: do not push a release tag until it is ready.
The workflow does not overwrite existing releases or create missing tags. If an
upload failure leaves an unpublished draft, remove that incomplete draft before
rerunning the release job; do not delete a published release to retry it.

The repository must permit Actions to write release contents and have access to
the runner labels in the matrix. Builds use standard hosted runners, including
`ubuntu-24.04-arm` and `macos-14`; repository policies and billing limits still
apply. Windows executables remain unsigned and macOS executables use ad-hoc
signing, not Apple notarization.

## Configuration

Optional environment variables:

```powershell
$env:APP_HOST = '127.0.0.1'
$env:APP_PORT = '3781'
npm start
```

Keep `APP_HOST` set to `127.0.0.1` unless you intentionally want other devices on your LAN to reach this dashboard. The app cookie is designed for local HTTP use and does not replace network-level access control.

## Test

```powershell
npm test
```

The test suite runs against a simulated encrypted MR100 and does not connect to your router, send SMS, or delete real messages.

## Supported firmware

This version targets the legacy MR100 firmware flow observed in the supplied captures:

- `/cgi/getParm` returns a 512-bit RSA modulus, exponent, and sequence.
- Login and `/cgi_gdpr` payloads use AES-128-CBC with PKCS#7 padding.
- Requests contain `sign=` and `data=` fields without a separate GCM tag.

Newer firmware that sends a separate `tag=` value uses AES-GCM and is not enabled in this first release.

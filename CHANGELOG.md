# Changelog

All notable changes to MR100 SMS Desk are documented here.
Release tags use `vMAJOR.MINOR.PATCH` and match the version in `package.json`.

## [Unreleased]

## [1.0.0] - 2026-08-28

### Added

- Local SMS dashboard for TP-Link MR100 routers using the encrypted router protocol.
- Inbox, Sent, and Drafts with pagination, message composition, draft saving, and deletion.
- Light/dark themes and support for Persian and RTL message content.
- Standalone executable builds with the Node runtime, frontend, icons, fonts, and licenses embedded.
- SHA-256 checksums and isolated executable smoke tests.
- Tag-triggered GitHub Releases with Windows x64, Linux x64/ARM64, and macOS ARM64 builds.

### Fixed

- Centered the login card on the page.
- Synchronized Sent and Drafts before reading their message counts.
- Preserved the latest folder selection while messages are loading.
- Displayed empty/error states and restored mobile folder labels.

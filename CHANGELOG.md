# Changelog

## 1.0.0 — 2026-10-25

Initial OpenProxy Desktop baseline for Windows x64.

- Local loopback proxy with Anthropic Messages and HTTP Responses support.
- Manual account selection, Enable/Disable, independent login, and read-only Codex auth links.
- Manual plan/quota refresh with explicit unknown billing status and stale metadata.
- Dark desktop interface, startup progress, and resize repaint fixes.
- File-based client setup for Claude Code and compatible local Codex clients; raw HTTP examples for API clients.
- Portable ZIP with bundled Node.js, pinned upstream engine, licenses, manual test guide, and SHA-256.
- Repository cleanup removes unused upstream Rust/website/Nix/release tooling while preserving source history and attribution.
- Windows CI verifies the package and publishes tagged releases.

Engine version remains claude-code-proxy v0.1.46; it has not been modified or renumbered.

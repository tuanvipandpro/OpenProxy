# OpenProxy 1.0.0

First baseline release of OpenProxy Desktop for Windows x64.

- Start and stop a local proxy on demand, with manual account selection and per-account Enable/Disable.
- Link Codex auth.json files read-only or sign in to independent ChatGPT accounts.
- Refresh account plan/quota information manually, keeping unknown billing status and stale data explicit.
- Configure Claude Code through settings.json or local Codex through config.toml using the built-in Getting started guide.
- Use Anthropic Messages or HTTP Responses from a local HTTP client.
- Dark desktop interface with startup progress and corrected redraw behavior when resizing.

## Download and run

Download **OpenProxy-1.0.0-windows-x64.zip**, extract the full folder, and run **OpenProxy.exe**. Keep **resources** beside the executable. Requires Windows 10/11 x64 and .NET Framework 4.8. Node.js and engine v0.1.46 are bundled; no separate Node installation is required.

The matching **.sha256** file contains the archive checksum. Existing account data stays outside the portable folder at `%LOCALAPPDATA%\OpenProxy`.

## Scope and verification

The release includes automated logic/API checks and package verification. Native Windows UI and live subscription behavior remain covered by the included manual test guide. Ordinary ChatGPT desktop/web chats are not confirmed to use the Codex provider configuration. WebSockets and stored-response continuation are unsupported. Accounts never rotate automatically.

Upstream source attribution and licenses are included. No credentials or local account state are packaged.

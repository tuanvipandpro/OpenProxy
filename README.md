# OpenProxy

A local proxy for Claude Code using ChatGPT/Codex access, with manual account switching. Claude Code connects to one endpoint while OpenProxy forwards new requests through the account you select.

```text
Claude Code -> 127.0.0.1:1234 -> selected account -> Codex Responses
```

One account is enough to get started. Add others when needed. Accounts never rotate automatically when quota runs out.

**Version 1.0.0** is the first OpenProxy Desktop baseline. It includes manual account switching, plan/quota lookup, a dark interface with startup progress, and file-only client configuration. See [SELF_TEST.md](SELF_TEST.md) for manual Windows UI/live-account checks. Native UI testing remains separate from automated verification.

## Windows desktop

Download [OpenProxy 1.0.0 for Windows x64](https://github.com/tuanvipandpro/OpenProxy/releases/download/v1.0.0/OpenProxy-1.0.0-windows-x64.zip) from [Releases](https://github.com/tuanvipandpro/OpenProxy/releases). Extract the entire folder and open `OpenProxy.exe`. Keep `resources` beside it. The matching `.sha256` asset contains the ZIP checksum. Node and the upstream engine are bundled; no separate Node installation is needed. Requires Windows 10/11 x64 with .NET Framework 4.8.

1. Open **OpenProxy.exe**. A small startup window shows the current step and elapsed time before the main window opens. The proxy starts **stopped**.
2. Choose **+ Add account → Link current Codex login**, or **Sign in to another ChatGPT account**.
3. Click **Start proxy**. The default endpoint is `http://127.0.0.1:1234`.
4. Click **Getting started**, choose your client, and follow the four steps. Click **Copy config**, merge it into the displayed settings file, save, and restart your client yourself.
5. Click **Use account** to switch. Running requests keep their original account; new requests use your selection.

Each account has **Enable/Disable** and **Refresh** actions. Disabling the active account clears the selection and blocks new inference requests until another enabled account is chosen; it never rotates automatically. Flags persist across restarts, and existing accounts default to enabled. Disabled accounts retain their credentials and cached information but cannot be selected or refreshed.

**Refresh** performs a read-only plan/quota lookup using that account's access token. Plan, local authentication status, quota windows, and verification time are shown independently. Token-derived plan hints are unverified; old/failed checks are marked stale. Billing renewal/cancellation dates remain **Unknown** because they are not established by the usage endpoint. The lookup does not run a model, rotate refresh tokens, or consume a quota reset. The usage endpoint follows the [official Codex backend client's implementation](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs) and can change or be unavailable for some accounts.

Closing the window stops the proxy the desktop app started and cleans up its backend and engine processes. There is no tray mode or Windows auto-start. A proxy started separately from CLI remains owned by that CLI session.

Desktop and CLI share account data outside the portable folder. Stop the proxy before adding or re-authenticating an independent login or changing its listening port. Desktop settings contain only the local port. OpenProxy does not launch coding clients or manage their model/project selection.

Startup loads local modules, settings, account summaries, and the interface. It does not start an inference engine, refresh subscriptions, or make model calls. Progress tracks completed stages rather than an estimated percentage. Failures offer Retry, and closing during startup waits for backend cleanup. Windows/.NET initialization occurs before the first application window can be painted. The initial Recent activity message reports elapsed time measured from the loading window's initialization through main-window construction.

### Client configuration guides

**Getting started** is available even while the proxy is stopped or no accounts have been added. It shows a key placeholder in previews. Clicking **Copy config** or **Copy request** explicitly exports a complete snippet containing only the local proxy key, never upstream account access/refresh tokens. Keep copied configurations private. No client file is edited automatically. Reopen the guide after changing the port.

- **Claude Code:** open `%USERPROFILE%\.claude\settings.json` (or the file under `CLAUDE_CONFIG_DIR`), back it up, and merge the copied `env` object. Save and restart the CLI; check `/status`, then choose a discovered GPT model with `/model`. Remove conflicting cloud provider flags and older OpenProxy helper settings. This uses the proxy root URL, without `/v1`.
- **ChatGPT / Codex:** back up user-level `config.toml`, put `model_provider` before any table, and replace the old OpenProxy provider/auth sections with the copied provider. Its `/v1` base URL and direct local bearer key require no helper commands. Restart the client and create a new local Codex chat. Native sign-in/avatar stays unchanged; ordinary ChatGPT desktop/web chat routing remains unverified.
- **API calls:** copy a raw HTTP request for a local HTTP client. Use the same Authorization header with `GET /v1/models` to choose a model ID. Browser-origin calls and Chat Completions-only clients are unsupported.

### Choose models inside Claude Code

OpenProxy does not choose a coding or background model. Open Claude Code and use `/model` to choose from the proxy's discovered GPT catalog, or type a model ID directly, such as `/model gpt-6-sol`. Claude Code manages your choice and saved defaults. Previously saved OpenProxy model and project-folder fields are ignored; account settings are retained.

The guide's settings enable gateway model discovery and preserve user-owned model preferences. Use a recent Claude Code version (v2.1.257+ for discovery while nonessential traffic is disabled). Model discovery uses a compatibility routing ID, while the picker shows the actual GPT name. The proxy decodes that ID back to the same GPT model on requests. Catalog entries describe engine support, not guaranteed account entitlement.

The desktop no longer contains a Claude Code executable picker. Legacy launcher preferences are retained in storage but not used by the desktop. The optional CLI `claude` command remains available for terminal users. See [Claude Code gateway model discovery](https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery).

## CLI

Requires Node.js 22+; `openproxy.ps1` can also find the Node runtime bundled with Codex on this machine. No Rust installation or npm dependencies are needed.

```powershell
.\openproxy.ps1 setup
.\openproxy.ps1 account link-codex personal
.\openproxy.ps1 serve --port 1234
```

In another terminal:

```powershell
.\openproxy.ps1 claude
```

Add an independent account while the proxy is stopped, then switch after restarting it:

```powershell
.\openproxy.ps1 account add secondary
# Optional device-code login:
# .\openproxy.ps1 account add secondary --device

.\openproxy.ps1 account list
.\openproxy.ps1 account use secondary
.\openproxy.ps1 status
.\openproxy.ps1 account use personal
.\openproxy.ps1 account disable personal
.\openproxy.ps1 account enable secondary
.\openproxy.ps1 account refresh secondary
.\openproxy.ps1 account info secondary
```

If login is interrupted, use `account login NAME`. To inspect the catalog and open Claude Code:

```powershell
.\openproxy.ps1 models
.\openproxy.ps1 claude
```

Choose the model with `/model` in Claude Code. OpenProxy no longer accepts model overrides in its launcher.

You can also use `node openproxy/cli.mjs ...`. Run `--help` for all commands.

## Account credentials

| Command | Credential ownership |
| --- | --- |
| `account add NAME` | The upstream engine signs in and refreshes tokens in an independent OpenProxy profile. Best for keeping multiple accounts. |
| `account link-codex NAME` | Reads the native Codex credentials before each request. Projects only the access token; never copies the refresh token or changes the native auth file. |

Codex links use `CODEX_HOME/auth.json`, or `~/.codex/auth.json` by default. To link a separate profile:

```powershell
.\openproxy.ps1 account link-codex work --source 'C:\MyCodexProfile\auth.json'
```

Only file-backed ChatGPT login is supported for links. OS-keyring-only credentials and API keys are not supported by `link-codex`. A changed identity in the source file is rejected rather than silently switching the linked account. Near-expiry sessions need refreshing through Codex or an independent login. Switching accounts shares the portable conversation history with the newly selected account/workspace.

## Storage and behavior

- Default data directory: `%LOCALAPPDATA%\OpenProxy` on Windows, `~/.local/share/openproxy` elsewhere. Override with `OPENPROXY_HOME` or `--home PATH`; use the same directory across terminals.
- New Windows state directories restrict ACLs to the current user and SYSTEM. Unix directories use `0700`, files `0600`. Credentials remain sensitive local data.
- The public listener binds to loopback, requires a local token, and rejects browser origins or unrecognized hostnames. Client configuration is explained in Getting started.
- Internal per-account engine ports also bind to loopback but inherit the upstream engine's unauthenticated listener. Other applications on this computer must be trusted.
- No additional telemetry or traffic capture is enabled. Upstream operational logs and error-response captures can still contain sensitive response content.
- Accepted routes: Messages, count_tokens, models, and HTTP Responses. JSON request bodies are limited to 64 MiB; responses stream without buffering the complete response.
- Private continuation, WebSockets, and server compaction are disabled. Encrypted reasoning signatures are removed from replayed history; text, tool calls, and tool results remain portable. This can reduce the benefit of native reasoning replay.
- OpenProxy never replays a broken stream on another account. The upstream engine retains its own internal retry behavior.
- **Getting started → ChatGPT / Codex → Copy config** exports provider configuration containing the local proxy key as `experimental_bearer_token`. This direct-token setting serves this local personal integration; no upstream credential is exported. Normal status/guide previews never expose the key. The configuration does not change native Codex login or edit client files. Full history and local compaction are required; stored continuation and WebSockets are unsupported.
- The launcher uses a 200,000-token auto-compaction threshold. Models must support the requested context size; the `[1m]` client hint does not grant additional upstream context.

## Development

```powershell
node openproxy/cli.mjs setup
node --test openproxy/test/*.test.mjs
node desktop/build.mjs
# Build a separate copy while an older executable is open:
node desktop/build.mjs --versioned
node desktop/verify-package.mjs
```

Tests use fake credentials and a local upstream, including tool-call translation through the real pinned engine. Engine tests are skipped if it is not installed. They do not consume ChatGPT quota.

The desktop build uses the Windows C# compiler for a native WinForms interface and bundles the active Node runtime and engine `v0.1.46`, with licenses and an archive checksum. The private desktop backend communicates through stdin/stdout, without another management HTTP listener.

## Upstream

OpenProxy uses the unchanged engine from [raine/claude-code-proxy](https://github.com/raine/claude-code-proxy), pinned to v0.1.46. Upstream Rust sources, website docs, and unrelated build/release tooling are not needed in the OpenProxy working tree. Their history remains in Git and the upstream repository. Attribution, the MIT notice, and runtime licenses are preserved; see [NOTICE.md](NOTICE.md).

## Releases

The Windows workflow checks source versions, installs the pinned engine, runs logic/integration tests, builds the portable package, and verifies its contents, bundled executable versions, and SHA-256. Pushing an annotated `v<package-version>` tag publishes the ZIP and checksum to GitHub Releases using the repository's built-in workflow token. No custom release secret is required. See [RELEASE_NOTES.md](RELEASE_NOTES.md) and [CHANGELOG.md](CHANGELOG.md).

This remains an experimental subscription-backed integration. Anthropic [does not support routing Claude Code to non-Claude models](https://code.claude.com/docs/en/llm-gateway). Running locally does not guarantee future provider policy, quota, or account access.

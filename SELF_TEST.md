# OpenProxy 0.6.1 manual test guide

Logic/API checks are automated. Native Windows layout, startup timing, and live account behavior are left for you to verify. These steps require no shell setup.

## 1. Open the new release

1. Close the older OpenProxy version; closing it stops the proxy it owns.
2. Extract the full portable ZIP and open `OpenProxy.exe`. Keep `resources` beside it.
3. Expect the small five-stage loading window, followed by the main window with the proxy stopped.
4. Existing accounts should remain present. Settings contains only the local port.

Layout checks:

- The main window uses neutral dark gray surfaces with a restrained accent. A selected account has a subtle highlight and a readable **Selected** label.
- Resize to the minimum window size and maximize. The connection buttons, URL, account header, footer, and recent activity must stay separate.
- Repeat maximize/restore several times, then drag the window through narrow and wide sizes. Old rounded borders must not remain inside the resized cards. Hover buttons and trigger status/account updates afterward; background patches must remain consistent around labels and actions.
- Check at 100%, 125%, and 150% Windows scaling if available. There should be no overlapping text/actions or rectangular corner artifacts.
- With one account, Accounts should be compact. With more accounts, scroll the list and check actions stay aligned at the right edge.
- Disabled actions should remain readable, without black text disappearing on a dark button.
- Settings, account-name dialogs, menus, tooltips, error notices, and loading use the same dark palette. The system file picker follows Windows styling.

Startup checks:

- Move the loading window while it waits. It should remain responsive while starting the backend.
- Record time from clicking the executable to loading, and separately its displayed time until the main window. Windows/.NET initialization occurs before the app can draw its first window.
- Fast launches may only briefly show loading; there is no artificial delay.
- Close during loading and check no owned backend/listener remains afterward.
- Optional: in a disposable extracted copy, rename its `resources/runtime/node.exe`, open that copy, then restore the file and choose Retry. Leave normal app/account files unchanged.

## 2. Getting started

Open **Getting started** while stopped, with or without accounts. Expect three sidebar choices: **Claude Code**, **ChatGPT / Codex**, and **API calls**.

Each section should have four numbered steps, the file path or request type, and a separate code panel. There should be no PowerShell option, encoded command, or credential helper.

The displayed preview uses `OPENPROXY_LOCAL_API_KEY`. Clicking **Copy config** or **Copy request** deliberately fills that placeholder with the local proxy key. Keep copied files/text private. No upstream access/refresh token should be exported. No file is edited and no coding client is opened automatically.

Change the port in Settings while stopped, reopen Getting started, and confirm the address, previews, and copied configurations use the new port.

## 3. Claude Code: edit settings.json

1. Select an enabled account and start OpenProxy.
2. Open **Getting started → Claude Code**. In your editor, open `%USERPROFILE%\.claude\settings.json`, or the displayed path under `CLAUDE_CONFIG_DIR`. Create it if missing.
3. Back up existing settings. Click **Copy config** and merge its `env` object into the file. Keep unrelated settings. Remove older OpenProxy helper settings and conflicting cloud-provider flags.
4. Save and restart Claude Code yourself. Use `/status` to check the proxy root URL and `ANTHROPIC_AUTH_TOKEN`. Choose a discovered GPT model with `/model` and send a disposable prompt.

Expected: no terminal environment setup or helper command. The Claude base URL has no `/v1` suffix. Switching OpenProxy accounts changes new requests while running responses keep their original account. If settings are managed or overridden by another scope, inspect `/status` to identify the effective configuration.

Restore your backup if this was a disposable test. Routing GPT models through Claude Code remains experimental and is not officially supported by Anthropic.

## 4. ChatGPT / Codex: edit config.toml

1. Select an enabled account and start OpenProxy. Open **Getting started → ChatGPT / Codex**.
2. Open and back up the displayed user-level `config.toml`, normally `%USERPROFILE%\.codex\config.toml` or the file under `CODEX_HOME`.
3. Click **Copy config**. Replace the top-level `model_provider` key before any `[table]` header, and replace previous OpenProxy provider/auth sections with the copied provider. Avoid duplicate keys/tables and keep unrelated settings.
4. Save, fully restart Codex, and create a new local Codex chat. Choose your project/model in Codex and send a disposable prompt.

Expected: `base_url` ends in `/v1`, and `experimental_bearer_token` contains the local proxy key. There should be no `[model_providers.openproxy.auth]`, `command`, or helper script. The local key is separate from your upstream account credentials. Native login/avatar remains unchanged.

This configuration applies to compatible local Codex inference. Ordinary ChatGPT desktop/web chats are not confirmed to use it. Managed clients may restrict custom providers. HTTP SSE/full history are supported; WebSockets, stored continuation, and opaque compaction references are unsupported. Native Codex UI compatibility has not been verified automatically.

To undo, restore the backed-up configuration and restart Codex.

## 5. API calls without shell commands

1. Select an enabled account, start the proxy, and open **Getting started → API calls**.
2. Click **Copy request**. Paste/import the raw request into your local HTTP client.
3. First call `GET /v1/models` using the same Authorization header. Choose an available model and replace `REPLACE_WITH_MODEL_ID` in the POST body.
4. Send `POST /v1/responses`, then switch the active account and send another request.

Expected: copied requests include the local key and use the current port. Full history and `store=false` are used. Browser-origin calls, Chat Completions, and WebSockets are unsupported. Do not share copied keys in bug reports.

## 6. Accounts and subscription metadata

1. Keep the original account. Add the second account using **+ Add account → Choose a Codex auth.json file…** and name it separately. Each link must point at its own auth file.
2. With account A selected, start the proxy and disable A. The listener stays running; new inference pauses until you choose another enabled account.
3. Choose **Use account** on B. New prompts use B; responses already running can finish with A.
4. Enable A again. It must not automatically become selected. Flags and selection should persist after restarting OpenProxy.
5. Click **Refresh** on an enabled account. Check plan, local auth readiness, quota used/reset windows, checked time, and stale state independently.

Expected:

- No automatic fallback or rotation when quota runs out.
- Disabled accounts cannot be selected or refreshed and retain their credentials.
- Plan names reflect provider values; token-derived hints remain unverified.
- Local auth readiness does not establish live subscription status.
- Billing renewal/cancellation remains Unknown; missing data must not become zero usage or an active subscription.
- Refresh failure retains last-known data as stale. No background metadata polling or model call is made by Refresh.

## What to report

Send the app version, action, expected/actual result, Windows display scaling, and a screenshot of the affected layout. For startup issues, include the last loading stage and both measured times. Do not include auth.json, copied configurations with the local key, access/refresh tokens, or sensitive prompts/source code.

Provider settings: [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Claude file setup: [Claude Code gateway configuration](https://code.claude.com/docs/en/llm-gateway-connect).

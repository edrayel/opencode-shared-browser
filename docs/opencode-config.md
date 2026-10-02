# opencode config

Two edits to `~/.config/opencode/opencode.jsonc`.

## 1. Register the plugin

Add the guard to the `plugin` array so it loads on startup:

```jsonc
"plugin": [
  "opencode-supermemory@2.0.15",
  "/home/edrayel/.config/opencode/plugins/browser-guard.ts"
]
```

## 2. Point the Playwright MCP at the shared browser

Replace the `playwright` entry's command with the wrapper and enable it:

```jsonc
"playwright": {
  "type": "local",
  "timeout": 30000,
  "command": ["/home/edrayel/bin/playwright-mcp-chromium-safe"],
  "enabled": true,
  "_comment": "Attaches over CDP to the Chrome started by ~/bin/chrome-cdp-profile, so instances share one signed-in profile. Set PLAYWRIGHT_MCP_MODE=local to launch a browser directly instead."
}
```

The wrapper passes `--cdp-endpoint` and deliberately does **not** pass
`--executable-path`, `--isolated`, `--user-data-dir` or `--no-sandbox` — those
apply to the launching process, and in CDP mode the MCP never launches one.
`--isolated` is in any case mutually exclusive with `--user-data-dir`.

## 3. Paste the tab-discipline rules

Copy [AGENTS.fragment.md](AGENTS.fragment.md) into your global `AGENTS.md`. The
guard denies the calls either way, but the rules explain *why*, so a denial reads
as "here is the legitimate workaround" instead of an unexplained failure.

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `PLAYWRIGHT_MCP_CDP_PORT` | `9222` | all three |
| `PLAYWRIGHT_MCP_PROFILE` | `~/.config/google-chrome-for-testing` | launcher, wrapper |
| `PLAYWRIGHT_MCP_MODE` | `cdp` | wrapper (`cdp` or `local`) |
| `BROWSER_GUARD_TTL_MS` | `900000` (15 min) | guard |
| `PLAYWRIGHT_BROWSERS_PATH` | `~/.cache/ms-playwright` | launcher |

## Troubleshooting

**MCP exits with "no browser on http://127.0.0.1:9222"**
The wrapper fails loudly rather than silently launching an isolated browser.
Run `~/bin/chrome-cdp-profile`.

**Guard denies every close**
Expected while another instance is active — check `browser_tabs list`. See
"Known limitations" in the README for the cases where this is unavoidable.

**Old tabs reappear after a restart**
`pkill` sends SIGTERM, which leaves `exit_type` unset in the profile; Chrome reads
that as a crash and restores the previous session regardless of flags. Use
`~/bin/chrome-cdp-profile --stop`, which sends CDP `Browser.close`.

**Chromium fails with "No usable sandbox"**
Ubuntu 23.10+ disables unprivileged user namespaces. `--no-sandbox` is already
passed; drop it if your distro allows sandboxes.

**Second `chrome-cdp-profile` says "already listening"**
Correct — it is idempotent. It will not disturb a running browser.
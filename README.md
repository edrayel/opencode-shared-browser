# opencode-shared-browser

Let several opencode instances drive **one** Playwright browser that is already
signed in — without them trampling each other.

The problem: Playwright's MCP launches its own browser per session. Point it at a
profile holding real Google accounts and two Chromium processes immediately fight
over the profile lock — the second one aborts rather than sharing. So you have to
choose: isolated (no sign-in) or shared (sign-in, but one instance at a time).

The fix: launch Chrome **once** with a persistent profile and a CDP debugging
port, then have every opencode instance attach over CDP. Attach works from
separate processes, so N instances share N tabs on one browser with one sign-in.

The catch is that "share" means *really* share — every instance sees every tab,
and cookies / `localStorage` / IndexedDB are one bucket. [`plugins/browser-guard.ts`](plugins/browser-guard.ts)
turns the fragile parts of that into hard denials.

## What it does

| Guard | Why |
|---|---|
| `browser_close` always denied | Terminates the shared browser, killing every other instance mid-task |
| Never close the last tab | Same failure by a different route |
| `browser_tabs close` needs an explicit `index` | A bare close cannot prove intent |
| Close denied while a foreign tab exists | The MCP's tab index does **not** map onto a CDP target, so ownership of a specific tab is unverifiable |
| Tab claims expire (default 15 min) | Tabs from a finished instance must not block later ones forever |
| Blank/inert tabs ignored | The browser always keeps a seed `about:blank`; treating it as foreign would deny every close permanently |

Every decision is appended to `~/.local/share/opencode/mcp-logs/browser-guard.log`.

## Install

```bash
git clone <this-repo> ~/dev/opencode-shared-browser
cp bin/chrome-cdp-profile bin/playwright-mcp-chromium-safe ~/bin/
cp plugins/browser-guard.ts ~/.config/opencode/plugins/
chmod +x ~/bin/chrome-cdp-profile ~/bin/playwright-mcp-chromium-safe
```

Then wire it up in `~/.config/opencode/opencode.jsonc` — see
[docs/opencode-config.md](docs/opencode-config.md). Copy the tab-discipline
section of [docs/AGENTS.fragment.md](docs/AGENTS.fragment.md) into your global
`AGENTS.md` so the model knows *why* a call was denied.

Finally, start the browser **before** opencode:

```bash
~/bin/chrome-cdp-profile        # start  (idempotent)
~/bin/chrome-cdp-profile --stop # graceful stop
```

## Why CDP rather than a shared `--user-data-dir`

Chromium takes an exclusive lock on a user-data directory. A second process does
not degrade gracefully, it aborts:

```
ERROR:process_singleton_posix.cc:347] Failed to create .../SingletonLock: File exists (17)
ERROR:chrome_main_delegate.cc:520] Failed to create a ProcessSingleton ...
```

A profile per instance would dodge that lock, but each profile is a separate
sign-in — which defeats the purpose. CDP is the only arrangement that gives N
processes one browser with one session.

## Why the tab index cannot be trusted

This was measured, not assumed. With two tabs the MCP reported
`[0] pricing, [1] about` while CDP's `/json/list` returned
`[0] about, [1] pricing` — reversed. An earlier version of the guard looked an
MCP index up in the CDP array to check ownership, and therefore validated the
**wrong tab**: an unowned `about:blank` was closed while the log claimed an owned
one had been.

`browser_tabs close` accepts no target ID, so there is no way to address one
specific tab and prove it is yours. The guard's answer is to allow a close only
when every live tab is either already claimed by this session or inert — then any
tab that closes is ours by definition.

## Tests

```bash
~/bin/chrome-cdp-profile        # tests need a live browser
./test/run.sh
```

The suite drives the real plugin from separate long-lived processes rather than
spawning LLM agents — the guard's behaviour is a pure function of
`(tool, args, sessionID, live tabs)`, so the hook can be invoked directly. It
asserts both the decision *and* the resulting browser state, so a run only passes
if no tab was destroyed.

Last run: 8 passed, 0 failed — single-instance close allowed, 3-way race denied
in every instance across repeated rounds with zero tab loss, TTL expiry denying
after the window closes.

## Known limitations

- **A blank tab mid-navigation is closable.** `about:blank` is treated as inert,
  so if another instance is navigating, its tab can briefly look closable. The
  window is narrow but real.
- **Two tabs on the same URL are indistinguishable**, since ownership is tracked
  by URL. A same-site instance could have its tab closed.
- **The shared profile has real credentials.** Every attached instance can act as
  you. Use a dedicated profile rather than your daily one.
- **`--no-sandbox` is required** on Ubuntu 23.10+ where AppArmor disables
  unprivileged user namespaces. Drop it if your system allows sandboxes.

## Layout

```
bin/chrome-cdp-profile              launcher: persistent Chrome + CDP port
bin/playwright-mcp-chromium-safe    MCP wrapper: attaches over CDP (default)
plugins/browser-guard.ts            the enforcement plugin
test/race-harness.ts                one simulated instance, holds ownership
test/ttl-harness.ts                 TTL expiry behaviour
test/run.sh                         suite
docs/opencode-config.md             config snippet
docs/AGENTS.fragment.md             tab-discipline rules to paste into AGENTS.md
```
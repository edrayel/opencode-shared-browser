## Playwright browser: tab discipline

The Playwright MCP attaches to a **shared, long-lived Chrome** (see
`~/bin/chrome-cdp-profile`, driven over CDP on port 9222). That profile may be
signed into real accounts, and **every opencode instance connected to it sees the
same tabs and the same storage.**

Consequences you must design around:

- There is no private tab. `browser_tabs list` returns every tab from every
  instance.
- Cookies, `localStorage`, and IndexedDB are one shared bucket. Two instances on
  the same origin will clobber each other.
- `browser_close`, or closing the last tab, **kills the browser for every
  instance**, including ones mid-task.

### Rules

These are **enforced** by `~/.config/opencode/plugins/browser-guard.ts`, which
denies the call and throws. The notes below explain *why* so you can pick a
legitimate workaround instead of retrying blindly.

1. **Never call `browser_close`.** Always denied — it kills the shared browser
   for every instance. Release your tab with `browser_tabs action=close`.
2. **Only close tabs you opened — and only when alone.** Ownership is tracked
   per session and expires after 15 minutes (`BROWSER_GUARD_TTL_MS`), so tabs
   left by a finished instance stop blocking you. Blank/inert tabs are ignored.
   But the MCP's tab index does **not** map onto a CDP target (verified: MCP
   index 0 and CDP `/json/list` position 0 were different tabs), and
   `browser_tabs close` takes no target ID — so the guard denies every close
   while any *real* tab not owned by your session is present. If a close is
   denied for this reason, another instance is on the browser: leave your tabs
   open and let the user tidy up.
3. **Never close the last tab.** Denied, because that also terminates the
   browser. Leave one tab open.
4. **Always pass an explicit `index`** to `browser_tabs close`. The guard refuses
   a bare close because it cannot prove intent.
5. **The guard fails closed.** If it cannot reach CDP to enumerate live tabs, all
   closes are denied. Restart the browser with `~/bin/chrome-cdp-profile` rather
   than working around it.
6. **Prefer `browser_navigate` within your own tab** over opening fresh tabs.
7. **Assume any page you find already exists is another instance's.** Do not
   navigate, re-use, or repurpose tabs you did not create.
8. **Expect interference on shared origins.** If state looks wrong on a site
   another instance may also be using, suspect concurrent writes before
   assuming a bug.

### Auditing

Every allow/deny decision is appended to
`~/.local/share/opencode/mcp-logs/browser-guard.log`.
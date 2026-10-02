// Copyright 2026 Edward Rajah
// SPDX-License-Identifier: Apache-2.0
//
// Licensed under the Apache License, Version 2.0. See ./LICENSE at the repo root.
import type { Plugin } from "@opencode-ai/plugin"
import { appendFileSync, mkdirSync } from "fs"

/**
 * Hard guarantees for the shared Playwright browser.
 *
 * The MCP attaches over CDP to one long-lived Chrome holding live Google
 * sign-ins (see ~/bin/chrome-cdp-profile). Every opencode instance connected to
 * it shares the same tabs, the same cookies, and the same browser process, so a
 * careless tool call from one instance can break every other instance.
 *
 * AGENTS.md asks the model to be careful. This plugin makes it unnecessary.
 * Enforcement is fail-closed: if ownership cannot be proven, the call is denied.
 */

const CDP_PORT = process.env.PLAYWRIGHT_MCP_CDP_PORT ?? "9222"
const CDP = `http://127.0.0.1:${CDP_PORT}`

/**
 * How long a tab claim stays valid. Ownership lives only in this process, so a
 * tab opened by an instance that has since exited would otherwise look foreign
 * forever and block every close. After this long we stop trusting our own claim
 * and the tab counts as unowned again — which is the safe direction, since a
 * stale claim must never be used to justify closing someone else's tab.
 */
const OWNERSHIP_TTL_MS = Number(process.env.BROWSER_GUARD_TTL_MS ?? 15 * 60_000)

/**
 * Pages that hold no work: no navigation, no site storage, nothing another
 * instance could lose. The browser keeps one seed tab open at all times, so
 * these are ignored when deciding whether a foreign tab blocks a close.
 */
const INERT_URLS = new Set(["about:blank", "chrome://newtab/", "chrome://new-tab-page/"])

/** sessionID -> Map<url, ms epoch the claim was made>. */
const OWNED = new Map<string, Map<string, number>>()

const BROWSER_CLOSE = "playwright_browser_close"
const BROWSER_TABS = "playwright_browser_tabs"
const NAVIGATE_TOOLS = new Set([
  "playwright_browser_navigate",
  "playwright_browser_tabs",
])

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}`
  console.error(`[browser-guard] ${line}`)
  // Append to the MCP log directory so denials are auditable after the fact.
  try {
    mkdirSync(`${process.env.HOME}/.local/share/opencode/mcp-logs`, { recursive: true })
    appendFileSync(`${process.env.HOME}/.local/share/opencode/mcp-logs/browser-guard.log`, `${line}\n`)
  } catch {
    /* auditing must never break enforcement */
  }
}

function owned(sessionID: string): Map<string, number> {
  let m = OWNED.get(sessionID)
  if (!m) {
    m = new Map<string, number>()
    OWNED.set(sessionID, m)
  }
  return m
}

/** Claim a tab for this session, refreshing the TTL. */
function claim(sessionID: string, url: string) {
  owned(sessionID).set(url, Date.now())
}

/** Drop claims older than the TTL so finished instances stop blocking closes. */
function pruneExpired(sessionID: string) {
  const m = OWNED.get(sessionID)
  if (!m) return
  const cutoff = Date.now() - OWNERSHIP_TTL_MS
  for (const [url, ts] of m) if (ts < cutoff) m.delete(url)
}

/** URLs this session still legitimately owns, after TTL pruning. */
function liveOwned(sessionID: string): Set<string> {
  pruneExpired(sessionID)
  return new Set(owned(sessionID).keys())
}

/** Live page targets from CDP, in the same order the MCP enumerates tabs. */
async function liveTabs(): Promise<string[] | null> {
  try {
    const res = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const targets = (await res.json()) as Array<{ type: string; url: string }>
    return targets.filter((t) => t.type === "page").map((t) => t.url)
  } catch {
    return null
  }
}

export const BrowserGuard: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const { tool, sessionID } = input
      const args = (output.args ?? {}) as Record<string, any>

      // ── Rule 1: never tear down the shared browser ──────────────────────────
      if (tool === BROWSER_CLOSE) {
        log(`DENY ${BROWSER_CLOSE} session=${sessionID}`)
        throw new Error(
          "BLOCKED by browser-guard: browser_close would terminate the shared Chrome " +
            "that every other opencode instance is using, killing their in-flight work. " +
            "Release your tab instead with browser_tabs action=close.",
        )
      }

      if (tool !== BROWSER_TABS) return

      const action = String(args.action ?? "list")

      // ── Rule 2: record tabs we open, so we can prove ownership later ─────────
      if (action === "new") {
        const url = String(args.url ?? "")
        if (url) {
          claim(sessionID, url)
          log(`OWN ${url} session=${sessionID}`)
        }
        return
      }

      if (action !== "close") return

      const tabs = await liveTabs()
      if (!tabs) {
        log(`DENY close (cannot reach CDP on ${CDP}) session=${sessionID}`)
        throw new Error(
          `BLOCKED by browser-guard: cannot read live tabs from ${CDP}, so tab ownership ` +
            "cannot be verified. Start Chrome with ~/bin/chrome-cdp-profile, or verify manually " +
            "with browser_tabs list.",
        )
      }

      // ── Rule 3: refuse to close while another instance's tabs are present ────
      //
      // The MCP's tab index and CDP's /json/list order are NOT the same: with
      // tabs [pricing, about] the MCP reports index 0 = pricing while CDP lists
      // about first. Looking up an MCP index in the CDP array therefore validates
      // the wrong tab — observed letting an unowned about:blank tab close while the
      // guard believed it was closing an owned one.
      //
      // browser_tabs close accepts no target ID, so there is no way to address one
      // specific tab and prove it is ours. We therefore deny closes whenever a
      // foreign tab exists at all: without trustworthy ordering we cannot rule out
      // hitting it. Closing is permitted only when every live tab is either ours or
      // inert, in which case any tab closed is safe by definition.
      //
      // Inert pages (about:blank, the new-tab page) are excluded because they hold
      // no navigation and no site state. The browser always keeps one seed tab, and
      // it is never claimed by any session, so treating it as foreign would deny
      // every close forever and make the guard unusable.
      const ours = liveOwned(sessionID)
      const foreign = tabs.filter((u) => !ours.has(u) && !INERT_URLS.has(u))

      if (foreign.length > 0) {
        log(`DENY close: ${foreign.length} foreign tab(s) present session=${sessionID}`)
        throw new Error(
          `BLOCKED by browser-guard: ${foreign.length} tab(s) here are not owned by this ` +
            `session (${foreign.join(", ")}), so they belong to another opencode instance. ` +
            "The MCP's tab index does not map reliably onto a CDP target, so a close could " +
            "destroy another instance's work. Close tabs only when you are the sole instance " +
            "using this browser; otherwise leave your tabs open for the user to tidy.",
        )
      }

      const index = typeof args.index === "number" ? args.index : undefined
      if (index === undefined) {
        log(`DENY close with no index (tabs=${tabs.length}) session=${sessionID}`)
        throw new Error(
          "BLOCKED by browser-guard: browser_tabs close requires an explicit index. " +
            "Run browser_tabs list first and close only a tab you opened.",
        )
      }

      // Guard against closing the final tab, which kills the shared browser.
      if (index >= tabs.length - 1) {
        log(`DENY close of last tab (index=${index} of ${tabs.length}) session=${sessionID}`)
        throw new Error(
          `BLOCKED by browser-guard: index ${index} is the last open tab (${tabs.length} total). ` +
            "Closing it terminates the shared browser for all opencode instances. " +
            "Leave one tab open.",
        )
      }

      // Every live tab is ours, so whichever one the index resolves to is ours.
      log(`ALLOW close index=${index} of ${tabs.length} session=${sessionID}`)
    },

    "tool.execute.after": async (input, output) => {
      // Navigating inside our own tab re-parents that URL to this session, so the
      // ownership map keeps up with the tab as it moves across sites.
      if (!NAVIGATE_TOOLS.has(input.tool)) return
      const text = String(output?.output ?? "")
      const url = /https?:\/\/[^\s"'<>)\]]+/.exec(text)?.[0]
      if (url) claim(input.sessionID, url)
    },
  }
}
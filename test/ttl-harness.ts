// Copyright 2026 Edward Rajah
// SPDX-License-Identifier: Apache-2.0
//
// TTL expiry test for plugins/browser-guard.ts.
//
// A tab claim must stop counting as "ours" once it ages past
// BROWSER_GUARD_TTL_MS. Before expiry a close of the instance's own tabs is
// allowed; after expiry the identical close must be denied, because those tabs
// have become unowned.
//
// The denial is the point: expiry is deliberately conservative. A stale claim
// must never be the justification for closing a tab, so it is treated as
// foreign rather than trusted.
//
//   BROWSER_GUARD_TTL_MS=2000 bun test/ttl-harness.ts <sessionID> <url>

import { dirname, resolve } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, "../plugins/browser-guard.ts")

const [sessionID, url] = process.argv.slice(2)
if (!sessionID || !url) {
  console.error("usage: BROWSER_GUARD_TTL_MS=2000 bun ttl-harness.ts <sessionID> <url>")
  process.exit(2)
}

const PORT = process.env.PLAYWRIGHT_MCP_CDP_PORT ?? "9222"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function createTab(target: string) {
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${PORT}/json/version`)
  ).json()
  const s = new WebSocket(webSocketDebuggerUrl)
  await new Promise((r) => s.addEventListener("open", r))
  s.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url: target } }))
  await sleep(500)
  s.close()
}

const { BrowserGuard } = await import(PLUGIN)
const hooks: any = await (BrowserGuard as any)({} as any)
const call = (tool: string, args: any) =>
  hooks["tool.execute.before"]({ tool, sessionID, callID: "c" }, { args })

const tabs = async () => {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return t.filter((x: any) => x.type === "page").map((x: any) => x.url)
}

// Two claimed tabs, so neither close attempt targets the last tab.
for (const target of [url, "http://127.0.0.1:8000/industries.html"]) {
  await createTab(target)
  await call("playwright_browser_tabs", { action: "new", url: target })
}

const attempt = async (label: string) => {
  const t = await tabs()
  try {
    await call("playwright_browser_tabs", { action: "close", index: Math.max(0, t.length - 2) })
    console.log(`${label} ALLOWED  (claim still inside TTL)`)
    return true
  } catch (e: any) {
    console.log(`${label} DENIED   ${String(e?.message ?? e).split("\n")[0].slice(0, 78)}`)
    return false
  }
}

const ttl = Number(process.env.BROWSER_GUARD_TTL_MS ?? "2000")
console.log(`BROWSER_GUARD_TTL_MS=${ttl}`)
await attempt(`t=0ms`.padEnd(14))
await sleep(ttl + 800)
await attempt(`t=${ttl + 800}ms`.padEnd(14))
process.exit(0)
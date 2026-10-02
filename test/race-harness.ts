// Copyright 2026 Edward Rajah
// SPDX-License-Identifier: Apache-2.0
//
// Concurrency test for plugins/browser-guard.ts.
//
// Loads the REAL plugin with bun and drives its tool.execute.before hook,
// standing in for one opencode instance. Each instance is a separate
// long-lived process with its own OWNED map, which is exactly the concurrency
// condition the guard exists to handle.
//
// This is deliberately NOT an LLM agent test: the guard's behaviour is a pure
// function of (tool, args, sessionID, live tabs), so invoking the hook directly
// exercises the shipped code exactly while costing nothing.
//
//   bun test/race-harness.ts <sessionID> <url>
//
// Lifecycle: create a real tab -> claim it -> signal .opened -> wait for the
// shared GO barrier -> attempt a close. With a sibling instance holding its own
// tab, the close MUST be denied, and every tab must survive.

import { mkdirSync, writeFileSync, existsSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, "../plugins/browser-guard.ts")
const SYNC = process.env.GUARD_TEST_SYNC ?? `${process.env.HOME}/tmp/race`

const [sessionID, url] = process.argv.slice(2)
if (!sessionID || !url) {
  console.error("usage: bun race-harness.ts <sessionID> <url>")
  process.exit(2)
}

mkdirSync(SYNC, { recursive: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Open a real tab so liveTabs() reflects genuine browser state. */
async function createTab(target: string) {
  const port = process.env.PLAYWRIGHT_MCP_CDP_PORT ?? "9222"
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
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

const live = async () => {
  const port = process.env.PLAYWRIGHT_MCP_CDP_PORT ?? "9222"
  const t = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  return t.filter((x: any) => x.type === "page").map((x: any) => x.url)
}

// 1. Open a real tab and claim it.
await createTab(url)
await call("playwright_browser_tabs", { action: "new", url })
writeFileSync(`${SYNC}/${sessionID}.opened`, String(Date.now()))
console.log(`[${sessionID}] opened+claimed ${url}`)

// 2. Wait for the orchestrator to release every instance at once.
for (let i = 0; i < 400 && !existsSync(`${SYNC}/GO`); i++) await sleep(50)
await sleep(150)

console.log(`[${sessionID}] sees: ${JSON.stringify((await live()).map((u: string) => u.slice(0, 40)))}`)

// 3. Race to close. Never target the last tab — that is a separate rule.
const tabs = await live()
const index = Math.max(0, tabs.length - 2)
try {
  await call("playwright_browser_tabs", { action: "close", index })
  console.log(`[${sessionID}] RESULT=ALLOWED index=${index}`)
} catch (e: any) {
  console.log(`[${sessionID}] RESULT=DENIED ${String(e?.message ?? e).split("\n")[0].slice(0, 110)}`)
}

writeFileSync(`${SYNC}/${sessionID}.done`, String(Date.now()))
process.exit(0)
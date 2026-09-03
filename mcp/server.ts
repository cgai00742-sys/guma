/**
 * guma-mcp — Guma, as a tool an AI can use.
 *
 * Guma's one rule is that the AI reads the mess and the math stays
 * deterministic. The honest way to hold that line is not a sentence in a
 * prompt, it is an architecture: Guma does not call a model. A model calls
 * Guma.
 *
 * So there is no API key field in this app, no provider dropdown, no prompt
 * templates and no GPU requirement. A shop points whatever assistant it
 * already pays for at this command — Claude, Cursor, anything speaking MCP —
 * and that assistant can read the shop's rates and projects and ask Guma to
 * price a job. `guma_price_quote` runs src/lib/pricing.ts against the shop's
 * own rate card and returns the same figures the app shows. The model
 * supplies hours and grams. It cannot supply a price, because no tool takes
 * one.
 *
 * PROTOCOL
 *
 * MCP over stdio is JSON-RPC 2.0, one message per line, on stdin and stdout.
 * That is small enough to implement here in full, which is why this file has
 * no dependencies: adding the official SDK would mean regenerating a
 * lockfile, and this server would then be a supply chain rather than a file.
 *
 * NOTHING may be written to stdout except protocol messages. Every diagnostic
 * goes to stderr, where the client shows it in its logs.
 */
import { createInterface } from 'node:readline'
import Database, { configure } from './sqlite'
import { DatabaseNotFound, dbFlagFrom, resolveDbPath } from './dbPath'
import * as local from '../src/lib/data.local'
import { toolsFor, writeRefusals, type ToolDef } from '../src/lib/mcp/tools'
import { NeedsSetup, type ShopContext } from '../src/lib/data.types'

const NAME = 'guma'
const VERSION = '1.0.0'
/** Versions this server has actually been checked against. */
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST = SUPPORTED[0]!

const argv = process.argv.slice(2)
const readOnly = argv.includes('--read-only')
const mode = readOnly ? 'read' : 'write'

function log(...parts: unknown[]): void {
  process.stderr.write(`[guma-mcp] ${parts.join(' ')}\n`)
}

if (argv.includes('--help') || argv.includes('-h')) {
  process.stderr.write(
    [
      'guma-mcp — Guma as an MCP server.',
      '',
      'Usage: guma-mcp [--db <path>] [--read-only]',
      '',
      '  --db <path>   The Guma database. Defaults to the one the desktop app uses;',
      '                the GUMA_DB environment variable does the same thing.',
      '  --read-only   Publish only the tools that read. Nothing can write.',
      '',
      'This command speaks MCP on stdin/stdout and is meant to be launched by an',
      'MCP client, not run by hand. See README.md for the config block.',
      '',
      'What no tool here can do, in any mode:',
      ...writeRefusals.map((r) => `  · ${r.what} (${r.why})`),
      '',
    ].join('\n'),
  )
  process.exit(0)
}

/* ------------------------------------------------------------------ *
 * JSON-RPC plumbing
 * ------------------------------------------------------------------ */

type Id = string | number | null

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id: Id, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id: Id, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/* ------------------------------------------------------------------ *
 * The shop
 * ------------------------------------------------------------------ */

let ctx: ShopContext | null = null
let tools: ToolDef[] = []

/**
 * The context is re-read on every call rather than cached for the session.
 *
 * A shop edits a rate in the app while an assistant is mid-conversation, and
 * a cached rate card would quietly keep pricing at yesterday's number for as
 * long as the client stayed connected. Rates are the one thing that must
 * never be stale, and re-reading four small tables costs nothing.
 */
async function shopContext(): Promise<ShopContext> {
  try {
    ctx = await local.loadShopContext()
    return ctx
  } catch (e) {
    if (e instanceof NeedsSetup) {
      throw new Error(
        'This Guma database has no shop in it yet. Open the Guma app and run the setup wizard first — ' +
          'it asks for the rates every tool here depends on, and there is deliberately no way to set them from outside.',
      )
    }
    throw e
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) {
    // Two very different situations, and telling a model the wrong one sends
    // it looking for a workaround that does not exist -- or gives up on one
    // that does.
    const hiddenByMode = toolsFor('write').some((t) => t.name === name)
    if (hiddenByMode) {
      throw new Error(
        `"${name}" exists but this server was started with --read-only, so nothing here can write. ` +
          'Ask the person to restart it without that flag, or do this one in the Guma app.',
      )
    }
    const refused = writeRefusals.map((r) => r.what).join('; ')
    throw new Error(
      `No tool named "${name}". Guma deliberately has no tool to: ${refused}. ` +
        'Those are done by a person in the app, having looked at them.',
    )
  }
  return tool.handler(args ?? {}, await shopContext())
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

async function handle(msg: any): Promise<void> {
  const { id = null, method, params } = msg ?? {}

  switch (method) {
    case 'initialize': {
      const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : ''
      reply(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, version: VERSION },
        instructions:
          'Guma is a small 3D-print shop’s quoting and costing tool. Read guma_shop first: it carries the ' +
          'ids and the only rates that exist. Never compute or estimate a price yourself — call ' +
          'guma_price_quote, which runs the shop’s own pricing engine, and report its figures unrounded. ' +
          'Anything you create arrives as a draft that a person decides on; there is no tool here that ' +
          'records a payment, changes a quote’s status, alters a rate, or deletes anything.',
      })
      return
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return // notifications take no reply
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
      return
    // Advertised nowhere, but friendlier than a method-not-found for clients
    // that probe every capability on connect.
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    case 'tools/call': {
      const toolName = String(params?.name ?? '')
      try {
        const out = await callTool(toolName, params?.arguments ?? {})
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          structuredContent: out && typeof out === 'object' ? out : undefined,
        })
      } catch (e) {
        // A refusal is a RESULT, not a transport error: isError lets the
        // model read the reason and do something else, where a JSON-RPC
        // error would just look like the server broke.
        const message = e instanceof Error ? e.message : String(e)
        log(`${toolName}: ${message}`)
        reply(id, { content: [{ type: 'text', text: message }], isError: true })
      }
      return
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return
      fail(id, -32601, `Unknown method: ${method}`)
  }
}

/* ------------------------------------------------------------------ *
 * Start
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  let path: string
  try {
    path = resolveDbPath({ flag: dbFlagFrom(argv) })
  } catch (e) {
    if (e instanceof DatabaseNotFound) {
      log(e.message)
      process.exit(2)
    }
    throw e
  }

  configure(path, { readOnly })
  await Database.load('sqlite:guma.db')
  tools = toolsFor(mode)

  log(`database ${path}`)
  log(`${tools.length} tools, ${readOnly ? 'read-only' : 'read and draft/workflow writes'}`)
  log('never: ' + writeRefusals.map((r) => r.what).join('; '))

  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    const text = line.trim()
    if (!text) continue
    let msg: unknown
    try {
      msg = JSON.parse(text)
    } catch {
      fail(null, -32700, 'Parse error')
      continue
    }
    try {
      await handle(msg)
    } catch (e) {
      const id = (msg as any)?.id ?? null
      fail(id, -32603, e instanceof Error ? e.message : String(e))
    }
  }
}

main().catch((e) => {
  log(e instanceof Error ? (e.stack ?? e.message) : String(e))
  process.exit(1)
})

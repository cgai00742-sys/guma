/**
 * Builds `guma-mcp` into one file with no dependencies.
 *
 * The point of the alias below is that the MCP server runs
 * `src/lib/data.local.ts` UNCHANGED — the same queries, validation and
 * derived views the desktop app runs — by swapping the Tauri SQL plugin for
 * a node:sqlite connection at build time. There is no second data layer for
 * an AI to be wrong in.
 *
 * Bundled rather than run through Node's TypeScript stripping on purpose:
 * stripping is on by default in Node 22.18+ and behind a flag before that,
 * so a shop on 22.6 would get a syntax error out of an MCP client that shows
 * it nothing. A plain .mjs runs on every Node 22 there is.
 *
 *   npm run mcp:build   ->   mcp/dist/guma-mcp.mjs
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  // No public/ copy. This is a Node command, not a web app: without this
  // vite drops the brand SVGs, the fonts and Cloudflare's _headers file
  // next to the server bundle, which is confusing at best and, on a machine
  // where those files are read-only, fails the build outright.
  publicDir: false,
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'mcp/dist',
    // Left alone rather than wiped: macOS drops .DS_Store into any folder
    // it has been looked at in, and a build that fails because it cannot
    // delete one is a build that fails for no reason.
    emptyOutDir: false,
    minify: false, // it is a file a shop may want to read before running
    rollupOptions: {
      input: here('./mcp/server.ts'),
      output: { entryFileNames: 'guma-mcp.mjs', format: 'esm', banner: '#!/usr/bin/env node' },
      // node: builtins stay external; everything else is bundled in.
      external: [/^node:/],
    },
  },
  resolve: {
    alias: [{ find: '@tauri-apps/plugin-sql', replacement: here('./mcp/sqlite.ts') }],
  },
  define: {
    // data.local.ts and locale.ts both guard on these, but the guards read
    // better than a crash if a bundler ever inlines something unexpected.
    'import.meta.env.DEV': 'false',
  },
})

import { execSync } from 'node:child_process'
// vitest/config rather than vite: same defineConfig, plus the `test` key
// below. It only affects types -- `vite build` behaves identically.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * A build stamp, so "am I looking at the new code?" is answerable at a
 * glance instead of by argument.
 *
 * This exists because it was not obvious. Source changes landed, tests
 * passed, and the running app showed none of it -- because a built desktop
 * app serves the dist/ folder frozen at whatever moment it was built, and a
 * dev server serves the source. Both look identical once they are a window
 * on a screen. The stamp is read at config time (so it costs nothing at
 * runtime) and shown in the top bar; if it does not match the commit you
 * expect, you are looking at an old build and no amount of editing source
 * will change it.
 */
function stamp() {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      return ''
    }
  }
  const commit = run('git rev-parse --short HEAD') || 'nogit'
  const dirty = run('git status --porcelain') ? '+' : ''
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
  return `${commit}${dirty} · ${when}`
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    /**
     * The test suite runs in Chatham, not in Greenwich.
     *
     * Guma counts in whole local calendar days -- days overdue, days since
     * anything happened, the date a payment lands on. A suite that runs in
     * UTC cannot tell a correct implementation from one that only looks
     * correct because local and UTC agree, and this project has now shipped
     * that bug twice: once in the app (dates written with toISOString) and
     * once in a test fixture built from Date.UTC, which passed here and
     * failed on the author's own machine in Hawaii.
     *
     * Pacific/Chatham is the meanest realistic choice on earth: UTC+12:45,
     * so it is a quarter-hour offset, it is across the date line, and it
     * observes daylight saving. Anything that survives it survives Berlin.
     * Run `npm run test:tz` to sweep six zones from UTC-10 to UTC+14.
     */
    env: { TZ: 'Pacific/Chatham' },
  },
  define: {
    __BUILD_STAMP__: JSON.stringify(stamp()),
    // Dev server vs. a bundled app is exactly the distinction that was
    // impossible to see from the window.
    __BUILD_MODE__: JSON.stringify(process.env.NODE_ENV === 'production' ? 'built' : 'dev'),
  },
})

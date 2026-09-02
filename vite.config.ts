import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
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
  define: {
    __BUILD_STAMP__: JSON.stringify(stamp()),
    // Dev server vs. a bundled app is exactly the distinction that was
    // impossible to see from the window.
    __BUILD_MODE__: JSON.stringify(process.env.NODE_ENV === 'production' ? 'built' : 'dev'),
  },
})

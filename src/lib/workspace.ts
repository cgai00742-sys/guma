/**
 * Which database this install is looking at.
 *
 * Guma's data lives in `guma.db`, in the Tauri app-data directory for
 * house.guma.app -- NOT in the repo and NOT in the build output. Rebuilding
 * or reinstalling the app therefore cannot touch it, and migrations are
 * additive and version-tracked, so an update keeps everything.
 *
 * That is exactly the problem this file solves. Because the data survives,
 * there is no way to see what a NEW shop sees -- the empty state, the setup
 * wizard, the welcome -- without destroying your own. A demo workspace is a
 * second database file beside the real one. Switching to it shows a first
 * run; switching back finds everything where it was.
 *
 * Two rules hold this together, and both are enforced in code rather than
 * by being careful:
 *
 *   1. The real workspace can never be wiped. resetWorkspace() refuses
 *      unless the demo is active. One mistake there costs a shop its
 *      history, so it is not a thing to get right by hand.
 *   2. A switch reloads the window. data.local caches its connection, so a
 *      switch without a reload would leave the app writing to one database
 *      while believing it was in the other.
 */

export type Workspace = 'shop' | 'demo'

const KEY = 'guma.workspace'

const FILES: Record<Workspace, string> = {
  shop: 'guma.db',
  // Beside the real one, never instead of it.
  demo: 'guma-demo.db',
}

/**
 * localStorage is per-install here (a Tauri webview), so this is a sound
 * place for it -- but it can still throw in odd states, and a workspace
 * that cannot be read must fall back to the REAL one. Defaulting to the
 * demo would hide a shop's data behind a blank screen.
 */
export function activeWorkspace(): Workspace {
  try {
    return localStorage.getItem(KEY) === 'demo' ? 'demo' : 'shop'
  } catch {
    return 'shop'
  }
}

/** The SQLite file for the active workspace, as tauri-plugin-sql wants it. */
export function activeDbUrl(): string {
  return `sqlite:${FILES[activeWorkspace()]}`
}

export function isDemo(): boolean {
  return activeWorkspace() === 'demo'
}

/**
 * Switch, then reload. The reload is not a convenience -- see rule 2 above.
 * Returns false if the choice could not be stored, so a caller can say so
 * rather than reloading into the same place and looking broken.
 */
export function switchWorkspace(next: Workspace, reload: () => void = () => location.reload()): boolean {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    return false
  }
  reload()
  return true
}

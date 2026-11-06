/**
 * The New project form, kept while you step away (CG, 5 Nov: "save the
 * draft if we happen to click on a different page like updating filament").
 *
 * Kept on this computer only, in IndexedDB -- the sliced files ride along
 * and can be megabytes, past what localStorage holds. Nothing lands on the
 * Projects board: a half-typed quote is not a project. When IndexedDB is
 * missing or refuses (a test, a locked-down browser), it is kept in memory
 * for this session, which still covers "went to Materials and came back".
 * Every failure is swallowed: losing a draft must never break the form.
 */
const DB = 'guma-drafts'
const STORE = 'intake'
const memory = new Map<string, unknown>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openDb()
  if (!db) throw new Error('no indexeddb')
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    } catch (e) {
      reject(e)
    }
  })
}

export async function saveDraft<T>(key: string, value: T): Promise<void> {
  memory.set(key, value)
  try {
    await run('readwrite', (s) => s.put(value as unknown as object, key))
  } catch {
    /* memory copy stands */
  }
}

export async function loadDraft<T>(key: string): Promise<T | null> {
  try {
    const v = await run<T>('readonly', (s) => s.get(key) as IDBRequest<T>)
    if (v != null) return v
  } catch {
    /* fall through to memory */
  }
  return (memory.get(key) as T | undefined) ?? null
}

export async function clearDraft(key: string): Promise<void> {
  memory.delete(key)
  try {
    await run('readwrite', (s) => s.delete(key))
  } catch {
    /* nothing to clear */
  }
}

/** Every kept form, gone. For tests that render the form afresh each time. */
export async function forgetAllDrafts(): Promise<void> {
  memory.clear()
  try {
    await run('readwrite', (s) => s.clear())
  } catch {
    /* nothing kept */
  }
}

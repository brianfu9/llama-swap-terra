/**
 * terra fork: generated pictures and videos for the Chat tab's media tools.
 *
 * The chat history lives in localStorage, which holds about 5 MB: one
 * 2048x2048 picture as base64 would fill it. The media go into IndexedDB
 * instead, keyed by "<tool_call_id>/<n>", and the message keeps only the keys.
 */

const DB_NAME = "llama-swap-playground-media";
const STORE = "media";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("IndexedDB unavailable"));
      };
    });
  }
  return dbPromise;
}

function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = op(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB request failed"));
      })
  );
}

export function putMedia(key: string, blob: Blob): Promise<IDBValidKey> {
  return run("readwrite", (s) => s.put(blob, key));
}

export async function getMedia(key: string): Promise<Blob | undefined> {
  return (await run<Blob | undefined>("readonly", (s) => s.get(key))) ?? undefined;
}

/** Deletes every key that is not in keep. Called with the keys a chat still shows. */
export async function pruneMedia(keep: Set<string>): Promise<void> {
  const keys = (await run<IDBValidKey[]>("readonly", (s) => s.getAllKeys())) as string[];
  const stale = keys.filter((k) => !keep.has(k));
  if (stale.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    for (const k of stale) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB delete failed"));
  });
}

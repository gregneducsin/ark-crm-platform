import { personLockPool } from "@luma/db";

/**
 * Runs `fn` while holding a Postgres session-level advisory lock keyed by
 * `key` — a second concurrent call with the same key blocks until the first
 * call's `fn` finishes (successfully or not), then proceeds seeing whatever
 * state the first call left behind.
 *
 * Built for serializing the Alexis/Sophie inbound-message pipelines per person:
 * without this, a customer double-texting (two inbound SMS within the same
 * few hundred ms) could start two overlapping turns that each read the same
 * stale conversation state, each call Claude independently without seeing
 * the other's inbound message, and then race to write the conversation's
 * final state back — the second write silently clobbering slot updates
 * (selectedProduct, objectionStage, etc.) the first turn made. Serializing
 * per-person means the second text always gets processed against the
 * conversation state the first text's turn actually left behind.
 *
 * Uses a separate bounded pool for the lock's lifetime so lock holders and
 * waiters cannot starve the application queries inside fn. Each operation
 * keeps its own checked-out client,
 * since session-level advisory locks are tied to the connection that took
 * them — sharing a pooled connection across concurrent callers would let an
 * unrelated query release (or contend for) a lock it never took.
 */
export async function withPersonLock<T>(personId: string, fn: () => Promise<T>): Promise<T> {
  const client = await personLockPool.connect();
  let discardClient = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [personId]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [personId]);
    }
  } catch (err) {
    // Destroy on any failure: an unsuccessful unlock must never return a
    // session still holding a lock to the pool. Callback errors propagate.
    discardClient = true;
    throw err;
  } finally {
    client.release(discardClient);
  }
}


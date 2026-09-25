import { describe, expect, it } from "vitest";
import { pool, personLockPool } from "@luma/db";
import { withPersonLock } from "./db-lock.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database work was blocked by lock connections")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("withPersonLock pool isolation", () => {
  it("can acquire a person lock even when every application connection is checked out", async () => {
    const clients = await Promise.all(Array.from({ length: pool.options.max! }, () => pool.connect()));
    const entered = deferred();
    const operation = withPersonLock(crypto.randomUUID(), async () => {
      entered.resolve();
      const result = await pool.query("SELECT 1 AS value");
      return result.rows[0].value;
    });
    try {
      // A lock must not compete for one of the application connections.
      await within(entered.promise);
    } finally {
      clients.forEach((client) => client.release());
      await within(operation);
    }
    expect(await operation).toBe(1);
  });

  it("leaves database work available when every lock connection is holding a lock", async () => {
    const allEntered = deferred();
    const release = deferred();
    let entered = 0;
    const count = personLockPool.options.max!;
    const operations = Array.from({ length: count }, () =>
      withPersonLock(crypto.randomUUID(), async () => {
        if (++entered === count) allEntered.resolve();
        await release.promise;
        return (await pool.query("SELECT 1 AS value")).rows[0].value;
      }),
    );
    try {
      await within(allEntered.promise);
      // Represents a dashboard query while all lock slots are occupied.
      expect((await within(pool.query("SELECT 42 AS value"))).rows[0].value).toBe(42);
    } finally {
      release.resolve();
    }
    expect(await within(Promise.all(operations))).toEqual(Array(count).fill(1));
  });

  it("serializes two messages for one person while another person can proceed", async () => {
    const personId = crypto.randomUUID();
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    let state = 0;
    const first = withPersonLock(personId, async () => {
      order.push("first started");
      entered.resolve();
      await release.promise;
      state = 1;
      order.push("first finished");
    });
    await within(entered.promise);
    const second = withPersonLock(personId, async () => {
      expect(state).toBe(1);
      order.push("second");
    });
    try {
      expect(await within(withPersonLock(crypto.randomUUID(), async () => "independent"))).toBe("independent");
      expect(order).toEqual(["first started"]);
    } finally {
      release.resolve();
      await within(Promise.all([first, second]));
    }
    expect(order).toEqual(["first started", "first finished", "second"]);
  });

  it("releases the lock after a callback fails so the next message can proceed", async () => {
    const personId = crypto.randomUUID();
    const error = new Error("synthetic callback failure");
    await expect(withPersonLock(personId, async () => { throw error; })).rejects.toBe(error);
    expect(await within(withPersonLock(personId, async () => "recovered"))).toBe("recovered");
  });
});


import { describe, expect, it } from "vitest";
import { db, customersTable, personLockPool } from "@luma/db";
import { sql } from "drizzle-orm";
import { recoverInterruptedScheduledJobs, withScheduledJobLock } from "./scheduled-job-recovery.service.js";

async function seed(table = "review_request_triggers", stale = true, status = "processing") {
  const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Recovery", email: `${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-01-01" }).returning();
  const age = new Date(Date.now() - (stale ? 60 * 60_000 : 0)).toISOString();
  const extra = table === "meta_lead_email_triggers" ? sql`, step` : sql``;
  const value = table === "meta_lead_email_triggers" ? sql`, 'opener'` : sql``;
  await db.execute(sql`insert into ${sql.identifier(table)} (person_id, due_at, status, updated_at ${extra}) values (${person.id}::uuid, now(), ${status}, ${age}::timestamptz ${value})`);
  return person.id;
}
async function status(person: string, table = "review_request_triggers") {
  return (await db.execute(sql`select status from ${sql.identifier(table)} where person_id = ${person}::uuid`)).rows[0].status;
}

describe("interrupted scheduled jobs", () => {
  it("reconciles a confirmed review-request text without resending", async () => {
    const person = await seed();
    const message = crypto.randomUUID();
    await db.execute(sql`insert into support_conversations (person_id) values (${person}::uuid)`);
    await db.execute(sql`insert into support_conversation_messages (conversation_id, direction, body, provider_message_id, delivery_status) select id, 'outbound', 'Synthetic review request', ${message}, 'delivered' from support_conversations where person_id = ${person}::uuid`);
    await db.execute(sql`update review_request_triggers set provider_message_id = ${message} where person_id = ${person}::uuid`);
    await recoverInterruptedScheduledJobs();
    expect(await status(person)).toBe("sent");
    const row = (await db.execute(sql`select review_requested, needs_attention from support_conversations where person_id = ${person}::uuid`)).rows[0];
    expect(row.review_requested).toBe(true);
    expect(row.needs_attention).toBe(false);
  });

  it("recovers an interrupted abandoned-cart email", async () => {
    const person = await seed("meta_lead_email_triggers", false, "pending");
    const event = (await db.execute<{ id: string }>(sql`insert into questionnaire_events (person_id, questionnaire_id, status, last_event_at) values (${person}::uuid, ${crypto.randomUUID()}, 'abandoned', now()) returning id`)).rows[0];
    await db.execute(sql`insert into abandoned_cart_email_triggers (person_id, questionnaire_event_id, step, status, due_at, updated_at) values (${person}::uuid, ${event.id}::uuid, 'opener', 'processing', now(), now() - interval '1 hour')`);
    await recoverInterruptedScheduledJobs();
    expect(await status(person, "abandoned_cart_email_triggers")).toBe("cancelled");
    const c = (await db.execute(sql`select needs_attention from email_conversations where person_id = ${person}::uuid`)).rows[0];
    expect(c.needs_attention).toBe(true);
  });

  it("flags uncertain sends, preserves existing holds, and does not flag twice", async () => {
    const person = await seed();
    await db.execute(sql`insert into support_conversations (person_id, needs_attention, needs_attention_reason) values (${person}::uuid, true, 'Existing staff hold')`);
    await recoverInterruptedScheduledJobs();
    expect(await status(person)).toBe("cancelled");
    const get = async () => (await db.execute(sql`select needs_attention, needs_attention_reason from support_conversations where person_id = ${person}::uuid`)).rows[0];
    const first = await get();
    expect(first.needs_attention).toBe(true);
    expect(first.needs_attention_reason).toContain("Existing staff hold");
    expect(first.needs_attention_reason).toContain("Interrupted review-request text");
    await recoverInterruptedScheduledJobs();
    expect(await get()).toEqual(first);
  });

  it("leaves fresh processing and pending jobs alone", async () => {
    const fresh = await seed("review_request_triggers", false);
    const pending = await seed("review_request_triggers", true, "pending");
    await recoverInterruptedScheduledJobs();
    expect(await status(fresh)).toBe("processing");
    expect(await status(pending)).toBe("pending");
  });

  it("respects a different database session's worker lock", async () => {
    const person = await seed();
    const client = await personLockPool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1)::bigint)", ["scheduled-job:review_request_sms"]);
      await recoverInterruptedScheduledJobs();
      expect(await status(person)).toBe("processing");
    } finally {
      await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", ["scheduled-job:review_request_sms"]);
      client.release();
    }
    await recoverInterruptedScheduledJobs();
    expect(await status(person)).toBe("cancelled");
  });

  it("skips an active local worker and releases its lock after errors", async () => {
    await expect(withScheduledJobLock("meta_lead_email", async () => {
      expect(await withScheduledJobLock("meta_lead_email", async () => "duplicate")).toBeUndefined();
      throw new Error("synthetic interruption");
    })).rejects.toThrow("synthetic interruption");
    expect(await withScheduledJobLock("meta_lead_email", async () => "available")).toBe("available");
  });

  it.each(["sent", "queued"])("uses only confirmed email evidence (%s)", async delivery => {
    const person = await seed("meta_lead_email_triggers");
    const message = crypto.randomUUID();
    await db.execute(sql`insert into email_conversations (person_id) values (${person}::uuid)`);
    await db.execute(sql`insert into email_conversation_messages (conversation_id, direction, subject, body, message_id, delivery_status) select id, 'outbound', 'Synthetic test', 'Synthetic test', ${message}, ${delivery} from email_conversations where person_id = ${person}::uuid`);
    await db.execute(sql`update meta_lead_email_triggers set message_id = ${message} where person_id = ${person}::uuid`);
    await recoverInterruptedScheduledJobs();
    expect(await status(person, "meta_lead_email_triggers")).toBe(delivery === "sent" ? "sent" : "cancelled");
    const c = (await db.execute(sql`select promo_offered, needs_attention from email_conversations where person_id = ${person}::uuid`)).rows[0];
    expect(c.promo_offered).toBe(delivery === "sent");
    expect(c.needs_attention).toBe(delivery !== "sent");
  });
});

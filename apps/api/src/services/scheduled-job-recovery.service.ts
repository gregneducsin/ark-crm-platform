import { db, personLockPool } from "@luma/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import type { PoolClient } from "pg";

const JOBS = {
  abandoned_cart_email: { table: "abandoned_cart_email_triggers", conversation: "email_conversations", messages: "email_conversation_messages", identifier: "message_id", label: "abandoned-cart email" },
  meta_lead_email: { table: "meta_lead_email_triggers", conversation: "email_conversations", messages: "email_conversation_messages", identifier: "message_id", label: "lead email" },
  review_request_sms: { table: "review_request_triggers", conversation: "support_conversations", messages: "support_conversation_messages", identifier: "provider_message_id", label: "review-request text" },
} as const;
export type RecoverableJobKind = keyof typeof JOBS;
const running = new Set<RecoverableJobKind>();

/** The worker and recovery share a nonblocking session lock. A live worker keeps
 * its claim even when a provider is slow; a crashed process releases the lock.
 * Separate lock pool avoids starving callback database queries. */
export async function withScheduledJobLock<T>(kind: RecoverableJobKind, fn: () => Promise<T>): Promise<T | undefined> {
  if (running.has(kind)) return undefined;
  running.add(kind);
  let client: PoolClient | undefined;
  let discard = false;
  try {
    client = await personLockPool.connect();
    const lock = await client.query<{ acquired: boolean }>("select pg_try_advisory_lock(hashtext($1)::bigint) as acquired", [`scheduled-job:${kind}`]);
    if (!lock.rows[0]?.acquired) return undefined;
    try { return await fn(); }
    finally { await client.query("select pg_advisory_unlock(hashtext($1)::bigint)", [`scheduled-job:${kind}`]); }
  } catch (err) {
    discard = true;
    throw err;
  } finally {
    client?.release(discard);
    running.delete(kind);
  }
}

/** No transport calls here. A persisted matching confirmed send is reconciled;
 * absence of evidence is never treated as proof that a send did not occur. */
export async function recoverInterruptedScheduledJobs(now = new Date()): Promise<{ reconciled: number; review: number }> {
  const total = { reconciled: 0, review: 0 };
  for (const kind of Object.keys(JOBS) as RecoverableJobKind[]) {
    const config = JOBS[kind];
    const result = await withScheduledJobLock(kind, () => db.transaction(async tx => {
      const counts = { reconciled: 0, review: 0 };
      const table = sql.identifier(config.table);
      const conversation = sql.identifier(config.conversation);
      const messages = sql.identifier(config.messages);
      const identifier = sql.identifier(config.identifier);
      const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
      const candidates = await tx.execute<{ id: string; person_id: string; send_id: string | null }>(sql`
        select id, person_id, ${identifier} as send_id from ${table}
        where status = 'processing' and updated_at < ${cutoff}::timestamptz
        order by updated_at, id limit 100 for update`);
      for (const job of candidates.rows) {
        const evidence = job.send_id ? await tx.execute<{ sent_at: Date }>(sql`
          select coalesce(m.sent_at, m.created_at) as sent_at from ${messages} m
          join ${conversation} c on c.id = m.conversation_id
          where c.person_id = ${job.person_id}::uuid and m.direction = 'outbound'
            and m.${identifier} = ${job.send_id} and m.delivery_status in ('sent', 'delivered', 'read')
          limit 1`) : null;
        const sent = evidence?.rows[0];
        if (sent) {
          await tx.execute(sql`update ${table} set status = 'sent', sent_at = ${new Date(sent.sent_at).toISOString()}::timestamptz,
            updated_at = now() where id = ${job.id}::uuid and status = 'processing'`);
          counts.reconciled++;
          if (kind === "review_request_sms") {
            await tx.execute(sql`update ${conversation} set review_requested = true where person_id = ${job.person_id}::uuid`);
          } else {
            await tx.execute(sql`update ${conversation} set promo_offered = true where person_id = ${job.person_id}::uuid
              and exists (select 1 from ${table} where id = ${job.id}::uuid and step = 'opener')`);
          }
          continue;
        }
        // Cancelled is outside every automatic retry selector, including the
        // review-request worker's failed-attempt retry path.
        await tx.execute(sql`update ${table} set status = 'cancelled', cancelled_reason = 'interrupted_send_staff_review',
          failure_reason = 'INTERRUPTED_SEND_UNCERTAIN', updated_at = now()
          where id = ${job.id}::uuid and status = 'processing'`);
        const reason = `Interrupted ${config.label}: delivery could not be confirmed. Check provider history before manually following up; automatic resend was stopped to avoid duplicates.`;
        await tx.execute(sql`insert into ${conversation} (person_id, needs_attention, needs_attention_reason)
          values (${job.person_id}::uuid, true, ${reason})
          on conflict (person_id) do update set needs_attention = true,
            needs_attention_reason = case
              when ${conversation}.needs_attention_reason is null or not ${conversation}.needs_attention then ${reason}
              when position(${reason} in ${conversation}.needs_attention_reason) > 0 then ${conversation}.needs_attention_reason
              else ${conversation}.needs_attention_reason || E'\n' || ${reason} end,
            updated_at = now()`);
        counts.review++;
      }
      return counts;
    }));
    total.reconciled += result?.reconciled ?? 0;
    total.review += result?.review ?? 0;
  }
  if (total.reconciled || total.review) logger.info(total, "Interrupted scheduled jobs recovered");
  return total;
}

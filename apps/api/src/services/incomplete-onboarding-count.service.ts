import { sql } from "drizzle-orm";
import { db } from "@luma/db";
import type { CustomersSummaryQuery } from "@luma/shared";

/** Current unresolved texters, grouped by sender thread, not message count. */
export async function getIncompleteOnboardingCount(query: CustomersSummaryQuery) {
  const explicit = Boolean(query.dateFrom || query.dateTo);
  const dateFrom = explicit || query.period === "all" ? query.dateFrom ?? null
    : (await db.execute<{ date: string }>(sql`select (current_date - ${query.period ?? 30}::int)::text as date`)).rows[0].date;
  const { rows } = await db.execute<{ total: number; needsReview: number; held: number }>(sql`
    with texters as (
      select t.id, t.status, t.onboarding_held,
        (min(m.created_at) at time zone 'UTC')::date as first_inbound_date
      from unmatched_sms_threads t
      join unmatched_sms_messages m on m.thread_id = t.id and m.direction = 'inbound'
      where t.linked_customer_id is null
        and t.status <> 'dismissed'
        and t.ai_intent is distinct from 'spam_or_irrelevant'
        and not exists (
          select 1 from customers c
          where lower(trim(c.phone)) = lower(trim(t.from_phone))
            or (regexp_replace(t.from_phone, '[^0-9]', '', 'g') <> ''
              and regexp_replace(c.phone, '[^0-9]', '', 'g') = regexp_replace(t.from_phone, '[^0-9]', '', 'g'))
        )
      group by t.id
    )
    select count(*)::int as total,
      count(*) filter (where status = 'needs_review')::int as "needsReview",
      count(*) filter (where onboarding_held)::int as held
    from texters
    where ${dateFrom ? sql`first_inbound_date >= ${dateFrom}::date` : sql`true`}
      and ${query.dateTo ? sql`first_inbound_date <= ${query.dateTo}::date` : sql`true`}
  `);
  return {
    ...rows[0], dateFrom, dateTo: query.dateTo ?? null, period: explicit ? null : query.period ?? 30,
    dateBasis: "first recorded inbound SMS date (UTC)",
    definition: "Current unlinked SMS sender threads with inbound texts, excluding dismissed/spam threads and senders whose phone matches a saved customer. One sender thread is counted once; this is not a verified unique-person count.",
    source: "All unmatched SMS sources; DTC attribution is unavailable.",
    reviewDefinition: "needsReview and held may overlap; do not add them to total.",
    limitation: "Not a historical abandonment rate or all initial DTC texters. Existing-account verification cases may be included until linked. Saved leads are reported separately.",
  };
}

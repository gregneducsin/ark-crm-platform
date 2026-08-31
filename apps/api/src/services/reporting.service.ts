import { sql } from "drizzle-orm";
import { db } from "@luma/db";

/**
 * Lead → questionnaire → purchase funnel, optionally scoped to a date
 * range. Each stage counts distinct customers, not events — a customer who
 * abandoned and later restarted the questionnaire is still one person in
 * "started," not two.
 *
 * True cohort funnel: the range picks a COHORT of leads (whoever's own
 * leadReceivedDate falls in it), and every later stage asks "did this ever
 * happen for someone in that cohort," not "did this happen within the
 * range." Earlier versions of this query scoped each stage by whichever
 * date column that stage's own event happened on — started by when the
 * questionnaire row was created, submitted by when it was last updated,
 * purchased by purchaseDate — which meant a customer could show up in
 * "purchased" this week for a questionnaire they'd submitted three weeks
 * ago, producing e.g. 0 submitted / 10 purchased in the same window even
 * though every one of those 10 purchases traces back to a real submission.
 * Scoping every stage to the same cohort instead guarantees each stage is a
 * subset of the one above it, the way a funnel actually reads.
 *
 * This makes `purchased`/`revenue` here answer a genuinely different
 * question than the Orders tab or Marketing CPA for the same range: those
 * scope by the purchase's own purchaseDate (period cash flow — "how much
 * came in this week"), while this tile scopes by the purchasing customer's
 * leadReceivedDate (cohort conversion — "how much has this week's cohort
 * generated so far, including sales that close after the window"). The two
 * are expected to disagree; that's not a bug to reconcile.
 */
export interface FunnelSummary {
  readonly totalLeads: number;
  readonly questionnaireStarted: number;
  readonly questionnaireSubmitted: number;
  readonly purchased: number;
  readonly revenue: number;
}

export interface DateRange {
  /** Inclusive, YYYY-MM-DD. */
  readonly from: string;
  /** Inclusive, YYYY-MM-DD. */
  readonly to: string;
}

export async function getFunnelSummary(range?: DateRange): Promise<FunnelSummary> {
  const cohortWhere = range ? sql`WHERE lead_received_date BETWEEN ${range.from} AND ${range.to}` : sql``;

  const [row] = await db.execute<{
    total_leads: string;
    questionnaire_started: string;
    questionnaire_submitted: string;
    purchased: string;
    revenue: string;
  }>(sql`
    WITH cohort AS (
      SELECT id FROM customers ${cohortWhere}
    )
    SELECT
      (SELECT count(*) FROM cohort) AS total_leads,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events WHERE person_id IN (SELECT id FROM cohort)) AS questionnaire_started,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events WHERE person_id IN (SELECT id FROM cohort) AND status = 'submitted') AS questionnaire_submitted,
      (SELECT count(DISTINCT customer_id) FROM purchases WHERE customer_id IN (SELECT id FROM cohort) AND status = 'completed') AS purchased,
      (SELECT COALESCE(sum(amount_paid), 0) FROM purchases WHERE customer_id IN (SELECT id FROM cohort) AND status = 'completed') AS revenue
  `).then((r) => r.rows);

  return {
    totalLeads: Number(row.total_leads),
    questionnaireStarted: Number(row.questionnaire_started),
    questionnaireSubmitted: Number(row.questionnaire_submitted),
    purchased: Number(row.purchased),
    revenue: Number(row.revenue),
  };
}

export type MessageChannel = "sms" | "email";

export interface MessageVolumeRow {
  readonly channel: MessageChannel;
  readonly inbound: number;
  readonly outbound: number;
}

/** All-time message counts, SMS (Alexis+Sophie combined) vs email (Alexis+Sophie combined), split by direction. */
export async function getMessageVolumeByChannel(): Promise<MessageVolumeRow[]> {
  const { rows } = await db.execute<{ channel: string; direction: string; count: string }>(sql`
    SELECT 'sms' AS channel, direction, count(*) AS count FROM conversation_messages GROUP BY direction
    UNION ALL
    SELECT 'sms' AS channel, direction, count(*) AS count FROM support_conversation_messages GROUP BY direction
    UNION ALL
    SELECT 'email' AS channel, direction, count(*) AS count FROM email_conversation_messages GROUP BY direction
    UNION ALL
    SELECT 'email' AS channel, direction, count(*) AS count FROM support_email_conversation_messages GROUP BY direction
  `);

  const totals: Record<MessageChannel, { inbound: number; outbound: number }> = {
    sms: { inbound: 0, outbound: 0 },
    email: { inbound: 0, outbound: 0 },
  };
  for (const r of rows) {
    const channel = r.channel as MessageChannel;
    const direction = r.direction as "inbound" | "outbound";
    totals[channel][direction] += Number(r.count);
  }
  return (["sms", "email"] as const).map((channel) => ({ channel, ...totals[channel] }));
}

export interface ResponseTimeStats {
  readonly channel: MessageChannel;
  /** Null when there's no outbound reply directly following an inbound message yet on this channel. */
  readonly avgResponseSeconds: number | null;
  readonly responseCount: number;
}

/**
 * Average time from an inbound message to the next outbound message in the
 * same conversation, per channel (SMS = Alexis+Sophie combined, email =
 * Alexis+Sophie combined). Only counts outbound messages that directly follow
 * an inbound one (via LAG partitioned by conversation) — an outbound
 * message following another outbound message (e.g. reply + follow-up
 * question sent as two messages) isn't itself a "response," so it's
 * excluded rather than skewing the average toward near-zero gaps.
 */
async function responseTimeForTable(table: "conversation_messages" | "support_conversation_messages" | "email_conversation_messages" | "support_email_conversation_messages"): Promise<{ avgSeconds: number | null; count: number }> {
  const { rows } = await db.execute<{ avg_seconds: string | null; count: string }>(sql`
    WITH paired AS (
      SELECT
        direction,
        created_at,
        LAG(direction) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_direction,
        LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY created_at) AS prev_created_at
      FROM ${sql.raw(table)}
    )
    SELECT
      avg(extract(epoch FROM (created_at - prev_created_at))) AS avg_seconds,
      count(*) AS count
    FROM paired
    WHERE direction = 'outbound' AND prev_direction = 'inbound'
  `);
  const row = rows[0];
  return { avgSeconds: row?.avg_seconds === null || row?.avg_seconds === undefined ? null : Number(row.avg_seconds), count: Number(row?.count ?? 0) };
}

export async function getResponseTimeStats(): Promise<ResponseTimeStats[]> {
  const [alexisSms, sophieSms, alexisEmail, sophieEmail] = await Promise.all([
    responseTimeForTable("conversation_messages"),
    responseTimeForTable("support_conversation_messages"),
    responseTimeForTable("email_conversation_messages"),
    responseTimeForTable("support_email_conversation_messages"),
  ]);

  const combine = (a: { avgSeconds: number | null; count: number }, b: { avgSeconds: number | null; count: number }): { avgSeconds: number | null; count: number } => {
    const count = a.count + b.count;
    if (count === 0) return { avgSeconds: null, count: 0 };
    const weightedSum = (a.avgSeconds ?? 0) * a.count + (b.avgSeconds ?? 0) * b.count;
    return { avgSeconds: weightedSum / count, count };
  };

  const sms = combine(alexisSms, sophieSms);
  const email = combine(alexisEmail, sophieEmail);

  return [
    { channel: "sms", avgResponseSeconds: sms.avgSeconds, responseCount: sms.count },
    { channel: "email", avgResponseSeconds: email.avgSeconds, responseCount: email.count },
  ];
}

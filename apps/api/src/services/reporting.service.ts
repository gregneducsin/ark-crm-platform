import { sql } from "drizzle-orm";
import { db } from "@luma/db";

/**
 * Lead → questionnaire → purchase funnel, optionally scoped to a date
 * range. Each stage counts distinct customers, not events — a customer who
 * abandoned and later restarted the questionnaire is still one person in
 * "started", not two. Each stage is scoped by the date column that best
 * represents when that stage's event actually happened (a customer's own
 * leadReceivedDate for "leads," when a questionnaire row was created for
 * "started," when it was last updated while submitted for "submitted,"
 * the purchase's own purchaseDate for "purchased"/"revenue" — matching how
 * every other revenue figure in the app is scoped) — not a single shared
 * column, since these are four different kinds of events.
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
  // "to" is inclusive of the whole day, so the upper bound used in the
  // query is exclusive-of-the-next-day — this matters for the timestamp
  // columns (questionnaire/purchase events), where a bare "<= to" would
  // silently exclude anything that happened after midnight on that day.
  const leadsWhere = range ? sql`WHERE lead_received_date BETWEEN ${range.from} AND ${range.to}` : sql``;
  const startedWhere = range ? sql`WHERE created_at >= ${range.from} AND created_at < (${range.to}::date + 1)` : sql``;
  const submittedWhere = range
    ? sql`WHERE status = 'submitted' AND updated_at >= ${range.from} AND updated_at < (${range.to}::date + 1)`
    : sql`WHERE status = 'submitted'`;
  // purchase_date, not created_at — every other revenue/purchase figure in
  // the app (Orders tab, Marketing CPA) scopes by purchase_date, and a
  // webhook that's retried or delayed can insert a purchase row well after
  // the date it actually happened on. Scoping by created_at here made this
  // tile silently disagree with the Orders tab for the same date range.
  const purchasedWhere = range ? sql`WHERE status = 'completed' AND purchase_date BETWEEN ${range.from} AND ${range.to}` : sql`WHERE status = 'completed'`;

  const [row] = await db.execute<{
    total_leads: string;
    questionnaire_started: string;
    questionnaire_submitted: string;
    purchased: string;
    revenue: string;
  }>(sql`
    SELECT
      (SELECT count(*) FROM customers ${leadsWhere}) AS total_leads,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events ${startedWhere}) AS questionnaire_started,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events ${submittedWhere}) AS questionnaire_submitted,
      (SELECT count(DISTINCT customer_id) FROM purchases ${purchasedWhere}) AS purchased,
      (SELECT COALESCE(sum(amount_paid), 0) FROM purchases ${purchasedWhere}) AS revenue
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

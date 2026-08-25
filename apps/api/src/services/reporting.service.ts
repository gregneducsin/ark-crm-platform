import { sql } from "drizzle-orm";
import { db } from "@luma/db";

/**
 * Lead → questionnaire → purchase funnel, all-time (no date range in this
 * first pass — "basic" reporting per the request that prompted this file;
 * a date-filtered version is a natural follow-up if it's needed later).
 * Each stage counts distinct customers, not events — a customer who
 * abandoned and later restarted the questionnaire is still one person in
 * "started", not two.
 */
export interface FunnelSummary {
  readonly totalLeads: number;
  readonly questionnaireStarted: number;
  readonly questionnaireSubmitted: number;
  readonly purchased: number;
}

export async function getFunnelSummary(): Promise<FunnelSummary> {
  const [row] = await db.execute<{
    total_leads: string;
    questionnaire_started: string;
    questionnaire_submitted: string;
    purchased: string;
  }>(sql`
    SELECT
      (SELECT count(*) FROM customers) AS total_leads,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events) AS questionnaire_started,
      (SELECT count(DISTINCT person_id) FROM questionnaire_events WHERE status = 'submitted') AS questionnaire_submitted,
      (SELECT count(DISTINCT customer_id) FROM purchases WHERE status = 'completed') AS purchased
  `).then((r) => r.rows);

  return {
    totalLeads: Number(row.total_leads),
    questionnaireStarted: Number(row.questionnaire_started),
    questionnaireSubmitted: Number(row.questionnaire_submitted),
    purchased: Number(row.purchased),
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

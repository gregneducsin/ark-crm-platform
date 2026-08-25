import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  followUpJobsTable,
  abandonedCartTriggersTable,
  leadCheckinTriggersTable,
  objectionReengagementTriggersTable,
  abandonedCartEmailTriggersTable,
  metaLeadEmailTriggersTable,
  reviewRequestTriggersTable,
} from "@luma/db";

/**
 * Every automated-trigger table in the app follows the same shape —
 * personId, dueAt, and a status enum defaulting to "pending", flipped to
 * "processing" only as a transient claim right before a sweep sends it (see
 * the identical comment on followUpJobsTable.status) — so "is there
 * anything still scheduled for this person" is answerable by checking all
 * of them the same way, rather than each conversation page needing to know
 * which specific trigger tables might apply to it.
 */
const PENDING_STATUSES = ["pending", "processing"] as const;

export interface UpcomingTrigger {
  readonly kind:
    | "follow_up"
    | "abandoned_cart_sms"
    | "lead_checkin_sms"
    | "objection_reengagement_sms"
    | "abandoned_cart_email"
    | "meta_lead_email"
    | "review_request_sms";
  readonly label: string;
  readonly dueAt: Date;
  readonly status: "pending" | "processing";
}

const FOLLOW_UP_STEP_LABELS: Record<string, string> = {
  provider_check_in: "Provider check-in follow-up text",
  intake_questions_check_in: "Intake questions follow-up text",
};

const EMAIL_STEP_LABELS: Record<string, string> = {
  opener: "Opener email",
  urgency: "Urgency email",
  educational: "Educational email",
  plan_comparison: "Plan-comparison email",
};

async function nextFollowUpJob(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: followUpJobsTable.dueAt, status: followUpJobsTable.status, messageStep: followUpJobsTable.messageStep })
    .from(followUpJobsTable)
    .where(and(eq(followUpJobsTable.personId, personId), inArray(followUpJobsTable.status, PENDING_STATUSES)))
    .orderBy(asc(followUpJobsTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "follow_up", label: FOLLOW_UP_STEP_LABELS[row.messageStep] ?? "Follow-up text", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextAbandonedCartSms(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: abandonedCartTriggersTable.dueAt, status: abandonedCartTriggersTable.status })
    .from(abandonedCartTriggersTable)
    .where(and(eq(abandonedCartTriggersTable.personId, personId), inArray(abandonedCartTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(abandonedCartTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "abandoned_cart_sms", label: "Abandoned-cart opener text", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextLeadCheckinSms(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: leadCheckinTriggersTable.dueAt, status: leadCheckinTriggersTable.status })
    .from(leadCheckinTriggersTable)
    .where(and(eq(leadCheckinTriggersTable.personId, personId), inArray(leadCheckinTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(leadCheckinTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "lead_checkin_sms", label: "Lead check-in text", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextObjectionReengagementSms(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: objectionReengagementTriggersTable.dueAt, status: objectionReengagementTriggersTable.status })
    .from(objectionReengagementTriggersTable)
    .where(and(eq(objectionReengagementTriggersTable.personId, personId), inArray(objectionReengagementTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(objectionReengagementTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "objection_reengagement_sms", label: "Objection re-engagement text", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextAbandonedCartEmail(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: abandonedCartEmailTriggersTable.dueAt, status: abandonedCartEmailTriggersTable.status, step: abandonedCartEmailTriggersTable.step })
    .from(abandonedCartEmailTriggersTable)
    .where(and(eq(abandonedCartEmailTriggersTable.personId, personId), inArray(abandonedCartEmailTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(abandonedCartEmailTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "abandoned_cart_email", label: EMAIL_STEP_LABELS[row.step] ?? "Abandoned-cart email", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextMetaLeadEmail(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: metaLeadEmailTriggersTable.dueAt, status: metaLeadEmailTriggersTable.status, step: metaLeadEmailTriggersTable.step })
    .from(metaLeadEmailTriggersTable)
    .where(and(eq(metaLeadEmailTriggersTable.personId, personId), inArray(metaLeadEmailTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(metaLeadEmailTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "meta_lead_email", label: EMAIL_STEP_LABELS[row.step] ?? "Meta-lead email", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

async function nextReviewRequestSms(personId: string): Promise<UpcomingTrigger | undefined> {
  const [row] = await db
    .select({ dueAt: reviewRequestTriggersTable.dueAt, status: reviewRequestTriggersTable.status })
    .from(reviewRequestTriggersTable)
    .where(and(eq(reviewRequestTriggersTable.personId, personId), inArray(reviewRequestTriggersTable.status, PENDING_STATUSES)))
    .orderBy(asc(reviewRequestTriggersTable.dueAt))
    .limit(1);
  if (!row) return undefined;
  return { kind: "review_request_sms", label: "Review-request text", dueAt: row.dueAt, status: row.status as "pending" | "processing" };
}

/**
 * The soonest still-pending (or mid-send "processing") automated trigger
 * armed for this person, across every trigger table in the app — or null if
 * nothing is scheduled. Each table is queried independently (they don't
 * share a common parent table to UNION against) and the results compared
 * client-side; there's at most one row per table per person for most of
 * these (unique on personId), so this is a handful of small indexed lookups,
 * not a scan.
 */
const TRIGGER_TABLE_BY_KIND = {
  follow_up: followUpJobsTable,
  abandoned_cart_sms: abandonedCartTriggersTable,
  lead_checkin_sms: leadCheckinTriggersTable,
  objection_reengagement_sms: objectionReengagementTriggersTable,
  abandoned_cart_email: abandonedCartEmailTriggersTable,
  meta_lead_email: metaLeadEmailTriggersTable,
  review_request_sms: reviewRequestTriggersTable,
} as const;

/**
 * Staff-initiated cancel for whichever trigger getUpcomingTrigger surfaced —
 * the client passes back the same `kind` it was given, so this only ever
 * touches the one table that kind maps to. At most one pending/processing
 * row per person per table (see getUpcomingTrigger's docstring), so scoping
 * by personId + the same PENDING_STATUSES getUpcomingTrigger reads is
 * exactly "cancel the row that's actually still upcoming" — a stale kind
 * (the trigger already sent or was cancelled elsewhere since the banner
 * loaded) simply matches zero rows and returns false.
 */
export async function cancelUpcomingTrigger(personId: string, kind: UpcomingTrigger["kind"]): Promise<boolean> {
  const table = TRIGGER_TABLE_BY_KIND[kind];
  const [cancelled] = await db
    .update(table)
    .set({ status: "cancelled", cancelledReason: "staff_cancelled" })
    .where(and(eq(table.personId, personId), inArray(table.status, PENDING_STATUSES)))
    .returning({ id: table.id });
  return Boolean(cancelled);
}

export async function getUpcomingTrigger(personId: string): Promise<UpcomingTrigger | null> {
  const candidates = await Promise.all([
    nextFollowUpJob(personId),
    nextAbandonedCartSms(personId),
    nextLeadCheckinSms(personId),
    nextObjectionReengagementSms(personId),
    nextAbandonedCartEmail(personId),
    nextMetaLeadEmail(personId),
    nextReviewRequestSms(personId),
  ]);

  let soonest: UpcomingTrigger | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!soonest || candidate.dueAt < soonest.dueAt) soonest = candidate;
  }
  return soonest;
}

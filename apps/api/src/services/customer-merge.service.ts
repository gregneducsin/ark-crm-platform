import { and, eq, inArray, sql } from "drizzle-orm";
import { db, customersTable, customerNotesTable, purchasesTable } from "@luma/db";
import { phoneMatchKey } from "../lib/phone.js";
import { namesCompatible } from "../lib/customer-name-match.js";
import { logger } from "../lib/logger.js";

/**
 * Merging two customer records that turn out to be the same person.
 *
 * Bask can hand the same person a new ID and a different email (a typo
 * corrected, a second address), so the ID and email checks in
 * findOrCreateCustomerByExternalIdentity can leave two records for one
 * person: the original lead and a newer record that later bought. The phone
 * number is the one thing that stays the same, so two records with the same
 * phone AND a compatible name are treated as one person and combined into
 * the older record, which keeps its history, lead date and acquisition
 * source. Everything that hangs off the newer record moves across.
 *
 * Deliberately conservative, because a wrong merge is hard to undo:
 *  - the phone must belong to exactly two records (a number shared more
 *    widely is ambiguous and left alone);
 *  - the names must be compatible (a family sharing a number is not merged);
 *  - two records that have BOTH bought are never merged automatically.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class MergeRefusedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MergeRefusedError";
  }
}

export interface MergeSummary {
  readonly survivorId: string;
  readonly duplicateId: string;
  readonly survivorPersonNumber: string;
  readonly duplicatePersonNumber: string;
  readonly purchasesMoved: number;
}

type CustomerRow = typeof customersTable.$inferSelect;

const PHONE_KEY_SQL = sql`right(regexp_replace(${customersTable.phone}, '[^0-9]', '', 'g'), 10)`;

async function hasCompletedPurchase(tx: Tx, customerId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: purchasesTable.id })
    .from(purchasesTable)
    .where(and(eq(purchasesTable.customerId, customerId), eq(purchasesTable.status, "completed")))
    .limit(1);
  return Boolean(row);
}

/**
 * Folds the duplicate's conversation (if it has one) into the survivor's.
 * A survivor with no conversation of that kind simply adopts the duplicate's.
 * Otherwise the duplicate's messages move across and the state flags are
 * combined, so neither side's history or "needs attention" is lost.
 */
async function mergeConversationPair(
  tx: Tx,
  opts: {
    table: string;
    messages: string;
    flagSql: (kId: string, dId: string) => ReturnType<typeof sql>;
    ledger?: boolean;
    dedupeInboundEvent?: boolean;
  },
  survivorId: string,
  duplicateId: string,
): Promise<number> {
  const table = sql.raw(opts.table);
  const messages = sql.raw(opts.messages);

  await tx.execute(sql`update ${table} set person_id = ${survivorId}
    where person_id = ${duplicateId} and not exists (select 1 from ${table} x where x.person_id = ${survivorId})`);

  const { rows: dRows } = await tx.execute<{ id: string }>(sql`select id from ${table} where person_id = ${duplicateId}`);
  const { rows: kRows } = await tx.execute<{ id: string }>(sql`select id from ${table} where person_id = ${survivorId}`);
  const dId = dRows[0]?.id;
  const kId = kRows[0]?.id;
  if (!dId || !kId) return 0;

  const moved = opts.dedupeInboundEvent
    ? await tx.execute(sql`update ${messages} m set conversation_id = ${kId}
        where m.conversation_id = ${dId}
          and not (m.inbound_event_id is not null and exists (
            select 1 from ${messages} x where x.conversation_id = ${kId} and x.inbound_event_id = m.inbound_event_id))`)
    : await tx.execute(sql`update ${messages} set conversation_id = ${kId} where conversation_id = ${dId}`);

  if (opts.ledger) {
    // Staff "reviewed" marks follow the conversation they were made on.
    await tx.execute(sql`update missed_sms_response_reviews m set conversation_id = ${kId}
      where m.conversation_id = ${dId} and not exists (
        select 1 from missed_sms_response_reviews x where x.persona = m.persona and x.conversation_id = ${kId} and x.inbound_id = m.inbound_id)`);
    await tx.execute(sql`delete from missed_sms_response_reviews where conversation_id = ${dId}`);
  }

  await tx.execute(opts.flagSql(kId, dId));
  // Any message left behind is a duplicate of one already on the survivor's thread.
  await tx.execute(sql`delete from ${table} where id = ${dId}`);
  return Number(moved.rowCount ?? 0);
}

const salesFlags = (table: string) => (kId: string, dId: string) => {
  const t = sql.raw(table);
  return sql`update ${t} k set
    needs_attention = k.needs_attention or d.needs_attention,
    needs_attention_reason = case when k.needs_attention then k.needs_attention_reason else coalesce(d.needs_attention_reason, k.needs_attention_reason) end,
    promo_offered = k.promo_offered or d.promo_offered,
    link_provided = k.link_provided or d.link_provided,
    selected_product = coalesce(k.selected_product, d.selected_product),
    state = coalesce(k.state, d.state),
    plan_length = coalesce(k.plan_length, d.plan_length),
    objection_stage = greatest(k.objection_stage, d.objection_stage),
    status = case when k.status = 'active' or d.status = 'active' then 'active' else k.status end,
    updated_at = now()
    from ${t} d where k.id = ${kId} and d.id = ${dId}`;
};

const supportFlags = (table: string) => (kId: string, dId: string) => {
  const t = sql.raw(table);
  return sql`update ${t} k set
    needs_attention = k.needs_attention or d.needs_attention,
    needs_attention_reason = case when k.needs_attention then k.needs_attention_reason else coalesce(d.needs_attention_reason, k.needs_attention_reason) end,
    prescription_written = k.prescription_written or d.prescription_written,
    prescription_written_at = coalesce(k.prescription_written_at, d.prescription_written_at),
    order_shipped = k.order_shipped or d.order_shipped,
    order_shipped_at = coalesce(d.order_shipped_at, k.order_shipped_at),
    tracking_number = coalesce(d.tracking_number, k.tracking_number),
    review_requested = k.review_requested or d.review_requested,
    payment_failed = k.payment_failed or d.payment_failed,
    payment_failed_at = coalesce(d.payment_failed_at, k.payment_failed_at),
    status = case when k.status = 'active' or d.status = 'active' then 'active' else k.status end,
    updated_at = now()
    from ${t} d where k.id = ${kId} and d.id = ${dId}`;
};

/**
 * Merges `duplicateId` into `survivorId` inside the caller's transaction.
 * Everything the duplicate owns moves to the survivor, then the duplicate row
 * is deleted. Throws MergeRefusedError (changing nothing) when both records
 * have completed purchases.
 */
export interface MergeOptions {
  /** The email on the notice that triggered the merge — the address the person is using right now. */
  readonly preferredEmail?: string;
  /** Set when a staff member asked for the merge; recorded in the note instead of the automatic "same phone and name" reason. */
  readonly mergedBy?: string;
}

export async function mergeCustomersTx(tx: Tx, survivorId: string, duplicateId: string, options: MergeOptions = {}): Promise<MergeSummary> {
  if (survivorId === duplicateId) throw new MergeRefusedError("Cannot merge a customer into itself.");

  // Lock both rows in a stable order so two merges (or a merge and a webhook) cannot deadlock.
  const locked = await tx.select().from(customersTable).where(inArray(customersTable.id, [survivorId, duplicateId])).orderBy(customersTable.id).for("update");
  const k = locked.find((row) => row.id === survivorId);
  const d = locked.find((row) => row.id === duplicateId);
  if (!k || !d) throw new MergeRefusedError("One of the customer records no longer exists.");

  const [kBought, dBought] = await Promise.all([hasCompletedPurchase(tx, k.id), hasCompletedPurchase(tx, d.id)]);
  if (kBought && dBought) throw new MergeRefusedError("Both records have completed purchases.");

  // ── Records with no per-person uniqueness: repoint ─────────────────────────
  const purchases = await tx.execute(sql`update purchases set customer_id = ${k.id} where customer_id = ${d.id}`);
  for (const [table, column] of [
    ["external_identities", "person_id"],
    ["customer_notes", "customer_id"],
    ["failed_payment_events", "person_id"],
    ["intake_link_tokens", "person_id"],
    ["follow_up_jobs", "person_id"],
    ["webhook_events", "person_id"],
    ["unmatched_sms_threads", "linked_customer_id"],
    ["unmatched_sms_threads", "suggested_match_customer_id"],
    ["unmatched_email_threads", "linked_customer_id"],
    ["unmatched_email_threads", "suggested_match_customer_id"],
  ] as const) {
    await tx.execute(sql`update ${sql.raw(table)} set ${sql.raw(column)} = ${k.id} where ${sql.raw(column)} = ${d.id}`);
  }

  // ── Questionnaire events: one per (person, questionnaire) ──────────────────
  // Where both records saw the same questionnaire, keep the survivor's row but
  // take the more recent state, then drop the duplicate's copy (which also
  // drops the triggers that hung off it; the survivor's own continue).
  await tx.execute(sql`update questionnaire_events k set
      status = d.status,
      last_event_at = d.last_event_at,
      abandoned_at = coalesce(d.abandoned_at, k.abandoned_at),
      started_at = coalesce(k.started_at, d.started_at),
      resume_url = coalesce(d.resume_url, k.resume_url),
      updated_at = now()
    from questionnaire_events d
    where k.person_id = ${k.id} and d.person_id = ${d.id} and k.questionnaire_id = d.questionnaire_id and d.last_event_at > k.last_event_at`);
  await tx.execute(sql`delete from questionnaire_events d using questionnaire_events k
    where d.person_id = ${d.id} and k.person_id = ${k.id} and d.questionnaire_id = k.questionnaire_id`);
  await tx.execute(sql`update questionnaire_events set person_id = ${k.id} where person_id = ${d.id}`);
  await tx.execute(sql`update abandoned_cart_triggers set person_id = ${k.id} where person_id = ${d.id}`);
  await tx.execute(sql`update abandoned_cart_email_triggers set person_id = ${k.id} where person_id = ${d.id}`);

  // ── Scheduled sends that allow one per person: the survivor's own wins ─────
  for (const table of ["lead_checkin_triggers", "objection_reengagement_triggers", "review_request_triggers"]) {
    const t = sql.raw(table);
    await tx.execute(sql`delete from ${t} where person_id = ${d.id} and exists (select 1 from ${t} x where x.person_id = ${k.id})`);
    await tx.execute(sql`update ${t} set person_id = ${k.id} where person_id = ${d.id}`);
  }
  await tx.execute(sql`delete from meta_lead_email_triggers d where d.person_id = ${d.id}
    and exists (select 1 from meta_lead_email_triggers x where x.person_id = ${k.id} and x.step = d.step)`);
  await tx.execute(sql`update meta_lead_email_triggers set person_id = ${k.id} where person_id = ${d.id}`);
  await tx.execute(sql`delete from sms_reply_work d where d.person_id = ${d.id}
    and exists (select 1 from sms_reply_work x where x.person_id = ${k.id} and x.persona = d.persona)`);
  await tx.execute(sql`update sms_reply_work set person_id = ${k.id} where person_id = ${d.id}`);

  // ── Conversations: fold the duplicate's threads into the survivor's ────────
  let messagesMoved = 0;
  messagesMoved += await mergeConversationPair(tx, { table: "conversations", messages: "conversation_messages", flagSql: salesFlags("conversations"), ledger: true }, k.id, d.id);
  messagesMoved += await mergeConversationPair(tx, { table: "support_conversations", messages: "support_conversation_messages", flagSql: supportFlags("support_conversations"), ledger: true }, k.id, d.id);
  messagesMoved += await mergeConversationPair(tx, { table: "email_conversations", messages: "email_conversation_messages", flagSql: salesFlags("email_conversations"), dedupeInboundEvent: true }, k.id, d.id);
  messagesMoved += await mergeConversationPair(tx, { table: "support_email_conversations", messages: "support_email_conversation_messages", flagSql: supportFlags("support_email_conversations"), dedupeInboundEvent: true }, k.id, d.id);

  // ── The customer row itself ────────────────────────────────────────────────
  // Contact details: the record that actually bought is the one the person was
  // using, so its email and its consent flags win; otherwise the survivor's stay.
  // Contact email, in order: the record that bought; else the address on the notice
  // that triggered this merge, if it is one of the two on file; else the survivor's.
  const preferred = options.preferredEmail?.trim().toLowerCase();
  const useDuplicateContact =
    kBought !== dBought ? dBought : Boolean(preferred) && preferred === d.email.toLowerCase() && preferred !== k.email.toLowerCase();
  const useOnePurchaserFlags = kBought !== dBought;
  const flagsFrom = useOnePurchaserFlags ? (dBought ? d : k) : null;
  await tx
    .update(customersTable)
    .set({
      email: useDuplicateContact ? d.email : k.email,
      phone: k.phone ?? d.phone,
      firstName: k.firstName === "Unknown" ? d.firstName : k.firstName,
      lastName: k.lastName === "Unknown" ? d.lastName : k.lastName,
      leadType: k.leadType === "Other / Unknown" ? d.leadType : k.leadType,
      leadReceivedDate: k.leadReceivedDate <= d.leadReceivedDate ? k.leadReceivedDate : d.leadReceivedDate,
      dnd: flagsFrom ? flagsFrom.dnd : k.dnd || d.dnd,
      dndAt: flagsFrom ? flagsFrom.dndAt : k.dndAt ?? d.dndAt,
      emailDnd: flagsFrom ? flagsFrom.emailDnd : k.emailDnd || d.emailDnd,
      emailDndAt: flagsFrom ? flagsFrom.emailDndAt : k.emailDndAt ?? d.emailDndAt,
      aiPaused: k.aiPaused || d.aiPaused,
      aiPausedAt: k.aiPausedAt ?? d.aiPausedAt,
    })
    .where(eq(customersTable.id, k.id));

  await tx.insert(customerNotesTable).values({
    customerId: k.id,
    authorEmail: "system@merge",
    body:
      `Merged duplicate record ${d.personNumber} (${d.firstName} ${d.lastName}, ${d.email}, lead created ${d.createdAt.toISOString().slice(0, 10)}) into this record` +
      `${options.mergedBy ? ` by ${options.mergedBy}` : ": same phone number and name"}. Moved ${Number(purchases.rowCount ?? 0)} purchase(s) and ${messagesMoved} message(s); ` +
      `${useDuplicateContact ? `contact email set to ${d.email}, the address most recently used` : "contact email unchanged"}.`,
  });

  await tx.delete(customersTable).where(eq(customersTable.id, d.id));

  return {
    survivorId: k.id,
    duplicateId: d.id,
    survivorPersonNumber: k.personNumber,
    duplicatePersonNumber: d.personNumber,
    purchasesMoved: Number(purchases.rowCount ?? 0),
  };
}

/** The older record survives: it holds the original lead date, history and acquisition source. */
function pickSurvivor(a: CustomerRow, b: CustomerRow): { survivor: CustomerRow; duplicate: CustomerRow } {
  const aFirst = a.createdAt.getTime() < b.createdAt.getTime() || (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id);
  return aFirst ? { survivor: a, duplicate: b } : { survivor: b, duplicate: a };
}

export interface ReconcileOutcome {
  /** The record the caller should carry on with: the survivor if a merge happened, else the customer's own id. */
  readonly customerId: string;
  readonly merged: MergeSummary | null;
}

/**
 * If this customer's phone number belongs to exactly one OTHER record, and
 * the two look like the same person, merges them and reports the surviving
 * record. Otherwise changes nothing and returns the customer's own id.
 *
 * Runs on every Bask/Meta notice for the person it resolved, so a duplicate
 * created before a phone number was known is caught as soon as the number
 * shows up on either record.
 */
export async function reconcileDuplicateByPhoneDetailed(tx: Tx, customerId: string, options: MergeOptions = {}): Promise<ReconcileOutcome> {
  const unchanged: ReconcileOutcome = { customerId, merged: null };
  const [self] = await tx.select().from(customersTable).where(eq(customersTable.id, customerId));
  if (!self?.phone) return unchanged;
  const key = phoneMatchKey(self.phone);
  if (key.length !== 10) return unchanged;

  const others = await tx
    .select()
    .from(customersTable)
    .where(and(sql`${PHONE_KEY_SQL} = ${key}`, sql`${customersTable.id} <> ${customerId}`));
  // Only records that could be the same person count. A third record on the
  // number under a different name (a relative, a test entry) must not stop two
  // matching records from being merged — but several matching ones is a guess.
  const matching = others.filter((row) => namesCompatible(self, row));
  if (matching.length !== 1) {
    if (others.length > 0) logger.warn({ customerId, sharing: others.length, matching: matching.length }, "records share a phone number but there is not exactly one matching person — not merging automatically");
    return unchanged;
  }
  const other = matching[0];

  const { survivor, duplicate } = pickSurvivor(self, other);
  try {
    // A savepoint, so a refused merge leaves the caller's transaction usable.
    const summary = await tx.transaction(async (inner) => mergeCustomersTx(inner as unknown as Tx, survivor.id, duplicate.id, options));
    logger.info({ survivor: summary.survivorPersonNumber, duplicate: summary.duplicatePersonNumber }, "merged duplicate customer records sharing a phone number");
    return { customerId: survivor.id, merged: summary };
  } catch (err) {
    if (err instanceof MergeRefusedError) {
      logger.warn({ survivor: survivor.personNumber, duplicate: duplicate.personNumber, reason: err.message }, "duplicate customer records not merged");
      return unchanged;
    }
    throw err;
  }
}

/** Convenience wrapper: just the id to carry on with. */
export async function reconcileDuplicateByPhone(tx: Tx, customerId: string, options: MergeOptions = {}): Promise<string> {
  return (await reconcileDuplicateByPhoneDetailed(tx, customerId, options)).customerId;
}

export interface DuplicateSweepResult {
  readonly merged: readonly MergeSummary[];
  /** Plausible pairs that were tried but not merged (for example both had bought). */
  readonly skipped: number;
  /** Every pair of records sharing a phone number, before the name check. */
  readonly pairsExamined: number;
  /** Pairs whose names matched, so worth trying. */
  readonly pairsPlausible: number;
}

/**
 * Pairs of records on one phone number that are each other's only possible
 * match: their names are compatible with each other and with no one else on
 * that number. A group of two is simply a pair; in a larger group (a relative
 * or a test entry on the same number) the records that don't match anyone
 * are left out instead of blocking the whole number.
 */
function uniqueMatchPairs<T extends { id: string; firstName: string; lastName: string }>(group: readonly T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];
  for (const record of group) {
    const matches = group.filter((other) => other.id !== record.id && namesCompatible(record, other));
    if (matches.length !== 1) continue;
    const [other] = matches;
    const back = group.filter((x) => x.id !== other.id && namesCompatible(other, x));
    // Report each pair once, from its first-listed record (groups arrive oldest first).
    if (back.length === 1 && group.indexOf(record) < group.indexOf(other)) pairs.push([record, other]);
  }
  return pairs;
}

/**
 * Finds records sharing a phone number that look like the same person and
 * merges them. Catches duplicates that already exist, or that nothing has
 * touched since.
 *
 * Every shared number is examined on every run, and only the number of MERGES
 * per run is capped, so a large backlog is worked through gradually. The cap
 * must not apply to numbers examined: families and test numbers that share a
 * phone would otherwise crowd a real duplicate out of the window forever.
 */
export async function mergeDuplicateCustomersByPhone(limit = 25): Promise<DuplicateSweepResult> {
  const { rows } = await db.execute<{ id: string; first_name: string; last_name: string; key: string }>(sql`
    with keyed as (
      select id, first_name, last_name, created_at,
             right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) as key
      from customers
      where length(right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)) = 10
    )
    select id, first_name, last_name, key from keyed
    where key in (select key from keyed group by key having count(*) >= 2)
    order by key, created_at, id`);

  const groups = new Map<string, Array<{ id: string; firstName: string; lastName: string }>>();
  for (const row of rows) {
    const list = groups.get(row.key) ?? [];
    list.push({ id: row.id, firstName: row.first_name, lastName: row.last_name });
    groups.set(row.key, list);
  }
  const candidates = [...groups.values()].flatMap((group) => uniqueMatchPairs(group));

  const merged: MergeSummary[] = [];
  let skipped = 0;
  for (const [older] of candidates) {
    if (merged.length >= limit) break;
    const outcome = await db.transaction((tx) => reconcileDuplicateByPhoneDetailed(tx, older.id));
    if (outcome.merged) merged.push(outcome.merged);
    else skipped++;
  }
  return { merged, skipped, pairsExamined: groups.size, pairsPlausible: candidates.length };
}

export type DuplicateBlockReason = "names_differ" | "both_purchased" | "several_matching_records";

export interface DuplicateCandidate {
  readonly id: string;
  readonly personNumber: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly leadType: string;
  readonly createdAt: string;
  readonly completedOrders: number;
  /** Why the automatic merge will not combine this record with the one being viewed, or null if it will. */
  readonly blockedReason: DuplicateBlockReason | null;
}

/** Other records on the same phone number as this customer, each with the reason it is not merged automatically. */
export async function findDuplicateCandidates(customerId: string): Promise<DuplicateCandidate[]> {
  const [self] = await db.select().from(customersTable).where(eq(customersTable.id, customerId));
  if (!self?.phone) return [];
  const key = phoneMatchKey(self.phone);
  if (key.length !== 10) return [];

  const others = await db
    .select()
    .from(customersTable)
    .where(and(sql`${PHONE_KEY_SQL} = ${key}`, sql`${customersTable.id} <> ${customerId}`))
    .orderBy(customersTable.createdAt);
  if (others.length === 0) return [];

  const ids = [self.id, ...others.map((row) => row.id)];
  const counts = await db
    .select({ customerId: purchasesTable.customerId, n: sql<number>`count(*)::int` })
    .from(purchasesTable)
    .where(and(inArray(purchasesTable.customerId, ids), eq(purchasesTable.status, "completed")))
    .groupBy(purchasesTable.customerId);
  const orders = new Map(counts.map((row) => [row.customerId, row.n]));
  const selfOrders = orders.get(self.id) ?? 0;
  const matchingCount = others.filter((row) => namesCompatible(self, row)).length;

  return others.map((row) => {
    const completedOrders = orders.get(row.id) ?? 0;
    let blockedReason: DuplicateBlockReason | null = null;
    if (!namesCompatible(self, row)) blockedReason = "names_differ";
    else if (selfOrders > 0 && completedOrders > 0) blockedReason = "both_purchased";
    else if (matchingCount > 1) blockedReason = "several_matching_records";
    return {
      id: row.id, personNumber: row.personNumber, firstName: row.firstName, lastName: row.lastName, email: row.email,
      phone: row.phone, leadType: row.leadType, createdAt: row.createdAt.toISOString(), completedOrders, blockedReason,
    };
  });
}

/**
 * A merge a staff member asked for. Works even when the automatic rules would
 * decline (names differ, several candidates), because a person has looked at
 * both records; the two records must still share a phone number, and two that
 * have both bought are still refused. The older record survives.
 */
export async function mergeCustomersByStaff(firstId: string, secondId: string, staffEmail: string): Promise<MergeSummary> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(customersTable).where(inArray(customersTable.id, [firstId, secondId]));
    const a = rows.find((row) => row.id === firstId);
    const b = rows.find((row) => row.id === secondId);
    if (!a || !b) throw new MergeRefusedError("One of the customer records no longer exists.");
    const aKey = a.phone ? phoneMatchKey(a.phone) : "";
    if (aKey.length !== 10 || aKey !== (b.phone ? phoneMatchKey(b.phone) : "")) throw new MergeRefusedError("These records do not share a phone number.");
    const { survivor, duplicate } = pickSurvivor(a, b);
    return mergeCustomersTx(tx, survivor.id, duplicate.id, { mergedBy: staffEmail });
  });
}

import { and, asc, desc, eq, ilike, lte, or, sql, getTableColumns } from "drizzle-orm";
import { db, customersTable, purchasesTable, purchaseClassificationAuditsTable, type PurchaseStatus } from "@luma/db";
import type { CreatePurchaseRequest, ListPurchasesQuery, PurchasesSummaryQuery, UpdatePurchaseRequest } from "@luma/shared";
import { setCustomerSmsDnd, setCustomerEmailDnd, silenceOtherLeadsSharingPhone } from "./dnd.service.js";

export async function listPurchasesForCustomer(customerId: string) {
  return db
    .select()
    .from(purchasesTable)
    .where(eq(purchasesTable.customerId, customerId))
    .orderBy(purchasesTable.purchaseDate);
}

const SORT_COLUMNS = {
  purchaseDate: purchasesTable.purchaseDate,
  amountPaid: purchasesTable.amountPaid,
} as const;

/** Order-level list across all customers, for the Orders tab. */
export async function listPurchases(query: ListPurchasesQuery) {
  const { sortBy, sortDir, limit, offset, orderClassification, status, search } = query;
  const orderFn = sortDir === "asc" ? asc : desc;
  const conditions = [
    orderClassification ? eq(purchasesTable.orderClassification, orderClassification) : undefined,
    status ? eq(purchasesTable.status, status) : undefined,
    search
      ? or(
          // Concatenated, not separate firstName/lastName ilike checks — a
          // search for the customer's name exactly as it's displayed
          // ("Norma Pfannerstill") wouldn't match either column alone, same
          // fix already applied to the Leads page search.
          sql`(${customersTable.firstName} || ' ' || ${customersTable.lastName}) ilike ${`%${search}%`}`,
          ilike(customersTable.email, `%${search}%`),
          ilike(purchasesTable.orderNumber, `%${search}%`),
        )
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      ...getTableColumns(purchasesTable),
      customerFirstName: customersTable.firstName,
      customerLastName: customersTable.lastName,
      customerPersonNumber: customersTable.personNumber,
    })
    .from(purchasesTable)
    .innerJoin(customersTable, eq(customersTable.id, purchasesTable.customerId))
    .where(whereCondition)
    // Tie-broken by createdAt (row insert time), then id: purchaseDate is a
    // bare date with no time component and amountPaid commonly repeats, so an
    // id-only tiebreak sorts same-day ties by random UUID rather than by when
    // the order actually arrived — a brand-new order could land anywhere
    // within that day's block instead of at the top. createdAt fixes that;
    // id stays as a final tiebreak for full determinism (so rows don't
    // silently swap between the last page and the next one as Postgres picks
    // a different tie order per request).
    .orderBy(orderFn(SORT_COLUMNS[sortBy]), orderFn(purchasesTable.createdAt), asc(purchasesTable.id))
    .limit(limit)
    .offset(offset);

  // The count needs the same customersTable join as the row query whenever
  // search is active (it filters on joined columns) — count(*) alone over
  // purchasesTable would otherwise ignore the search condition entirely.
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(purchasesTable)
    .innerJoin(customersTable, eq(customersTable.id, purchasesTable.customerId))
    .where(whereCondition);

  return { purchases: rows, total };
}

/** Only "completed" purchases count toward revenue/customer figures — matches
 * how the Orders list itself surfaces status, and mirrors what the reference
 * dashboard's "Total Completed Orders" tile means. */
export async function getPurchasesSummary(query: PurchasesSummaryQuery) {
  const sinceCondition = query.period === "all" ? undefined : sql`${purchasesTable.purchaseDate} >= (current_date - ${query.period}::int)`;
  const completedCondition = eq(purchasesTable.status, "completed");
  const baseCondition = sinceCondition ? and(completedCondition, sinceCondition) : completedCondition;

  const [{ totalCompletedOrders, totalRevenue, purchasingCustomers }] = await db
    .select({
      totalCompletedOrders: sql<number>`count(*)::int`,
      totalRevenue: sql<string>`coalesce(sum(${purchasesTable.amountPaid}), 0)::text`,
      purchasingCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int`,
    })
    .from(purchasesTable)
    .where(baseCondition);

  const [{ newCustomers }] = await db
    .select({ newCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int` })
    .from(purchasesTable)
    .where(and(baseCondition, eq(purchasesTable.orderClassification, "first_order")));

  const [{ recurringCustomers }] = await db
    .select({ recurringCustomers: sql<number>`count(distinct ${purchasesTable.customerId})::int` })
    .from(purchasesTable)
    .where(and(baseCondition, eq(purchasesTable.orderClassification, "recurring")));

  return { purchasingCustomers, totalRevenue, totalCompletedOrders, newCustomers, recurringCustomers };
}

/**
 * Classifies a new purchase as "first_order" if no earlier purchase exists
 * for this customer, else "recurring" — same rule the old app used
 * ("classified based on order within the person's history"), with
 * source="manual" since this is the admin-driven creation path (webhooks
 * in Phase 5 will use source="bask" instead).
 *
 * Locks the customer row for the duration of the transaction so two
 * concurrent purchase-creation calls for the same customer can't both read
 * "no earlier purchase" and both classify as first_order — the second
 * transaction blocks on the lock until the first commits, then sees the
 * first's row and correctly classifies as recurring. purchases_customer_
 * first_order_key (a partial unique index) is the DB-level backstop in case
 * this lock is ever bypassed.
 *
 * Uses <=, not <: two purchases landing on the same calendar date (a same-
 * day repeat order, or two concurrent purchases with equal purchaseDate)
 * have no other way to order themselves, so whichever already exists wins
 * first_order and this one is recurring — otherwise both would independently
 * see "no strictly-earlier purchase" and collide on the unique index above.
 */
export async function createPurchase(customerId: string, input: CreatePurchaseRequest) {
  const purchase = await db.transaction(async (tx) => {
    await tx.select({ id: customersTable.id }).from(customersTable).where(eq(customersTable.id, customerId)).for("update");

    const [earlier] = await tx
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(and(eq(purchasesTable.customerId, customerId), lte(purchasesTable.purchaseDate, input.purchaseDate)));

    const [inserted] = await tx
      .insert(purchasesTable)
      .values({
        customerId,
        purchaseDate: input.purchaseDate,
        orderNumber: input.orderNumber,
        productName: input.productName,
        amountPaid: input.amountPaid,
        status: input.status ?? "completed",
        ecommerceOrderId: input.ecommerceOrderId,
        orderClassification: earlier ? "recurring" : "first_order",
        orderClassificationSource: "manual",
      })
      .returning();
    return inserted;
  });

  // A purchase is treated as fresh consent to be messaged again, on both
  // channels independently — see dnd.service.ts's setCustomerSmsDnd docstring.
  await setCustomerSmsDnd(customerId, false);
  await setCustomerEmailDnd(customerId, false);
  // The mirror image: any other, still-unpurchased lead sharing this same
  // phone number stops getting marketing texts/emails — see
  // silenceOtherLeadsSharingPhone's docstring.
  await silenceOtherLeadsSharingPhone(customerId);

  return purchase;
}

export class DuplicateFirstOrderError extends Error {
  statusCode = 409;
  constructor() {
    super("This customer already has a purchase classified as first_order. Reclassify that one first.");
  }
}

export async function updatePurchase(id: number, input: UpdatePurchaseRequest, actor: { id: string; email: string }) {
  try {
    return await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(purchasesTable).where(eq(purchasesTable.id, id));
      if (!existing) return null;

      const patch: Partial<typeof purchasesTable.$inferInsert> = {
        ...(input.purchaseDate !== undefined ? { purchaseDate: input.purchaseDate } : {}),
        ...(input.orderNumber !== undefined ? { orderNumber: input.orderNumber } : {}),
        ...(input.productName !== undefined ? { productName: input.productName } : {}),
        ...(input.amountPaid !== undefined ? { amountPaid: input.amountPaid } : {}),
        ...(input.status !== undefined ? { status: input.status as PurchaseStatus } : {}),
      };

      if (input.orderClassification !== undefined && input.orderClassification !== existing.orderClassification) {
        patch.orderClassification = input.orderClassification;
        patch.orderClassificationSource = "manual";
        await tx.insert(purchaseClassificationAuditsTable).values({
          purchaseId: id,
          changedBy: actor.email,
          previousClassification: existing.orderClassification,
          newClassification: input.orderClassification,
          previousSource: existing.orderClassificationSource,
          newSource: "manual",
        });
      }

      const [updated] = await tx.update(purchasesTable).set(patch).where(eq(purchasesTable.id, id)).returning();
      return updated;
    });
  } catch (err) {
    // Manually reclassifying a purchase to first_order when the customer
    // already has one hits purchases_customer_first_order_key — surface a
    // clear 409 instead of a raw Postgres constraint error. drizzle wraps
    // the raw pg driver error (with .code/.constraint) as `.cause` on its
    // own DrizzleQueryError, so check both levels.
    const pgErr = err && typeof err === "object" && "cause" in err && err.cause && typeof err.cause === "object" ? err.cause : err;
    if (pgErr && typeof pgErr === "object" && "code" in pgErr && pgErr.code === "23505" && "constraint" in pgErr && pgErr.constraint === "purchases_customer_first_order_key") {
      throw new DuplicateFirstOrderError();
    }
    throw err;
  }
}

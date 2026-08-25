import { and, desc, eq, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, marketingSpendWeeksTable } from "@luma/db";
import type { CreateMarketingSpendWeekRequest, MarketingCpaWeek, UpdateMarketingSpendWeekRequest } from "@luma/shared";
import { firstTouchSystemSql } from "./customers.service.js";

export async function listMarketingSpendWeeks() {
  return db.select().from(marketingSpendWeeksTable).orderBy(desc(marketingSpendWeeksTable.weekStart));
}

/**
 * weekEnd is always derived (Friday + 6 days = Thursday) — the DB also
 * enforces this via CHECK constraints, but validating here first gives a
 * clean 400 instead of a raw constraint-violation error.
 */
export async function createMarketingSpendWeek(
  input: CreateMarketingSpendWeekRequest,
  actor: { email: string },
): Promise<{ ok: true; week: typeof marketingSpendWeeksTable.$inferSelect } | { ok: false; error: string }> {
  const startDate = new Date(`${input.weekStart}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime())) {
    return { ok: false, error: "weekStart is not a valid date." };
  }
  if (startDate.getUTCDay() !== 5) {
    return { ok: false, error: "weekStart must be a Friday." };
  }
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const weekEnd = endDate.toISOString().slice(0, 10) as string;

  const [week] = await db
    .insert(marketingSpendWeeksTable)
    .values({
      weekStart: input.weekStart,
      weekEnd,
      notes: input.notes,
      createdBy: actor.email,
      updatedBy: actor.email,
    })
    .returning();
  return { ok: true, week: week! };
}

export async function updateMarketingSpendWeek(id: string, input: UpdateMarketingSpendWeekRequest, actor: { email: string }) {
  const patch: Partial<typeof marketingSpendWeeksTable.$inferInsert> = { updatedBy: actor.email };
  if (input.metaFormFillSpend !== undefined) {
    patch.metaFormFillSpend = input.metaFormFillSpend === "" ? null : input.metaFormFillSpend;
  }
  if (input.ecommerceSpend !== undefined) {
    patch.ecommerceSpend = input.ecommerceSpend === "" ? null : input.ecommerceSpend;
  }
  if (input.notes !== undefined) {
    patch.notes = input.notes;
  }

  const [week] = await db.update(marketingSpendWeeksTable).set(patch).where(eq(marketingSpendWeeksTable.id, id)).returning();
  return week ?? null;
}

type RawSourceMetrics = {
  spend: string | null;
  leadsReceived: number;
  closedDeals: number;
  stillOpen: number;
  acquisitionRevenue: string;
  conversionRate: number;
  avgDaysToClose: number | null;
  recurringExclusions: number;
  cpa: number | null;
  totalDaysToClose: number;
};

/**
 * Deals are attributed to the period the *lead* was received in, never when
 * the purchase happened — a lead from months ago converting this week still
 * counts toward the week they came in, not this one. Only a customer's
 * first-ever purchase (orderClassification = "first_order") counts as a
 * "closed deal" here; recurring purchases are fully excluded from revenue/
 * close figures (tallied separately as recurringExclusions), matching the
 * reference dashboard's "recurring exclusions" note.
 */
async function computeSourceMetrics(weekStart: string, weekEnd: string, system: "ghl" | "bask", spend: string | null): Promise<RawSourceMetrics> {
  const periodCondition = and(
    sql`${customersTable.leadReceivedDate} >= ${weekStart}`,
    sql`${customersTable.leadReceivedDate} <= ${weekEnd}`,
    sql`${firstTouchSystemSql} = ${system}`,
  );

  const [{ leadsReceived }] = await db.select({ leadsReceived: sql<number>`count(*)::int` }).from(customersTable).where(periodCondition);

  const [{ closedDeals, acquisitionRevenue, totalDaysToClose }] = await db
    .select({
      closedDeals: sql<number>`count(*)::int`,
      acquisitionRevenue: sql<string>`coalesce(sum(${purchasesTable.amountPaid}), 0)::text`,
      totalDaysToClose: sql<number>`coalesce(sum(${purchasesTable.purchaseDate}::date - ${customersTable.leadReceivedDate}::date), 0)::int`,
    })
    .from(customersTable)
    .innerJoin(
      purchasesTable,
      and(
        eq(purchasesTable.customerId, customersTable.id),
        eq(purchasesTable.orderClassification, "first_order"),
        eq(purchasesTable.status, "completed"),
      ),
    )
    .where(periodCondition);

  const [{ recurringExclusions }] = await db
    .select({ recurringExclusions: sql<number>`count(*)::int` })
    .from(customersTable)
    .innerJoin(
      purchasesTable,
      and(
        eq(purchasesTable.customerId, customersTable.id),
        eq(purchasesTable.orderClassification, "recurring"),
        eq(purchasesTable.status, "completed"),
      ),
    )
    .where(periodCondition);

  const stillOpen = leadsReceived - closedDeals;
  const conversionRate = leadsReceived > 0 ? Math.round((closedDeals / leadsReceived) * 1000) / 10 : 0;
  const avgDaysToClose = closedDeals > 0 ? Math.round((totalDaysToClose / closedDeals) * 10) / 10 : null;
  const cpa = spend !== null && closedDeals > 0 ? Math.round((Number(spend) / closedDeals) * 100) / 100 : null;

  return { spend, leadsReceived, closedDeals, stillOpen, acquisitionRevenue, conversionRate, avgDaysToClose, recurringExclusions, cpa, totalDaysToClose };
}

function combineMetrics(a: RawSourceMetrics, b: RawSourceMetrics): RawSourceMetrics {
  const leadsReceived = a.leadsReceived + b.leadsReceived;
  const closedDeals = a.closedDeals + b.closedDeals;
  const totalDaysToClose = a.totalDaysToClose + b.totalDaysToClose;
  const acquisitionRevenue = (Number(a.acquisitionRevenue) + Number(b.acquisitionRevenue)).toFixed(2);
  const recurringExclusions = a.recurringExclusions + b.recurringExclusions;
  const stillOpen = leadsReceived - closedDeals;
  const conversionRate = leadsReceived > 0 ? Math.round((closedDeals / leadsReceived) * 1000) / 10 : 0;
  const avgDaysToClose = closedDeals > 0 ? Math.round((totalDaysToClose / closedDeals) * 10) / 10 : null;
  const spend = a.spend !== null || b.spend !== null ? (Number(a.spend ?? 0) + Number(b.spend ?? 0)).toFixed(2) : null;
  const cpa = spend !== null && closedDeals > 0 ? Math.round((Number(spend) / closedDeals) * 100) / 100 : null;

  return { spend, leadsReceived, closedDeals, stillOpen, acquisitionRevenue, conversionRate, avgDaysToClose, recurringExclusions, cpa, totalDaysToClose };
}

function toPublicMetrics({ totalDaysToClose: _totalDaysToClose, ...rest }: RawSourceMetrics) {
  return rest;
}

export async function listMarketingCpaWeeks(): Promise<MarketingCpaWeek[]> {
  const weeks = await listMarketingSpendWeeks();

  const results: MarketingCpaWeek[] = [];
  for (const week of weeks) {
    const metaFormFillRaw = await computeSourceMetrics(week.weekStart, week.weekEnd, "ghl", week.metaFormFillSpend);
    const ecommerceRaw = await computeSourceMetrics(week.weekStart, week.weekEnd, "bask", week.ecommerceSpend);
    const combinedRaw = combineMetrics(metaFormFillRaw, ecommerceRaw);

    results.push({
      id: week.id,
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      notes: week.notes,
      metaFormFill: toPublicMetrics(metaFormFillRaw),
      ecommerce: toPublicMetrics(ecommerceRaw),
      combined: toPublicMetrics(combinedRaw),
    });
  }
  return results;
}

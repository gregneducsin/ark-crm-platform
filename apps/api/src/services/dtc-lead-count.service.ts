import { and, eq, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable } from "@luma/db";
import type { CustomersSummaryQuery } from "@luma/shared";

/** Same lead-received date semantics as dashboard summaries, with an exact
 * DTC filter. Count customers directly to avoid purchase/message duplicates. */
export async function getDtcLeadCount(query: CustomersSummaryQuery) {
  const effectiveDateFrom = query.dateFrom || query.dateTo || query.period === "all"
    ? query.dateFrom ?? null
    : (await db.execute<{ date: string }>(sql`select (current_date - ${query.period ?? 30}::int)::text as date`)).rows[0].date;
  const range = and(
    effectiveDateFrom ? sql`${customersTable.leadReceivedDate} >= ${effectiveDateFrom}` : undefined,
    query.dateTo ? sql`${customersTable.leadReceivedDate} <= ${query.dateTo}` : undefined,
  );
  const purchased = sql`exists (
    select 1 from ${purchasesTable}
    where ${purchasesTable.customerId} = ${customersTable.id}
      and ${purchasesTable.orderClassification} = 'first_order'
      and ${purchasesTable.status} = 'completed'
  )`;
  // One aggregate snapshot and one row per customer, regardless of order count.
  const [row] = await db.select({
    total: sql<number>`count(*)::int`,
    purchased: sql<number>`count(*) filter (where ${purchased})::int`,
  })
    .from(customersTable).where(and(eq(customersTable.leadType, "DTC"), range));
  return {
    total: row.total,
    purchased: row.purchased,
    notPurchased: row.total - row.purchased,
    conversionRate: row.total > 0 ? Math.round(row.purchased / row.total * 1000) / 10 : null,
    conversionDefinition: "Percentage of saved DTC leads in the lead-received date range with a completed first_order purchase, regardless of purchase date. Each customer counts once. Null rate means no leads.",
    definition: "Saved customer records with leadType DTC; unmatched texting contacts are excluded.",
    unmatchedContactCount: null,
    period: query.dateFrom || query.dateTo ? null : query.period ?? 30,
    dateFrom: effectiveDateFrom,
    dateTo: query.dateTo ?? null,
    dateBasis: "leadReceivedDate",
  };
}

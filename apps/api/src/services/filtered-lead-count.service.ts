import { and, eq, sql } from "drizzle-orm";
import { db, customersTable } from "@luma/db";
import type { CustomersSummaryQuery } from "@luma/shared";
import { firstTouchSystemSql } from "./customers.service.js";

export type LeadCountSegment = "meta_form_fill" | "questionnaire" | "sms_inquiry" | "lead_type";

export async function getFilteredLeadCount(query: CustomersSummaryQuery, segment: LeadCountSegment, leadType?: string) {
  if (segment === "lead_type" && !leadType?.trim()) throw new Error("An exact saved lead type is required.");
  const type = segment === "sms_inquiry" ? "SMS Inquiry" : leadType?.trim();
  const filter = segment === "meta_form_fill" ? sql`${firstTouchSystemSql} = 'ghl'`
    : segment === "questionnaire" ? sql`${firstTouchSystemSql} = 'bask'`
    : eq(customersTable.leadType, type!);
  const explicit = Boolean(query.dateFrom || query.dateTo);
  const dateFrom = explicit || query.period === "all" ? query.dateFrom ?? null
    : (await db.execute<{ date: string }>(sql`select (current_date - ${query.period ?? 30}::int)::text as date`)).rows[0].date;
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(customersTable).where(and(
    filter,
    dateFrom ? sql`${customersTable.leadReceivedDate} >= ${dateFrom}` : undefined,
    query.dateTo ? sql`${customersTable.leadReceivedDate} <= ${query.dateTo}` : undefined,
  ));
  return {
    total: row.total, segment, leadType: segment === "meta_form_fill" || segment === "questionnaire" ? null : type,
    definition: segment === "meta_form_fill" ? "Saved leads first attributed to Meta form fill (ghl), matching the dashboard."
      : segment === "questionnaire" ? "Saved leads first attributed to Questionnaire (bask), matching the dashboard; not all people who ever completed a questionnaire."
      : "Saved leads with the exact specified leadType.",
    dateFrom, dateTo: query.dateTo ?? null, period: explicit ? null : query.period ?? 30,
    dateBasis: "leadReceivedDate", unmatchedContactCount: null,
  };
}

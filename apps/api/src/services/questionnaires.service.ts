import { and, eq, inArray, sql } from "drizzle-orm";
import { db, questionnaireEventsTable, purchasesTable } from "@luma/db";
import type { QuestionnaireBreakdownRow, QuestionnairesQuery, QuestionnairesResponse } from "@luma/shared";

const EMPTY_RESPONSE: QuestionnairesResponse = {
  summary: { leadsWithQuestionnaire: 0, firstTimeCustomers: 0, completedPurchases: 0, totalRevenue: "0.00", conversionRate: 0 },
  rows: [],
};

/**
 * Per-questionnaire performance breakdown. "Within the period" is judged by
 * questionnaire_events.lastEventAt — this page reports on questionnaire
 * *activity*, not lead-received date, so an old lead who fills out a
 * questionnaire this week still shows up in this week's numbers.
 */
export async function getQuestionnairesData(query: QuestionnairesQuery): Promise<QuestionnairesResponse> {
  const periodCondition = query.period === "all" ? undefined : sql`${questionnaireEventsTable.lastEventAt} >= (now() - ${query.period}::int * interval '1 day')`;

  const eventRows = await db
    .selectDistinct({
      questionnaireId: questionnaireEventsTable.questionnaireId,
      personId: questionnaireEventsTable.personId,
    })
    .from(questionnaireEventsTable)
    .where(periodCondition);

  if (eventRows.length === 0) return EMPTY_RESPONSE;

  const personIds = [...new Set(eventRows.map((r) => r.personId))];

  const purchaseRows = await db
    .select({
      customerId: purchasesTable.customerId,
      amountPaid: purchasesTable.amountPaid,
      purchaseDate: purchasesTable.purchaseDate,
      orderClassification: purchasesTable.orderClassification,
    })
    .from(purchasesTable)
    .where(and(inArray(purchasesTable.customerId, personIds), eq(purchasesTable.status, "completed")));

  const purchasesByCustomer = new Map<string, typeof purchaseRows>();
  for (const p of purchaseRows) {
    const list = purchasesByCustomer.get(p.customerId) ?? [];
    list.push(p);
    purchasesByCustomer.set(p.customerId, list);
  }

  const firstOrderCustomerIds = new Set(purchaseRows.filter((p) => p.orderClassification === "first_order").map((p) => p.customerId));

  const byQuestionnaire = new Map<string, Set<string>>();
  for (const r of eventRows) {
    const set = byQuestionnaire.get(r.questionnaireId) ?? new Set<string>();
    set.add(r.personId);
    byQuestionnaire.set(r.questionnaireId, set);
  }

  const rows: QuestionnaireBreakdownRow[] = [];
  for (const [questionnaireId, personIdSet] of byQuestionnaire) {
    const leads = personIdSet.size;
    let customers = 0;
    let purchases = 0;
    let revenue = 0;
    let lastPurchase: string | null = null;

    for (const personId of personIdSet) {
      if (firstOrderCustomerIds.has(personId)) customers++;
      for (const p of purchasesByCustomer.get(personId) ?? []) {
        purchases++;
        revenue += Number(p.amountPaid);
        if (!lastPurchase || p.purchaseDate > lastPurchase) lastPurchase = p.purchaseDate;
      }
    }

    rows.push({
      questionnaireId,
      leads,
      customers,
      conversionRate: leads > 0 ? Math.round((customers / leads) * 1000) / 10 : 0,
      purchases,
      revenue: revenue.toFixed(2),
      avgValue: purchases > 0 ? (revenue / purchases).toFixed(2) : null,
      lastPurchase,
    });
  }

  rows.sort((a, b) => b.leads - a.leads);

  const leadsWithQuestionnaire = personIds.length;
  const firstTimeCustomers = personIds.filter((id) => firstOrderCustomerIds.has(id)).length;
  const completedPurchases = purchaseRows.length;
  const totalRevenue = purchaseRows.reduce((sum, p) => sum + Number(p.amountPaid), 0).toFixed(2);
  const conversionRate = leadsWithQuestionnaire > 0 ? Math.round((firstTimeCustomers / leadsWithQuestionnaire) * 1000) / 10 : 0;

  return {
    summary: { leadsWithQuestionnaire, firstTimeCustomers, completedPurchases, totalRevenue, conversionRate },
    rows,
  };
}

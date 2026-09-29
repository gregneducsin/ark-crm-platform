import { describe, expect, it } from "vitest";
import { db, customersTable, questionnaireEventsTable } from "@luma/db";
import { getQuestionnairesData } from "./questionnaires.service.js";

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Questionnaire",
      lastName: "Test",
      email: `questionnaire-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-16",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

async function seedEvent(personId: string, lastEventAt: string): Promise<void> {
  await db.insert(questionnaireEventsTable).values({
    personId,
    questionnaireId: `Q-${crypto.randomUUID()}`,
    status: "completed",
    lastEventAt: new Date(lastEventAt),
  });
}

// Tests share one live table across the whole suite (no per-test reset), so
// every assertion compares a before/after snapshot — same reasoning as
// bot-engagement.service.test.ts.
describe("getQuestionnairesData", () => {
  it("filters by an exact dateFrom/dateTo range instead of a trailing-day period", async () => {
    const before = await getQuestionnairesData({ dateFrom: "2000-04-01", dateTo: "2000-04-30" });

    await seedEvent(await seedCustomer(), "2000-04-15T12:00:00Z");
    // Outside the range — should not affect the count.
    await seedEvent(await seedCustomer(), "2000-01-01T12:00:00Z");

    const after = await getQuestionnairesData({ dateFrom: "2000-04-01", dateTo: "2000-04-30" });
    expect(after.summary.leadsWithQuestionnaire - before.summary.leadsWithQuestionnaire).toBe(1);
  });

  it("includes an event on the last day of the range (dateTo is inclusive of the full day)", async () => {
    const before = await getQuestionnairesData({ dateFrom: "2000-05-01", dateTo: "2000-05-31" });

    // Late in the day on the last date of the range — a naive `<= dateTo`
    // comparison against this timestamp column would wrongly exclude it.
    await seedEvent(await seedCustomer(), "2000-05-31T23:45:00Z");

    const after = await getQuestionnairesData({ dateFrom: "2000-05-01", dateTo: "2000-05-31" });
    expect(after.summary.leadsWithQuestionnaire - before.summary.leadsWithQuestionnaire).toBe(1);
  });
});

import { and, eq } from "drizzle-orm";
import { db, purchasesTable, questionnaireEventsTable } from "@luma/db";

/** A later link click never restarts acquisition nudges after conversion. */
export async function intakeCompletionReason(personId: string, query: Pick<typeof db, "select"> = db): Promise<"already_purchased" | "intake_submitted" | null> {
  const [purchase] = await query.select({ id: purchasesTable.id }).from(purchasesTable)
    .where(and(eq(purchasesTable.customerId, personId), eq(purchasesTable.status, "completed"))).limit(1);
  if (purchase) return "already_purchased";
  const [submission] = await query.select({ id: questionnaireEventsTable.id }).from(questionnaireEventsTable)
    .where(and(eq(questionnaireEventsTable.personId, personId), eq(questionnaireEventsTable.status, "submitted"))).limit(1);
  return submission ? "intake_submitted" : null;
}

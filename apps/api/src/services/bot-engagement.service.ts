import { and, eq, sql } from "drizzle-orm";
import { db, customersTable, purchasesTable, conversationsTable, conversationMessagesTable, emailConversationsTable, emailConversationMessagesTable } from "@luma/db";
import type { CustomersSummaryQuery } from "@luma/shared";

/**
 * Whether a lead's purchase followed at least one real reply to Alexis — SMS
 * or email, whichever channel they used — before the purchase date, not
 * just receiving the automated opener. "inbound" on both message tables
 * always means the customer wrote it (never Alexis's own text), so this is a
 * genuine two-way exchange, not just "a message was sent to them." Sophie's
 * post-purchase support conversations are deliberately excluded — asking
 * "did they talk to the bot before buying" about the bot that only ever
 * talks to people *after* they've already bought would be circular.
 *
 * Purchase date is a bare date (no time) and message timestamps are full
 * datetimes, so "before" is compared at day granularity — a reply on the
 * same calendar day as the purchase counts as before it.
 */
const spokeToAlexisBeforePurchaseSql = sql<boolean>`exists (
  select 1 from ${conversationMessagesTable}
  join ${conversationsTable} on ${conversationsTable.id} = ${conversationMessagesTable.conversationId}
  where ${conversationsTable.personId} = ${customersTable.id}
    and ${conversationMessagesTable.direction} = 'inbound'
    and ${conversationMessagesTable.createdAt}::date <= ${purchasesTable.purchaseDate}::date
  union all
  select 1 from ${emailConversationMessagesTable}
  join ${emailConversationsTable} on ${emailConversationsTable.id} = ${emailConversationMessagesTable.conversationId}
  where ${emailConversationsTable.personId} = ${customersTable.id}
    and ${emailConversationMessagesTable.direction} = 'inbound'
    and ${emailConversationMessagesTable.createdAt}::date <= ${purchasesTable.purchaseDate}::date
)`;

export interface BotEngagementSummary {
  readonly purchasedCount: number;
  readonly spokeToBotCount: number;
  readonly noBotContactCount: number;
  readonly avgDaysToCloseSpokeToBot: number | null;
  readonly avgDaysToCloseNoBotContact: number | null;
}

/**
 * For every lead with a qualifying (first-order, completed) purchase in the
 * period — same "purchased" and period rules getCustomersSummary uses —
 * splits them into "replied to Alexis before buying" vs "never did," and
 * reports the average days from lead-received to purchase for each group.
 */
export async function getBotEngagementSummary(query: CustomersSummaryQuery): Promise<BotEngagementSummary> {
  const sinceCondition = query.period === "all" ? undefined : sql`${customersTable.leadReceivedDate} >= (current_date - ${query.period}::int)`;

  const rows = await db
    .select({
      spokeToBot: spokeToAlexisBeforePurchaseSql,
      daysToClose: sql<number>`(${purchasesTable.purchaseDate}::date - ${customersTable.leadReceivedDate}::date)::int`,
    })
    .from(customersTable)
    .innerJoin(
      purchasesTable,
      and(eq(purchasesTable.customerId, customersTable.id), eq(purchasesTable.orderClassification, "first_order"), eq(purchasesTable.status, "completed")),
    )
    .where(sinceCondition);

  const spokeToBot = rows.filter((r) => r.spokeToBot);
  const noBotContact = rows.filter((r) => !r.spokeToBot);

  const avg = (group: typeof rows): number | null =>
    group.length > 0 ? Math.round((group.reduce((sum, r) => sum + r.daysToClose, 0) / group.length) * 10) / 10 : null;

  return {
    purchasedCount: rows.length,
    spokeToBotCount: spokeToBot.length,
    noBotContactCount: noBotContact.length,
    avgDaysToCloseSpokeToBot: avg(spokeToBot),
    avgDaysToCloseNoBotContact: avg(noBotContact),
  };
}

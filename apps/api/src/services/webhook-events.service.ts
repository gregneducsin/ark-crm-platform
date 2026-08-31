import { and, desc, eq } from "drizzle-orm";
import { db, customersTable, webhookEventsTable, type WebhookEvent } from "@luma/db";
import type { WebhookEventItem, WebhookEventStatus } from "@luma/shared";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface ListWebhookEventsParams {
  status?: WebhookEventStatus | "all";
  source?: WebhookEvent["source"];
  limit?: number;
}

/**
 * LEFT JOIN, not INNER: a failed-validation row has no personId at all
 * (see respondToInvalidWebhookPayload), and even a successfully-recorded
 * event can carry a personId the customer-matching step never resolved —
 * both cases still need to show up here.
 */
export async function listWebhookEvents(params: ListWebhookEventsParams = {}): Promise<WebhookEventItem[]> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const conditions = [
    params.status && params.status !== "all" ? eq(webhookEventsTable.status, params.status) : undefined,
    params.source ? eq(webhookEventsTable.source, params.source) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const rows = await db
    .select({
      id: webhookEventsTable.id,
      source: webhookEventsTable.source,
      externalEventId: webhookEventsTable.externalEventId,
      personId: webhookEventsTable.personId,
      firstName: customersTable.firstName,
      lastName: customersTable.lastName,
      status: webhookEventsTable.status,
      errorMessage: webhookEventsTable.errorMessage,
      rawPayload: webhookEventsTable.rawPayload,
      receivedAt: webhookEventsTable.receivedAt,
      processedAt: webhookEventsTable.processedAt,
    })
    .from(webhookEventsTable)
    .leftJoin(customersTable, eq(customersTable.id, webhookEventsTable.personId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(webhookEventsTable.receivedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    externalEventId: r.externalEventId,
    personId: r.personId,
    customerName: r.firstName || r.lastName ? `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() : null,
    status: r.status as WebhookEventStatus,
    errorMessage: r.errorMessage,
    rawPayload: r.rawPayload,
    receivedAt: r.receivedAt.toISOString(),
    processedAt: r.processedAt?.toISOString() ?? null,
  }));
}

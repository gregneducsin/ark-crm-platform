import { and, eq, inArray } from "drizzle-orm";
import { db, intakeLinkTokensTable } from "@luma/db";
import { hashToken } from "@luma/shared";

type Message = { direction: string; body: string; deliveryStatus: string | null };

/** Minting and model claims are not send evidence. Match confirmed outbound
 * messages to a real token owned by this person, including expired links.
 * An expired link was still sent; an explicit replacement remains allowed. */
export async function hasConfirmedIntakeLink(personId: string, messages: readonly Message[]): Promise<boolean> {
  const hashes = new Set<string>();
  for (const message of messages) {
    if (message.direction !== "outbound" || !["sent", "delivered", "read"].includes(message.deliveryStatus ?? "")) continue;
    for (const match of message.body.matchAll(/https?:\/\/[^\s<>"']+\/go\/([A-Za-z0-9_-]+)/g)) {
      hashes.add(hashToken(match[1]));
    }
  }
  if (!hashes.size) return false;
  const [token] = await db.select({ id: intakeLinkTokensTable.id }).from(intakeLinkTokensTable)
    .where(and(eq(intakeLinkTokensTable.personId, personId), inArray(intakeLinkTokensTable.tokenHash, [...hashes]))).limit(1);
  return Boolean(token);
}

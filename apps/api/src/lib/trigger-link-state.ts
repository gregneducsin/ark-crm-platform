import { createHash } from "node:crypto";

interface LinkMessage {
  body: string;
  direction: string;
  deliveryStatus?: string | null;
}
interface TrackedLink {
  tokenHash: string;
  clickedAt: Date | string | null;
}

/** Only provider-confirmed outbound messages count. Token ownership is checked
 * against this customer's stored links, never inferred from AI state. */
export function confirmedTriggerLinkState(messages: readonly LinkMessage[], links: readonly TrackedLink[]) {
  const tokens = new Map(links.map((link) => [link.tokenHash, link]));
  let sent = false;
  let clicked = false;
  for (const message of messages) {
    if (message.direction !== "outbound" || !["sent", "delivered", "read"].includes(message.deliveryStatus ?? "")) continue;
    for (const match of message.body.matchAll(/https?:\/\/[^\s<>"']+\/go\/([A-Za-z0-9_-]+)(?=[\s<>"'?#).,]|$)/g)) {
      const token = tokens.get(createHash("sha256").update(match[1]).digest("hex"));
      if (!token) continue;
      sent = true;
      clicked ||= token.clickedAt != null;
    }
  }
  return { sent, clicked };
}

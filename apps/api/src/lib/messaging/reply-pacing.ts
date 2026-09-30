/** Durable workers retry after this quiet period; never sleep while holding a lock. */
export const SMS_REPLY_QUIET_MS = 45_000;
export function isSmsReplyReady(receivedAt: Date, now = Date.now()): boolean {
  return now - receivedAt.getTime() >= SMS_REPLY_QUIET_MS;
}

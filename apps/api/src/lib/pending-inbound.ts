/** New inbound texts after the latest outbound, newest first. Older handled
 * clinical/consent messages must not retrigger a later ordinary turn. */
export function pendingInboundMessages<T extends { readonly direction: "inbound" | "outbound"; readonly body: string }>(messages: readonly T[]): T[] {
  const pending: T[] = [];
  for (const message of [...messages].reverse()) {
    if (message.direction === "outbound") break;
    pending.push(message);
  }
  return pending;
}

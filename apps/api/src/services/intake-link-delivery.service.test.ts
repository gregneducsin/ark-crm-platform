import { describe, it, expect } from "vitest";
import { db, customersTable, intakeLinkTokensTable } from "@luma/db";
import { hashToken } from "@luma/shared";
import { hasConfirmedIntakeLink } from "./intake-link-delivery.service.js";

describe("confirmed intake link evidence", () => {
  it("requires a confirmed outbound link owned by the customer", async () => {
    const [person] = await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Link",
      email: crypto.randomUUID() + "@example.com", leadReceivedDate: "2026-09-27" }).returning();
    const token = crypto.randomUUID();
    await db.insert(intakeLinkTokensTable).values({ personId: person.id, tokenHash: hashToken(token), expiresAt: new Date(0) });
    const message = { direction: "outbound", body: "Here is your form: https://intake.example.com/go/" + token, deliveryStatus: "sent" };
    for (const status of ["queued", "unknown", "failed", null]) {
      expect(await hasConfirmedIntakeLink(person.id, [{ ...message, deliveryStatus: status }])).toBe(false);
    }
    for (const status of ["sent", "delivered", "read"]) {
      expect(await hasConfirmedIntakeLink(person.id, [{ ...message, deliveryStatus: status }])).toBe(true);
    }
    expect(await hasConfirmedIntakeLink(person.id, [{ ...message, direction: "inbound" }])).toBe(false);
    expect(await hasConfirmedIntakeLink(person.id, [{ ...message, body: "I already sent your link." }])).toBe(false);
    expect(await hasConfirmedIntakeLink(crypto.randomUUID(), [message])).toBe(false);
    expect(await hasConfirmedIntakeLink(person.id, [{ ...message, body: "https://intake.example.com/go/unknown" }])).toBe(false);
  });
});

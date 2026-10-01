import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, customersTable, webhookEventsTable } from "@luma/db";
const mocks = vi.hoisted(() => ({ shipped: vi.fn() }));
vi.mock("./order-fulfillment.service.js", () => ({ handleOrderShipped: mocks.shipped, sendOrderReceivedOpener: vi.fn(), sendRefillOrderReceivedNotice: vi.fn(), handlePrescriptionWritten: vi.fn(), handlePaymentFailed: vi.fn(), handleRefund: vi.fn() }));
vi.mock("../lib/slack.js", () => ({ notifySlack: vi.fn(), notifySmsSlack: vi.fn() }));
import { handleBaskOrderShippedWebhook as receive } from "./webhooks.service.js";
beforeEach(() => { mocks.shipped.mockReset().mockResolvedValue(undefined); });
async function seed() {
  const externalPersonId = crypto.randomUUID();
  const email = `${externalPersonId}@example.com`;
  await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Shipment", email, leadReceivedDate: "2026-01-01" });
  return { externalPersonId, email, trackingNumber: `TEST${crypto.randomUUID().replaceAll("-", "").toUpperCase()}` };
}
describe("shipment identity across webhook formats", () => {
  it.each([false, true])("sends once regardless of which format arrives first (forwarded=%s)", async forwarded => {
    const payload = await seed();
    const withId = { ...payload, eventId: `shipped-${payload.externalPersonId}` };
    expect(await receive(forwarded ? withId : payload)).toEqual({ duplicate: false });
    expect(await receive(forwarded ? payload : withId)).toEqual({ duplicate: true });
    expect(mocks.shipped).toHaveBeenCalledTimes(1);
  });
  it("claims concurrent native and forwarded notifications only once", async () => {
    const payload = await seed();
    const results = await Promise.all([receive(payload), receive({ ...payload, eventId: "forwarded" })]);
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(mocks.shipped).toHaveBeenCalledTimes(1);
  });
  it("allows a new tracking number even when the sender reuses its event ID", async () => {
    const payload = { ...await seed(), eventId: "reused-shipping-id" };
    await receive(payload);
    expect(await receive({ ...payload, trackingNumber: payload.trackingNumber + "NEXT" })).toEqual({ duplicate: false });
    expect(mocks.shipped).toHaveBeenCalledTimes(2);
  });
  it("recognizes prior completed records stored with supplied IDs and normalized tracking", async () => {
    const payload = await seed();
    await db.insert(webhookEventsTable).values({ source: "bask_order_shipped", externalEventId: crypto.randomUUID(), status: "processed", rawPayload: { ...payload, trackingNumber: ` ${payload.trackingNumber.toLowerCase()} ` } });
    expect(await receive(payload)).toEqual({ duplicate: true });
    expect(mocks.shipped).not.toHaveBeenCalled();
  });
  it("does not suppress a different customer's shipment", async () => {
    const one = await seed(), two = await seed();
    await receive(one);
    await receive({ ...two, trackingNumber: one.trackingNumber });
    expect(mocks.shipped).toHaveBeenCalledTimes(2);
  });
  it("allows retry after customer lookup fails before dispatch", async () => {
    const id = crypto.randomUUID();
    const payload = { externalPersonId: id, email: `${id}@example.com`, trackingNumber: `TEST${id}` };
    await expect(receive(payload)).rejects.toThrow("no existing customer");
    expect(mocks.shipped).not.toHaveBeenCalled();
    await db.insert(customersTable).values({ firstName: "Synthetic", lastName: "Retry", email: payload.email, leadReceivedDate: "2026-01-01" });
    expect(await receive({ ...payload, eventId: "different-format" })).toEqual({ duplicate: false });
    expect(mocks.shipped).toHaveBeenCalledTimes(1);
  });
});

import crypto from "crypto";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../../app.js";

const GHL_SECRET = "test-ghl-secret";
const ORDER_SECRET = "test-order-secret";
const QUESTIONNAIRE_SECRET = "test-questionnaire-secret";
const PAYMENT_FAILED_SECRET = "test-payment-failed-secret";
const PRESCRIPTION_WRITTEN_SECRET = "test-prescription-written-secret";
const ORDER_SHIPPED_SECRET = "test-order-shipped-secret";
const IBLUSEND_SECRET = "test-iblusend-secret";

const sendMessageMock = vi.fn();
vi.mock("../../lib/sms-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../../lib/sms-provider.js")>("../../lib/sms-provider.js");
  return { ...actual, getSmsProvider: () => ({ sendMessage: sendMessageMock }) };
});

describe("Webhooks", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.GHL_WEBHOOK_SECRET = GHL_SECRET;
    process.env.ORDER_WEBHOOK_SECRET = ORDER_SECRET;
    process.env.QUESTIONNAIRE_WEBHOOK_SECRET = QUESTIONNAIRE_SECRET;
    process.env.FAILED_PAYMENT_WEBHOOK_SECRET = PAYMENT_FAILED_SECRET;
    process.env.PRESCRIPTION_WRITTEN_WEBHOOK_SECRET = PRESCRIPTION_WRITTEN_SECRET;
    process.env.ORDER_SHIPPED_WEBHOOK_SECRET = ORDER_SHIPPED_SECRET;
    process.env.IBLUSEND_WEBHOOK_SECRET = IBLUSEND_SECRET;
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("Auth", () => {
    it("rejects a missing secret with 401", async () => {
      const res = await request(app).post("/api/webhooks/ghl-lead").send({});
      expect(res.status).toBe(401);
    });

    it("rejects a wrong secret with 401", async () => {
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", "wrong").send({});
      expect(res.status).toBe(401);
    });

    it("returns 500 if the env var itself is unset", async () => {
      const saved = process.env.GHL_WEBHOOK_SECRET;
      delete process.env.GHL_WEBHOOK_SECRET;
      const localApp = createApp();
      const res = await request(localApp).post("/api/webhooks/ghl-lead").set("x-webhook-secret", "anything").send({});
      expect(res.status).toBe(500);
      process.env.GHL_WEBHOOK_SECRET = saved;
    });
  });

  describe("GHL lead", () => {
    it("creates a new customer, and is idempotent on eventId replay", async () => {
      const payload = {
        eventId: "ghl-evt-1",
        contactId: "ghl-contact-1",
        firstName: "Lead",
        lastName: "One",
        email: "lead1@example.com",
        phone: "+12025550111",
        occurredAt: new Date().toISOString(),
      };

      const first = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(first.status).toBe(200);
      expect(first.body.duplicate).toBe(false);

      const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "lead1@example.com"));
      expect(customer).toBeTruthy();
      const [identity] = await db
        .select()
        .from(externalIdentitiesTable)
        .where(eq(externalIdentitiesTable.externalId, "ghl-contact-1"));
      expect(identity.personId).toBe(customer.id);

      // Replay the same eventId — must not create a second customer.
      const replay = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(replay.status).toBe(200);
      expect(replay.body.duplicate).toBe(true);

      const allWithEmail = await db.select().from(customersTable).where(eq(customersTable.email, "lead1@example.com"));
      expect(allWithEmail).toHaveLength(1);
    });

    it("does not match a different real customer whose email merely fits the other one as a SQL wildcard pattern", async () => {
      const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      // Existing customer A. Under a vulnerable ilike() lookup, "_" in a later
      // webhook's email would match ANY single character here, so "john_doe"
      // would incorrectly match "john5doe".
      await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({
          eventId: "ghl-evt-wildcard-a",
          contactId: "ghl-contact-wildcard-a",
          firstName: "Customer",
          lastName: "A",
          email: "john5doe@example.com",
          occurredAt: new Date().toISOString(),
        });

      // A different real customer B, whose email contains a literal "_" that
      // happens to sit exactly where A's email has a "5".
      const resB = await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({
          eventId: "ghl-evt-wildcard-b",
          contactId: "ghl-contact-wildcard-b",
          firstName: "Customer",
          lastName: "B",
          email: "john_doe@example.com",
          occurredAt: new Date().toISOString(),
        });
      expect(resB.status).toBe(200);

      const [customerA] = await db.select().from(customersTable).where(eq(customersTable.email, "john5doe@example.com"));
      const [customerB] = await db.select().from(customersTable).where(eq(customersTable.email, "john_doe@example.com"));
      expect(customerA).toBeTruthy();
      expect(customerB).toBeTruthy();
      expect(customerB.id).not.toBe(customerA.id);

      const [identityB] = await db.select().from(externalIdentitiesTable).where(eq(externalIdentitiesTable.externalId, "ghl-contact-wildcard-b"));
      expect(identityB.personId).toBe(customerB.id);
    });

    it("rejects an invalid payload with 400", async () => {
      const res = await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({ eventId: "bad" }); // missing required fields
      expect(res.status).toBe(400);
    });

    it("persists the payload's leadType onto the created customer", async () => {
      const payload = {
        eventId: "ghl-evt-leadtype",
        contactId: "ghl-contact-leadtype",
        firstName: "Lead",
        lastName: "Typed",
        email: "leadtype@example.com",
        leadType: "web-form",
        occurredAt: new Date().toISOString(),
      };

      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "leadtype@example.com"));
      expect(customer.leadType).toBe("web-form");
    });

    it("defaults occurredAt to now when the source doesn't provide one", async () => {
      const payload = {
        eventId: "ghl-evt-no-timestamp",
        contactId: "ghl-contact-no-timestamp",
        firstName: "No",
        lastName: "Timestamp",
        email: "ghl-no-timestamp@example.com",
        // occurredAt intentionally omitted
      };
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "ghl-no-timestamp@example.com"));
      expect(customer.leadReceivedDate).toBe(new Date().toISOString().slice(0, 10));
    });

    it("fires the meta-lead opener instantly for leadType 'Meta Form Fill'", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_meta_webhook" });

      const payload = {
        eventId: "ghl-evt-meta-1",
        contactId: "ghl-contact-meta-1",
        firstName: "Meta",
        lastName: "Lead",
        email: "meta-lead-webhook@example.com",
        phone: "+15557770000",
        leadType: "Meta Form Fill",
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/ghl-lead").set("x-webhook-secret", GHL_SECRET).send(payload);
      expect(res.status).toBe(200);

      // Wording is randomized (see renderMetaLeadOpener's variants) — "what
      // state you're" is the substring common to all of them.
      expect(sendMessageMock).toHaveBeenCalledWith("+15557770000", expect.stringContaining("what state you're"));

      const { db, customersTable, metaLeadEmailTriggersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "meta-lead-webhook@example.com"));
      const { getOrCreateConversation, listMessages } = await import("../../services/conversations.service.js");
      const conversation = await getOrCreateConversation(customer!.id);
      expect(conversation.leadSource).toBe("meta_form");
      const messages = await listMessages(conversation.id);
      expect(messages.length).toBe(1);

      // The same 4-step email nurture sequence the abandoned-cart flow gets,
      // armed alongside the instant SMS opener above.
      const emailTriggers = await db.select().from(metaLeadEmailTriggersTable).where(eq(metaLeadEmailTriggersTable.personId, customer!.id));
      expect(emailTriggers.map((t) => t.step).sort()).toEqual(["educational", "opener", "plan_comparison", "urgency"]);
    });

    it("matches leadType case-insensitively and does not fire the opener for other lead types", async () => {
      sendMessageMock.mockClear();

      const res = await request(app)
        .post("/api/webhooks/ghl-lead")
        .set("x-webhook-secret", GHL_SECRET)
        .send({
          eventId: "ghl-evt-not-meta",
          contactId: "ghl-contact-not-meta",
          firstName: "Other",
          lastName: "Lead",
          email: "not-meta-lead@example.com",
          leadType: "web-form",
          occurredAt: new Date().toISOString(),
        });
      expect(res.status).toBe(200);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });
  });

  describe("Bask order", () => {
    it("matches an existing customer by external identity and classifies purchases", async () => {
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Order", lastName: "Match", email: "orderer@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-1" });

      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-1",
          externalPersonId: "bask-person-1",
          email: "orderer@example.com",
          orderId: "BASK-1",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
        });
      expect(res.status).toBe(200);

      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(1);
      expect(purchases[0].orderNumber).toBe("BASK-1");
      expect(purchases[0].amountPaid).toBe("199.00");
      expect(purchases[0].purchaseDate).toBe("2026-02-01");
      expect(purchases[0].orderClassification).toBe("first_order");
      expect(purchases[0].orderClassificationSource).toBe("bask");
    });

    it("preserves fields Bask sends that we haven't modeled yet in the stored raw payload", async () => {
      // baskOrderWebhookRequestSchema is .passthrough(), not the default
      // strip-unknown-keys — so a field like this survives into
      // webhook_events.raw_payload instead of being silently dropped before
      // we ever get to see it.
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-passthrough",
          externalPersonId: "bask-person-passthrough",
          email: "passthrough@example.com",
          orderId: "BASK-PASSTHROUGH",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          someBaskFieldNotYetModeled: "xyz",
        });
      expect(res.status).toBe(200);

      const { db, webhookEventsTable } = await import("@luma/db");
      const { eq, and } = await import("drizzle-orm");
      const [event] = await db
        .select()
        .from(webhookEventsTable)
        .where(and(eq(webhookEventsTable.source, "bask_order"), eq(webhookEventsTable.externalEventId, "bask-order-evt-passthrough")));
      expect(event).toBeTruthy();
      expect((event!.rawPayload as Record<string, unknown>).someBaskFieldNotYetModeled).toBe("xyz");
    });

    it("trusts Bask's isFirstTimeOrder=false over our own DB check, even for a customer's first purchase row in our system", async () => {
      // This is the actual bug: a customer who ordered before this webhook
      // existed (or whose earlier order wasn't recorded) has no prior
      // purchase row in our DB, so our own "does an earlier row exist" check
      // says first_order — but Bask knows they're a real repeat customer.
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_bask_says_recurring" });
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-bask-says-recurring",
          externalPersonId: "bask-person-recurring",
          email: "bask-recurring@example.com",
          firstName: "Recurring",
          lastName: "ButNew",
          phone: "+15551110098",
          orderId: "BASK-RECUR-1",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          isFirstTimeOrder: false,
        });
      expect(res.status).toBe(200);

      const { db, customersTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "bask-recurring@example.com"));
      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(1);
      expect(purchases[0].orderClassification).toBe("recurring");
      // Gets the refill notice, not the "your first order!" welcome copy.
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][1]).toContain("refill");
    });

    it("accepts a capitalized Python-style string value (confirmed from a real Zapier payload)", async () => {
      sendMessageMock.mockClear();
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-string-flag",
          externalPersonId: "bask-person-string-flag",
          email: "string-flag@example.com",
          orderId: "BASK-STRING-FLAG",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          isFirstTimeOrder: "False",
        });
      expect(res.status).toBe(200);

      const { db, customersTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "string-flag@example.com"));
      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases[0].orderClassification).toBe("recurring");
    });

    it("falls back to recurring instead of violating the first-order uniqueness constraint when Bask's flag disagrees with our own purchase history", async () => {
      // Edge case: Bask says isFirstTimeOrder=true, but our DB already has an
      // earlier purchase row for this customer (e.g. a mismatched
      // external-identity match). Trusting Bask blindly here would attempt a
      // second "first_order" row and crash on the partial unique index.
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Already", lastName: "HasHistory", email: "already-has-history@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-mismatch" });
      await db.insert(purchasesTable).values({
        customerId: customer!.id,
        purchaseDate: "2026-01-15",
        orderNumber: "BASK-EARLIER",
        productName: "Program",
        amountPaid: "199.00",
        orderClassification: "first_order",
        orderClassificationSource: "bask",
      });

      sendMessageMock.mockClear();
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-mismatch",
          externalPersonId: "bask-person-mismatch",
          email: "already-has-history@example.com",
          phone: "+15551110096",
          orderId: "BASK-MISMATCH",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          isFirstTimeOrder: true,
        });
      expect(res.status).toBe(200);

      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(2);
      expect(purchases.find((p) => p.orderNumber === "BASK-MISMATCH")?.orderClassification).toBe("recurring");
      // No SMS here — not because of the recurring/refill distinction (that
      // now sends its own notice), but because this pre-existing customer
      // was seeded with no phone on file, and findOrCreateCustomerByExternalIdentity
      // doesn't back-fill contact fields onto an already-matched customer
      // from the webhook payload.
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    it("creates a new customer when no match exists", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-2",
          externalPersonId: "bask-person-new",
          email: "neworderer@example.com",
          firstName: "New",
          lastName: "Orderer",
          phone: "+15551110002",
          orderId: "BASK-2",
          productName: "Program",
          amountPaid: "99.00",
          purchasedAt: "2026-02-05T09:00:00.000Z",
        });
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "neworderer@example.com"));
      expect(customer).toBeTruthy();
      expect(customer.phone).toBe("+15551110002");
    });

    it("accepts a formatted-string amountPaid and uses transactionId as ecommerceOrderId when set", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-transaction-id",
          externalPersonId: "bask-person-transaction-id",
          email: "transaction-id@example.com",
          orderId: "BASK-3",
          productName: "Program",
          amountPaid: "149.50",
          purchasedAt: "2026-02-06T09:00:00.000Z",
          transactionId: "txn-abc-123",
        });
      expect(res.status).toBe(200);

      const { db, customersTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "transaction-id@example.com"));
      const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchase.amountPaid).toBe("149.50");
      expect(purchase.ecommerceOrderId).toBe("txn-abc-123");
    });

    it("fires Sophie's order-received opener instantly", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_sophie_opener" });

      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-sophie-opener",
          externalPersonId: "bask-person-sophie-opener",
          email: "sophie-opener@example.com",
          firstName: "Opener",
          lastName: "Test",
          phone: "+15551110099",
          orderId: "BASK-SOPHIE-1",
          productName: "Program",
          amountPaid: 120,
          purchasedAt: "2026-02-07T09:00:00.000Z",
        });
      expect(res.status).toBe(200);

      expect(sendMessageMock).toHaveBeenCalledWith("+15551110099", expect.stringContaining("this is Sophie"));

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "sophie-opener@example.com"));
      const { getOrCreateSupportConversation, listSupportMessages } = await import("../../services/support-conversations.service.js");
      const conversation = await getOrCreateSupportConversation(customer!.id);
      const messages = await listSupportMessages(conversation.id);
      expect(messages.length).toBe(1);
    });

    it("sends the refill notice, not the first-order welcome copy, on a recurring (refill) order for an existing customer", async () => {
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Refill", lastName: "Customer", email: "refill@example.com", leadReceivedDate: "2026-01-01", phone: "+15551110097" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-refill" });

      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_refill_first" });
      const first = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-refill-1",
          externalPersonId: "bask-person-refill",
          email: "refill@example.com",
          orderId: "BASK-REFILL-1",
          productName: "Program",
          amountPaid: 120,
          purchasedAt: "2026-02-09T09:00:00.000Z",
        });
      expect(first.status).toBe(200);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][1]).toContain("this is Sophie");
      expect(sendMessageMock.mock.calls[0][1]).not.toContain("refill");

      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_refill_second" });
      const second = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-refill-2",
          externalPersonId: "bask-person-refill",
          email: "refill@example.com",
          orderId: "BASK-REFILL-2",
          productName: "Program",
          amountPaid: 120,
          purchasedAt: "2026-03-09T09:00:00.000Z",
        });
      expect(second.status).toBe(200);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock.mock.calls[0][1]).toContain("refill");

      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(2);
      expect(purchases.find((p) => p.orderNumber === "BASK-REFILL-1")!.orderClassification).toBe("first_order");
      expect(purchases.find((p) => p.orderNumber === "BASK-REFILL-2")!.orderClassification).toBe("recurring");
    });

    it("clears a previously opted-out customer's DND flag on both channels, so the order-received opener isn't itself blocked", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_sophie_opener_dnd" });

      const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Winback", lastName: "Customer", email: "winback@example.com", leadReceivedDate: "2026-01-01", phone: "+15551110098" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-winback" });

      const { setCustomerSmsDnd, isCustomerSmsDnd, setCustomerEmailDnd, isCustomerEmailDnd } = await import("../../services/dnd.service.js");
      await setCustomerSmsDnd(customer!.id, true);
      await setCustomerEmailDnd(customer!.id, true);
      expect(await isCustomerSmsDnd(customer!.id)).toBe(true);
      expect(await isCustomerEmailDnd(customer!.id)).toBe(true);

      const res = await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-winback",
          externalPersonId: "bask-person-winback",
          email: "winback@example.com",
          orderId: "BASK-WINBACK-1",
          productName: "Program",
          amountPaid: 120,
          purchasedAt: "2026-02-08T09:00:00.000Z",
        });
      expect(res.status).toBe(200);

      expect(await isCustomerSmsDnd(customer!.id)).toBe(false);
      expect(await isCustomerEmailDnd(customer!.id)).toBe(false);
      expect(sendMessageMock).toHaveBeenCalledWith("+15551110098", expect.stringContaining("this is Sophie"));
    });
  });

  describe("Bask prescription written", () => {
    it("creates/matches a customer, marks prescriptionWritten, and sends the notice", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_prescription_written" });

      const res = await request(app)
        .post("/api/webhooks/bask-prescription-written")
        .set("x-webhook-secret", PRESCRIPTION_WRITTEN_SECRET)
        .send({
          eventId: "bask-prescription-evt-1",
          externalPersonId: "bask-patient-1",
          email: "prescription-written@example.com",
          firstName: "Diana",
          lastName: "Gerhold",
          phone: "+13388400375",
          prescriptionId: "6827585384218624",
        });
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "prescription-written@example.com"));
      expect(customer).toBeTruthy();

      const { getOrCreateSupportConversation, listSupportMessages } = await import("../../services/support-conversations.service.js");
      const conversation = await getOrCreateSupportConversation(customer!.id);
      expect(conversation.prescriptionWritten).toBe(true);
      const messages = await listSupportMessages(conversation.id);
      expect(messages.length).toBe(1);
    });

    it("rejects a wrong secret with 401", async () => {
      const res = await request(app).post("/api/webhooks/bask-prescription-written").set("x-webhook-secret", "wrong").send({});
      expect(res.status).toBe(401);
    });

    it("is idempotent on eventId replay", async () => {
      const payload = {
        eventId: "bask-prescription-evt-replay",
        externalPersonId: "bask-patient-replay",
        email: "prescription-replay@example.com",
      };
      const first = await request(app).post("/api/webhooks/bask-prescription-written").set("x-webhook-secret", PRESCRIPTION_WRITTEN_SECRET).send(payload);
      expect(first.body.duplicate).toBe(false);
      const second = await request(app).post("/api/webhooks/bask-prescription-written").set("x-webhook-secret", PRESCRIPTION_WRITTEN_SECRET).send(payload);
      expect(second.body.duplicate).toBe(true);
    });
  });

  describe("Bask order shipped", () => {
    it("matches an existing customer by external identity, sets orderShipped + trackingNumber, sends the notice, and arms the review-request trigger — with only the fields Bask's real event actually sends (no eventId, no email)", async () => {
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_order_shipped" });

      const { db, customersTable, externalIdentitiesTable, reviewRequestTriggersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Jena", lastName: "Abbott", email: "order-shipped@example.com", phone: "+14242650860", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-patient-shipped-1" });

      const res = await request(app)
        .post("/api/webhooks/bask-order-shipped")
        .set("x-webhook-secret", ORDER_SHIPPED_SECRET)
        .send({
          externalPersonId: "bask-patient-shipped-1",
          trackingNumber: "5481040885",
          occurredAt: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      expect(sendMessageMock).toHaveBeenCalledWith("+14242650860", expect.stringContaining("5481040885"));

      const { getOrCreateSupportConversation } = await import("../../services/support-conversations.service.js");
      const conversation = await getOrCreateSupportConversation(customer!.id);
      expect(conversation.orderShipped).toBe(true);
      expect(conversation.trackingNumber).toBe("5481040885");

      const [trigger] = await db.select().from(reviewRequestTriggersTable).where(eq(reviewRequestTriggersTable.personId, customer!.id));
      expect(trigger).toBeDefined();
      expect(trigger.status).toBe("pending");
    });

    it("rejects a payload missing the required trackingNumber with 400", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-order-shipped")
        .set("x-webhook-secret", ORDER_SHIPPED_SECRET)
        .send({ externalPersonId: "bask-patient-bad" });
      expect(res.status).toBe(400);
    });

    it("fails (marks the webhook event failed) when no existing customer matches the externalPersonId", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-order-shipped")
        .set("x-webhook-secret", ORDER_SHIPPED_SECRET)
        .send({ externalPersonId: "bask-patient-never-seen", trackingNumber: "9999999999" });
      expect(res.status).toBe(500);
    });

    it("is idempotent on the synthesized externalPersonId+trackingNumber key when Bask sends no eventId", async () => {
      const { db, customersTable, externalIdentitiesTable } = await import("@luma/db");
      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Replay", lastName: "Test", email: "shipped-replay@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-patient-replay-shipped" });

      const payload = { externalPersonId: "bask-patient-replay-shipped", trackingNumber: "1112223333" };
      const first = await request(app).post("/api/webhooks/bask-order-shipped").set("x-webhook-secret", ORDER_SHIPPED_SECRET).send(payload);
      expect(first.body.duplicate).toBe(false);
      const second = await request(app).post("/api/webhooks/bask-order-shipped").set("x-webhook-secret", ORDER_SHIPPED_SECRET).send(payload);
      expect(second.body.duplicate).toBe(true);
    });
  });

  describe("Bask questionnaire", () => {
    it("upserts questionnaire status idempotently on the same questionnaireId", async () => {
      const payload = {
        eventId: "bask-q-evt-1",
        externalPersonId: "bask-person-q1",
        email: "questionnaire1@example.com",
        firstName: "Q",
        lastName: "One",
        questionnaireId: "QUEST-1",
        status: "started" as const,
        occurredAt: new Date().toISOString(),
      };
      const first = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(first.status).toBe(200);

      const { db, questionnaireEventsTable, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "questionnaire1@example.com"));
      let rows = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("started");

      // Same questionnaireId, different eventId (a second lifecycle event) -> updates the existing row, not a new one.
      const second = await request(app)
        .post("/api/webhooks/bask-questionnaire")
        .set("x-webhook-secret", QUESTIONNAIRE_SECRET)
        .send({ ...payload, eventId: "bask-q-evt-2", status: "abandoned" as const });
      expect(second.status).toBe(200);

      rows = await db.select().from(questionnaireEventsTable).where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("abandoned");
      expect(rows[0].abandonedAt).not.toBeNull();
    });

    it("schedules an abandoned-cart opener trigger on status=abandoned, idempotently on redelivery", async () => {
      const payload = {
        eventId: "bask-q-evt-abandon-trigger-1",
        externalPersonId: "bask-person-abandon-trigger",
        email: "abandon-trigger@example.com",
        firstName: "Trigger",
        lastName: "Test",
        questionnaireId: "QUEST-TRIGGER-1",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const first = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(first.status).toBe(200);

      const { db, customersTable, abandonedCartTriggersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "abandon-trigger@example.com"));
      let triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, customer!.id));
      expect(triggers).toHaveLength(1);
      expect(triggers[0].status).toBe("pending");

      // A retried delivery of the same event is a no-op replay (idempotent on eventId)
      // and doesn't reach the trigger-scheduling code a second time.
      const redelivery = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(redelivery.status).toBe(200);
      expect(redelivery.body.duplicate).toBe(true);

      triggers = await db.select().from(abandonedCartTriggersTable).where(eq(abandonedCartTriggersTable.personId, customer!.id));
      expect(triggers).toHaveLength(1);
    });

    it("categorizes a customer created directly from an abandoned questionnaire (no prior GHL lead)", async () => {
      const payload = {
        eventId: "bask-q-evt-abandoned-only",
        externalPersonId: "bask-person-abandoned-only",
        email: "abandoned-cart@example.com",
        firstName: "Cart",
        lastName: "Abandoner",
        questionnaireId: "QUEST-2",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "abandoned-cart@example.com"));
      expect(customer.leadType).toBe("Bask abandoned cart");
    });

    it("persists the payload's phone onto the created customer", async () => {
      const payload = {
        eventId: "bask-q-evt-phone",
        externalPersonId: "bask-person-phone",
        email: "phone-test@example.com",
        firstName: "Phone",
        lastName: "Tester",
        phone: "+15551234567",
        questionnaireId: "QUEST-3",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "phone-test@example.com"));
      expect(customer.phone).toBe("+15551234567");
    });

    it("normalizes an unformatted phone number to E.164 on the created customer", async () => {
      const payload = {
        eventId: "bask-q-evt-phone-unformatted",
        externalPersonId: "bask-person-phone-unformatted",
        email: "phone-unformatted-test@example.com",
        firstName: "Phone",
        lastName: "Tester",
        phone: "(555) 123-9999",
        questionnaireId: "QUEST-3-unformatted",
        status: "abandoned" as const,
        occurredAt: new Date().toISOString(),
      };
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "phone-unformatted-test@example.com"));
      expect(customer.phone).toBe("+15551239999");
    });

    it("defaults occurredAt to now when the source doesn't provide one", async () => {
      const payload = {
        eventId: "bask-q-evt-no-timestamp",
        externalPersonId: "bask-person-no-timestamp",
        email: "no-timestamp@example.com",
        questionnaireId: "QUEST-4",
        status: "abandoned" as const,
        // occurredAt intentionally omitted
      };
      const before = Date.now();
      const res = await request(app).post("/api/webhooks/bask-questionnaire").set("x-webhook-secret", QUESTIONNAIRE_SECRET).send(payload);
      expect(res.status).toBe(200);

      const { db, customersTable, questionnaireEventsTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "no-timestamp@example.com"));
      const [event] = await db
        .select()
        .from(questionnaireEventsTable)
        .where(eq(questionnaireEventsTable.personId, customer!.id));
      expect(event.lastEventAt!.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("Bask payment-failed", () => {
    it("records the event, linking to a matched customer when found", async () => {
      const { db, customersTable, externalIdentitiesTable, failedPaymentEventsTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Fail", lastName: "Payment", email: "failpay@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-fp1" });

      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-1",
          transactionId: "txn-1",
          externalPersonId: "bask-person-fp1",
          amount: "49.99",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const rows = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.transactionId, "txn-1"));
      expect(rows).toHaveLength(1);
      expect(rows[0].personId).toBe(customer!.id);
    });

    it("records the event with a null personId when no customer can be matched, without creating one", async () => {
      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-2",
          transactionId: "txn-2",
          externalPersonId: "bask-person-unknown",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const { db, failedPaymentEventsTable, externalIdentitiesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(failedPaymentEventsTable).where(eq(failedPaymentEventsTable.transactionId, "txn-2"));
      expect(row.personId).toBeNull();

      // No customer/identity should have been created for the unmatched externalPersonId.
      const identities = await db
        .select()
        .from(externalIdentitiesTable)
        .where(eq(externalIdentitiesTable.externalId, "bask-person-unknown"));
      expect(identities).toHaveLength(0);
    });

    it("corrects a first order's purchase status off completed and sends the first-order copy, not the recurring one", async () => {
      const { db, customersTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      // handleBaskOrderWebhook already sent "we received your order" and
      // marked the purchase completed — this is the payment-failed webhook
      // Bask fires afterward for the same transaction.
      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_order_received" });
      await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-fp-first",
          externalPersonId: "bask-person-fp-first",
          email: "fp-first@example.com",
          firstName: "First",
          lastName: "Order",
          phone: "+15551110100",
          orderId: "BASK-FP-FIRST",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          transactionId: "txn-fp-first",
        });

      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_payment_failed" });
      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-first",
          transactionId: "txn-fp-first",
          externalPersonId: "bask-person-fp-first",
          amount: "199.00",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const [customer] = await db.select().from(customersTable).where(eq(customersTable.email, "fp-first@example.com"));
      const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchase.status).toBe("payment_failed");

      expect(sendMessageMock).toHaveBeenCalledWith("+15551110100", expect.stringContaining("Reply here"));
      expect(sendMessageMock).toHaveBeenCalledWith("+15551110100", expect.not.stringContaining("still interested"));

      const { supportConversationsTable } = await import("@luma/db");
      const [conversation] = await db.select().from(supportConversationsTable).where(eq(supportConversationsTable.personId, customer!.id));
      expect(conversation.paymentFailed).toBe(true);
      expect(conversation.paymentFailedAt).toBeTruthy();
      expect(conversation.needsAttention).toBe(true);
    });

    it("sends the recurring copy, asking if they still want the refill, for a recurring order's payment failure", async () => {
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "Refill", lastName: "Customer", email: "fp-recurring@example.com", phone: "+15551110101", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-fp-recurring" });
      // Existing purchase history so the next order webhook classifies as recurring.
      await db.insert(purchasesTable).values({
        customerId: customer!.id,
        purchaseDate: "2026-01-01",
        orderNumber: "BASK-FP-RECUR-EARLIER",
        productName: "Program",
        amountPaid: "199.00",
        orderClassification: "first_order",
        orderClassificationSource: "manual",
      });

      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_refill_notice_before_failure" });
      await request(app)
        .post("/api/webhooks/bask-order")
        .set("x-webhook-secret", ORDER_SECRET)
        .send({
          eventId: "bask-order-evt-fp-recurring",
          externalPersonId: "bask-person-fp-recurring",
          email: "fp-recurring@example.com",
          orderId: "BASK-FP-RECUR",
          productName: "Program",
          amountPaid: 199,
          purchasedAt: "2026-02-01T10:00:00.000Z",
          transactionId: "txn-fp-recurring",
        });

      sendMessageMock.mockClear();
      sendMessageMock.mockResolvedValueOnce({ providerMessageId: "msg_payment_failed_recurring" });
      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-recurring",
          transactionId: "txn-fp-recurring",
          externalPersonId: "bask-person-fp-recurring",
          amount: "199.00",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const [failedPurchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.orderNumber, "BASK-FP-RECUR"));
      expect(failedPurchase.status).toBe("payment_failed");

      expect(sendMessageMock).toHaveBeenCalledWith("+15551110101", expect.stringMatching(/still interested/i));
      expect(sendMessageMock).toHaveBeenCalledWith("+15551110101", expect.stringContaining("refill"));
    });

    it("leaves the purchase status untouched and does not crash when no matching purchase is found", async () => {
      const { db, customersTable, externalIdentitiesTable, purchasesTable } = await import("@luma/db");
      const { eq } = await import("drizzle-orm");

      const [customer] = await db
        .insert(customersTable)
        .values({ firstName: "No", lastName: "MatchingPurchase", email: "fp-nomatch@example.com", leadReceivedDate: "2026-01-01" })
        .returning();
      await db.insert(externalIdentitiesTable).values({ personId: customer!.id, system: "bask", externalId: "bask-person-fp-nomatch" });

      sendMessageMock.mockClear();
      const res = await request(app)
        .post("/api/webhooks/bask-payment-failed")
        .set("x-webhook-secret", PAYMENT_FAILED_SECRET)
        .send({
          eventId: "bask-fp-evt-nomatch",
          transactionId: "txn-fp-nomatch-does-not-exist",
          externalPersonId: "bask-person-fp-nomatch",
          amount: "49.99",
          failureDate: new Date().toISOString(),
        });
      expect(res.status).toBe(200);

      const purchases = await db.select().from(purchasesTable).where(eq(purchasesTable.customerId, customer!.id));
      expect(purchases).toHaveLength(0);
      expect(sendMessageMock).not.toHaveBeenCalled();
    });
  });

  describe("iBluSend message webhook", () => {
    function signedRequest(payload: unknown) {
      const raw = JSON.stringify(payload);
      const signature = "sha256=" + crypto.createHmac("sha256", IBLUSEND_SECRET).update(raw).digest("hex");
      return request(app)
        .post("/api/webhooks/iblusend-message")
        .set("Content-Type", "application/json")
        .set("X-iBluSend-Signature", signature)
        .send(raw);
    }

    function envelope(overrides: { event?: string; data?: Record<string, unknown> } = {}) {
      return {
        event: overrides.event ?? "message.received",
        event_id: crypto.randomUUID(),
        timestamp: "2026-08-17T12:00:00.000Z",
        api_version: "2026-03-07",
        data: {
          message_id: crypto.randomUUID(),
          phone_number: "+15559990000",
          content: "hi",
          direction: "incoming",
          service_type: "iMessage",
          ...overrides.data,
        },
      };
    }

    it("rejects a missing signature with 401", async () => {
      const res = await request(app).post("/api/webhooks/iblusend-message").send(envelope());
      expect(res.status).toBe(401);
    });

    it("rejects a wrong signature with 401", async () => {
      const res = await request(app)
        .post("/api/webhooks/iblusend-message")
        .set("X-iBluSend-Signature", "sha256=" + "0".repeat(64))
        .send(envelope());
      expect(res.status).toBe(401);
    });

    it("returns 500 if the env var itself is unset", async () => {
      const saved = process.env.IBLUSEND_WEBHOOK_SECRET;
      delete process.env.IBLUSEND_WEBHOOK_SECRET;
      const localApp = createApp();
      const res = await request(localApp).post("/api/webhooks/iblusend-message").send(envelope());
      expect(res.status).toBe(500);
      process.env.IBLUSEND_WEBHOOK_SECRET = saved;
    });

    it("accepts a correctly signed payload and acknowledges an event type it doesn't act on", async () => {
      const res = await signedRequest(envelope({ event: "message.delivered", data: { status: "delivered" } }));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, duplicate: false });
    });

    it("rejects a malformed payload with 400 even when correctly signed", async () => {
      const res = await signedRequest({ not: "a valid envelope" });
      expect(res.status).toBe(400);
    });

    it("reports a repeated event_id as a duplicate on the second delivery", async () => {
      const payload = envelope({ event: "message.delivered", data: { status: "delivered" } });
      const raw = JSON.stringify(payload);
      const signature = "sha256=" + crypto.createHmac("sha256", IBLUSEND_SECRET).update(raw).digest("hex");

      const first = await request(app)
        .post("/api/webhooks/iblusend-message")
        .set("Content-Type", "application/json")
        .set("X-iBluSend-Signature", signature)
        .send(raw);
      const second = await request(app)
        .post("/api/webhooks/iblusend-message")
        .set("Content-Type", "application/json")
        .set("X-iBluSend-Signature", signature)
        .send(raw);

      expect(first.body).toEqual({ ok: true, duplicate: false });
      expect(second.body).toEqual({ ok: true, duplicate: true });
    });
  });
});

describe("recordWebhookEventIfNew idempotency claim", () => {
  it("claims a genuinely new event", async () => {
    const { recordWebhookEventIfNew } = await import("../../services/webhooks.service.js");
    const claimed = await recordWebhookEventIfNew("ghl_lead", `claim-new-${crypto.randomUUID()}`, { a: 1 });
    expect(claimed).not.toBeNull();
  });

  it("does not reclaim an event still in-flight (status=received, recent)", async () => {
    const { recordWebhookEventIfNew } = await import("../../services/webhooks.service.js");
    const eventId = `claim-inflight-${crypto.randomUUID()}`;
    const first = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(first).not.toBeNull();

    // A concurrent/duplicate delivery of the same event while the first is
    // still (nominally) being processed must not be reprocessed too.
    const second = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(second).toBeNull();
  });

  it("does not reclaim an already-processed event", async () => {
    const { recordWebhookEventIfNew, markWebhookEventProcessed } = await import("../../services/webhooks.service.js");
    const eventId = `claim-processed-${crypto.randomUUID()}`;
    const first = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(first).not.toBeNull();
    await markWebhookEventProcessed(first!.id);

    const replay = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(replay).toBeNull();
  });

  it("reclaims an event whose previous attempt failed, instead of silently treating the retry as a duplicate", async () => {
    const { recordWebhookEventIfNew, markWebhookEventFailed } = await import("../../services/webhooks.service.js");
    const { db, webhookEventsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const eventId = `claim-failed-${crypto.randomUUID()}`;

    const first = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(first).not.toBeNull();
    await markWebhookEventFailed(first!.id, "transient DB timeout");

    // Sender retries the same event after the transient failure.
    const retry = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 2 });
    expect(retry).not.toBeNull();
    expect(retry!.id).toBe(first!.id);

    const [row] = await db.select().from(webhookEventsTable).where(eq(webhookEventsTable.id, first!.id));
    expect(row.status).toBe("received");
    expect(row.errorMessage).toBeNull();
    expect(row.rawPayload).toEqual({ a: 2 });
  });

  it("reclaims a stuck event: status=received but received long enough ago to imply a crashed process", async () => {
    const { recordWebhookEventIfNew } = await import("../../services/webhooks.service.js");
    const { db, webhookEventsTable } = await import("@luma/db");
    const { eq } = await import("drizzle-orm");
    const eventId = `claim-stale-received-${crypto.randomUUID()}`;

    const first = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(first).not.toBeNull();
    await db.update(webhookEventsTable).set({ receivedAt: new Date(Date.now() - 10 * 60 * 1000) }).where(eq(webhookEventsTable.id, first!.id));

    const retry = await recordWebhookEventIfNew("ghl_lead", eventId, { a: 1 });
    expect(retry).not.toBeNull();
    expect(retry!.id).toBe(first!.id);
  });
});

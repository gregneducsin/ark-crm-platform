import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { createApp } from "../app.js";
import { signUnsubscribeToken } from "../lib/email/unsubscribe.js";
import { isCustomerEmailDnd } from "../services/dnd.service.js";

describe("Email unsubscribe (/unsubscribe/:token)", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-secret";
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function seedCustomer(): Promise<string> {
    const [row] = await db
      .insert(customersTable)
      .values({ firstName: "Unsub", lastName: "Test", email: `unsub-route-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });
    return row.id;
  }

  it("GET with a valid token sets DND and shows a confirmation page", async () => {
    const personId = await seedCustomer();
    const token = signUnsubscribeToken(personId);

    const res = await request(app).get(`/unsubscribe/${token}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("unsubscribed");
    expect(await isCustomerEmailDnd(personId)).toBe(true);
  });

  it("GET with an invalid token does not set DND", async () => {
    const res = await request(app).get("/unsubscribe/not-a-real-token");
    expect(res.status).toBe(400);
  });

  it("POST with a valid token sets DND with no body — the RFC 8058 one-click path Gmail/Yahoo/Outlook use instead of following the link", async () => {
    const personId = await seedCustomer();
    const token = signUnsubscribeToken(personId);

    const res = await request(app).post(`/unsubscribe/${token}`).send("List-Unsubscribe=One-Click").type("application/x-www-form-urlencoded");
    expect(res.status).toBe(200);
    expect(await isCustomerEmailDnd(personId)).toBe(true);
  });

  it("POST with an invalid token does not set DND", async () => {
    const res = await request(app).post("/unsubscribe/not-a-real-token");
    expect(res.status).toBe(400);
  });
});

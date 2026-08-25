import { describe, expect, it, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db, customersTable } from "@luma/db";
import { createApp } from "../app.js";

describe("Intake links redirect (/go/:token)", () => {
  let app: ReturnType<typeof createApp>;
  const originalEnv = { ...process.env };

  beforeAll(() => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
    app = createApp();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("redirects a valid token to the Bask questionnaire URL, no auth required", async () => {
    const { createIntakeLink } = await import("../services/intake-links.service.js");
    const [customer] = await db
      .insert(customersTable)
      .values({ firstName: "Route", lastName: "Test", email: `route-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
      .returning({ id: customersTable.id });

    const { url } = await createIntakeLink(customer.id);
    const rawToken = url.split("/go/")[1];

    const res = await request(app).get(`/go/${rawToken}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://bask.example.com/questionnaire");
  });

  it("redirects an unknown token too, rather than erroring", async () => {
    const res = await request(app).get("/go/not-a-real-token");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://bask.example.com/questionnaire");
  });

  it("returns 500 with a clear error when BASK_QUESTIONNAIRE_URL isn't configured", async () => {
    const saved = process.env.BASK_QUESTIONNAIRE_URL;
    delete process.env.BASK_QUESTIONNAIRE_URL;
    const localApp = createApp();
    const res = await request(localApp).get("/go/anything");
    expect(res.status).toBe(500);
    process.env.BASK_QUESTIONNAIRE_URL = saved;
  });
});

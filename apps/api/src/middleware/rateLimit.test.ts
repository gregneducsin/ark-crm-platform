import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createGeneralLimiter, createAuthAccountLimiter } from "./rateLimit.js";

function buildApp() {
  const app = express();
  app.use(createGeneralLimiter());
  app.get("/api/app/auth/csrf-token", (_req, res) => res.json({ ok: true }));
  app.get("/api/app/auth/me", (_req, res) => res.json({ ok: true }));
  app.get("/api/app/customers", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("createGeneralLimiter", () => {
  it("never 429s the CSRF-token or session-check routes, even well past the old 300-request budget — login must stay reachable no matter how much other traffic shares the IP", async () => {
    const app = buildApp();
    // 350 exceeds the old 300 limit specifically to prove these two routes
    // are exempt, not just under a raised ceiling.
    for (let i = 0; i < 350; i++) {
      const csrfRes = await request(app).get("/api/app/auth/csrf-token");
      expect(csrfRes.status).toBe(200);
    }
    const meRes = await request(app).get("/api/app/auth/me");
    expect(meRes.status).toBe(200);
  }, 30_000);

  it("still rate-limits an ordinary route", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/app/customers");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });
});

describe("createAuthAccountLimiter", () => {
  // Keyed by the attempted email, not IP — proves an attacker spreading
  // login guesses for one account across many source IPs still trips it,
  // which the pre-existing per-IP limiter alone could never catch.
  it("budgets attempts per attempted email, independent of source IP", async () => {
    const app = express();
    app.use(express.json());
    app.use(createAuthAccountLimiter());
    app.post("/api/app/auth/login", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 20; i++) {
      const res = await request(app)
        .post("/api/app/auth/login")
        .set("X-Forwarded-For", `10.0.0.${i}`)
        .send({ email: "victim@example.com", password: "wrong" });
      expect(res.status).toBe(200);
    }

    const blocked = await request(app)
      .post("/api/app/auth/login")
      .set("X-Forwarded-For", "10.0.0.99")
      .send({ email: "victim@example.com", password: "wrong" });
    expect(blocked.status).toBe(429);

    // A different account, even from an IP already used above, has its own
    // untouched budget — this limiter tracks accounts, not IPs.
    const otherAccount = await request(app)
      .post("/api/app/auth/login")
      .set("X-Forwarded-For", "10.0.0.0")
      .send({ email: "someone-else@example.com", password: "wrong" });
    expect(otherAccount.status).toBe(200);
  });
});

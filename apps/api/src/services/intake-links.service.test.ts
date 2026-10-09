import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { db, customersTable, intakeLinkTokensTable, followUpJobsTable, questionnaireEventsTable, purchasesTable } from "@luma/db";
import { hashToken } from "../lib/crypto.js";
import { eq } from "drizzle-orm";

const originalEnv = { ...process.env };

async function seedCustomer(): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({
      firstName: "Test",
      lastName: "Lead",
      email: `lead-${crypto.randomUUID()}@example.com`,
      leadReceivedDate: "2026-08-15",
    })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("intake-links.service", () => {
  beforeAll(() => {
    process.env.INTAKE_LINK_BASE_URL = "http://localhost:3000";
    process.env.BASK_QUESTIONNAIRE_URL = "https://bask.example.com/questionnaire";
    process.env.BASK_QUESTIONNAIRE_PROMO_URL = "https://bask.example.com/questionnaire?promo=Get20";
  });

  afterEach(() => {
    process.env = {
      ...originalEnv,
      INTAKE_LINK_BASE_URL: "http://localhost:3000",
      BASK_QUESTIONNAIRE_URL: "https://bask.example.com/questionnaire",
      BASK_QUESTIONNAIRE_PROMO_URL: "https://bask.example.com/questionnaire?promo=Get20",
    };
  });

  it.each(["submission", "purchase"])("does not arm reminders when a customer clicks after %s", async (completion) => {
    const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
    const personId = await seedCustomer();
    const { url } = await createIntakeLink(personId);
    if (completion === "submission") await db.insert(questionnaireEventsTable).values({
      personId, questionnaireId: crypto.randomUUID(), status: "submitted", lastEventAt: new Date() });
    else await db.insert(purchasesTable).values({ customerId: personId, purchaseDate: "2026-09-27",
      orderNumber: crypto.randomUUID(), productName: "Synthetic", amountPaid: "1.00", status: "completed" });
    const result = await handleIntakeLinkClick(url.split("/go/")[1]);
    expect(result.redirectUrl).toBe("https://bask.example.com/questionnaire");
    expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId))).toHaveLength(0);
  });

  describe("createIntakeLink", () => {
    it("mints a link whose token is stored only as a hash, not the raw value", async () => {
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url, expiresAt } = await createIntakeLink(personId);

      expect(url.startsWith("http://localhost:3000/go/")).toBe(true);
      const rawToken = url.split("/go/")[1];

      const [row] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(row).toBeDefined();
      expect(row.tokenHash).toBe(hashToken(rawToken));
      expect(row.tokenHash).not.toBe(rawToken);
      expect(row.clickedAt).toBeNull();
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("throws a clear error when INTAKE_LINK_BASE_URL isn't configured", async () => {
      delete process.env.INTAKE_LINK_BASE_URL;
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      await expect(createIntakeLink(personId)).rejects.toThrow(/INTAKE_LINK_BASE_URL/);
    });

    it("defaults to the plain (no-promo) variant", async () => {
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      await createIntakeLink(personId);
      const [row] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(row.promoApplied).toBe("none");
    });

    it("stores the promo variant when requested", async () => {
      const { createIntakeLink } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      await createIntakeLink(personId, "first_month_20");
      const [row] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(row.promoApplied).toBe("first_month_20");
    });

    it("defaults leadSource to abandoned_cart, and stores it when a caller passes meta_form", async () => {
      const { createIntakeLink } = await import("./intake-links.service.js");
      const defaultPersonId = await seedCustomer();
      await createIntakeLink(defaultPersonId);
      const [defaultRow] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, defaultPersonId));
      expect(defaultRow.leadSource).toBe("abandoned_cart");

      const metaPersonId = await seedCustomer();
      await createIntakeLink(metaPersonId, "first_month_20", "meta_form");
      const [metaRow] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, metaPersonId));
      expect(metaRow.leadSource).toBe("meta_form");
    });
  });

  describe("handleIntakeLinkClick", () => {
    it("first click redirects to the Bask URL and arms a follow-up job due ~2 hours later, clamped to the 9am-11:59pm Eastern send window", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const { clampToSendWindow } = await import("../lib/send-window.js");
      const personId = await seedCustomer();
      const { url } = await createIntakeLink(personId);
      const rawToken = url.split("/go/")[1];

      const beforeClick = Date.now();
      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const [token] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
      expect(token.clickedAt).not.toBeNull();

      const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(job).toBeDefined();
      expect(job.status).toBe("pending");
      expect(job.messageStep).toBe("provider_check_in");
      // A naive "clicked + 2 hours" can land in the overnight quiet-hours
      // window (see send-window.ts) and get pushed to 9am Eastern instead —
      // computing the same expected value here, rather than asserting a
      // fixed ~2-hour delta, keeps this test correct regardless of what time
      // of day it happens to run.
      const expectedDueAt = clampToSendWindow(new Date(beforeClick + 2 * 60 * 60 * 1000));
      expect(Math.abs(new Date(job.dueAt).getTime() - expectedDueAt.getTime())).toBeLessThan(5000);
    });

    it("a second click on the same link redirects but does not arm a second follow-up job", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url } = await createIntakeLink(personId);
      const rawToken = url.split("/go/")[1];

      await handleIntakeLinkClick(rawToken);
      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(jobs.length).toBe(1);
    });

    describe("magic resume link destination", () => {
      const MAGIC = "https://bask.example.com/resume?token=magic-abc";

      it("redirects to the magic link, counts the click, and arms the same follow-up job", async () => {
        const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
        const personId = await seedCustomer();
        const { url } = await createIntakeLink(personId, "none", "abandoned_cart", { destinationUrl: MAGIC });
        expect(url).toMatch(/^http:\/\/localhost:3000\/go\/[^/]+$/);
        const { redirectUrl } = await handleIntakeLinkClick(url.split("/go/")[1]);
        expect(redirectUrl).toBe(MAGIC);
        const [token] = await db.select().from(intakeLinkTokensTable).where(eq(intakeLinkTokensTable.personId, personId));
        expect(token.clickedAt).not.toBeNull();
        expect(token.destinationUrl).toBe(MAGIC);
        const [job] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
        expect(job.messageStep).toBe("provider_check_in");
      });

      it("stays live for a week, not a day, so a text read days later still tracks the click", async () => {
        const { createIntakeLink } = await import("./intake-links.service.js");
        const personId = await seedCustomer();
        const { expiresAt } = await createIntakeLink(personId, "none", "abandoned_cart", { destinationUrl: MAGIC });
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600_000);
      });

      it("still lands on the magic link after the tracking window, without arming a follow-up", async () => {
        const { handleIntakeLinkClick } = await import("./intake-links.service.js");
        const personId = await seedCustomer();
        const rawToken = "expired-magic-token";
        await db.insert(intakeLinkTokensTable).values({ personId, tokenHash: hashToken(rawToken), destinationUrl: MAGIC, expiresAt: new Date(Date.now() - 1000) });
        const { redirectUrl } = await handleIntakeLinkClick(rawToken);
        expect(redirectUrl).toBe(MAGIC);
        expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId))).toHaveLength(0);
      });

      it("does not arm a follow-up when the patient already finished", async () => {
        const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
        const personId = await seedCustomer();
        await db.insert(questionnaireEventsTable).values({ personId, questionnaireId: crypto.randomUUID(), status: "submitted", lastEventAt: new Date() });
        const { url } = await createIntakeLink(personId, "none", "abandoned_cart", { destinationUrl: MAGIC });
        expect((await handleIntakeLinkClick(url.split("/go/")[1])).redirectUrl).toBe(MAGIC);
        expect(await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId))).toHaveLength(0);
      });
    });

    it("an unknown token still redirects, without creating a follow-up job", async () => {
      const { handleIntakeLinkClick } = await import("./intake-links.service.js");
      const { redirectUrl } = await handleIntakeLinkClick("this-token-does-not-exist");
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");
    });

    it("an expired token still redirects, without arming a follow-up job", async () => {
      const { handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const rawToken = "expired-test-token";
      await db.insert(intakeLinkTokensTable).values({
        personId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() - 1000),
      });

      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");

      const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(jobs.length).toBe(0);
    });

    it("an expired promo link falls back to the plain URL, not the promo one", async () => {
      const { handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const rawToken = "expired-promo-test-token";
      await db.insert(intakeLinkTokensTable).values({
        personId,
        tokenHash: hashToken(rawToken),
        promoApplied: "first_month_20",
        expiresAt: new Date(Date.now() - 1000),
      });

      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire");
    });

    it("redirects to the promo URL when the link was minted with the promo variant", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const { url } = await createIntakeLink(personId, "first_month_20");
      const rawToken = url.split("/go/")[1];

      const { redirectUrl } = await handleIntakeLinkClick(rawToken);
      expect(redirectUrl).toBe("https://bask.example.com/questionnaire?promo=Get20");
    });

    it("clicking a newer link cancels a still-pending follow-up job from an earlier click, so the same person isn't left on two parallel nudge chains", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();

      const first = await createIntakeLink(personId);
      await handleIntakeLinkClick(first.url.split("/go/")[1]);
      const [firstJob] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(firstJob.status).toBe("pending");

      const second = await createIntakeLink(personId);
      await handleIntakeLinkClick(second.url.split("/go/")[1]);

      const jobs = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, personId));
      expect(jobs).toHaveLength(2);
      const resolvedFirstJob = jobs.find((j) => j.id === firstJob.id);
      expect(resolvedFirstJob?.status).toBe("cancelled");
      expect(resolvedFirstJob?.cancelledReason).toBe("superseded_by_newer_click");
      const newJob = jobs.find((j) => j.id !== firstJob.id);
      expect(newJob?.status).toBe("pending");
    });

    it("does not touch another person's pending follow-up job", async () => {
      const { createIntakeLink, handleIntakeLinkClick } = await import("./intake-links.service.js");
      const personId = await seedCustomer();
      const otherPersonId = await seedCustomer();

      const otherLink = await createIntakeLink(otherPersonId);
      await handleIntakeLinkClick(otherLink.url.split("/go/")[1]);
      const [otherJob] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.personId, otherPersonId));

      const link = await createIntakeLink(personId);
      await handleIntakeLinkClick(link.url.split("/go/")[1]);

      const [stillPending] = await db.select().from(followUpJobsTable).where(eq(followUpJobsTable.id, otherJob.id));
      expect(stillPending.status).toBe("pending");
    });
  });
});

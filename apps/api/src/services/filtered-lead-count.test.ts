import { describe, expect, it } from "vitest";
import { db, customersTable, externalIdentitiesTable } from "@luma/db";
import { eq } from "drizzle-orm";
import { customersSummaryQuerySchema } from "@luma/shared";
import { getFilteredLeadCount } from "./filtered-lead-count.service.js";

describe("filtered lead counts", () => {
  it("counts exact types beyond one page and separates first-touch sources from type labels", async () => {
    const ids: string[] = [];
    const query = customersSummaryQuerySchema.parse({ period: 1, dateFrom: "2041-01-01", dateTo: "2041-01-02" });
    try {
      for (let i = 0; i < 14; i++) {
        const [row] = await db.insert(customersTable).values({
          firstName: "Synthetic", lastName: "Segment", email: crypto.randomUUID() + "@example.com",
          leadReceivedDate: i === 13 ? "2040-12-31" : i === 12 ? "2041-01-02" : "2041-01-01",
          leadType: i === 12 ? "DTC" : "SMS Inquiry",
        }).returning();
        ids.push(row.id);
        if (i < 2) {
          await db.insert(externalIdentitiesTable).values([
            { personId: row.id, system: i === 0 ? "ghl" : "bask", externalId: crypto.randomUUID(), createdAt: new Date("2041-01-01T00:00:00Z") },
            { personId: row.id, system: i === 0 ? "bask" : "ghl", externalId: crypto.randomUUID(), createdAt: new Date("2041-01-02T00:00:00Z") },
          ]);
        }
      }
      expect((await getFilteredLeadCount(query, "sms_inquiry")).total).toBe(12);
      expect((await getFilteredLeadCount(query, "meta_form_fill")).total).toBe(1);
      expect((await getFilteredLeadCount(query, "questionnaire")).total).toBe(1);
      expect((await getFilteredLeadCount(query, "lead_type", "DTC")).total).toBe(1);
      expect((await getFilteredLeadCount(query, "lead_type", "Nonexistent synthetic label")).total).toBe(0);
      expect((await getFilteredLeadCount(query, "sms_inquiry")).dateFrom).toBe("2041-01-01");
      await expect(getFilteredLeadCount(query, "lead_type")).rejects.toThrow("exact saved lead type");
    } finally { for (const id of ids) await db.delete(customersTable).where(eq(customersTable.id, id)); }
  });
});

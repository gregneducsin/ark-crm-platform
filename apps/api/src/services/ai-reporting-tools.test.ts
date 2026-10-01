import { afterEach, describe, expect, it, vi } from "vitest";
import { db, customersTable, purchasesTable, unmatchedSmsThreadsTable, unmatchedSmsMessagesTable } from "@luma/db";
import { askAssistant } from "./ai-assistant.service.js";

const mock = vi.hoisted(() => ({ runner: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class { beta = { messages: { toolRunner: mock.runner } }; } }));
vi.mock("@anthropic-ai/sdk/helpers/beta/zod", () => ({ betaZodTool: (config: unknown) => config }));
afterEach(() => { vi.unstubAllEnvs(); mock.runner.mockReset(); });

describe("assistant reporting tool wiring", () => {
  it("executes the registered read-only tools and returns real aggregates", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-not-a-real-key");
    const [customer] = await db.insert(customersTable).values({
      firstName: "Synthetic", lastName: "Reporting", email: crypto.randomUUID() + "@example.com",
      leadType: "DTC", leadReceivedDate: "2044-03-02",
    }).returning();
    await db.insert(purchasesTable).values({
      customerId: customer.id, purchaseDate: "2044-04-01", orderNumber: crypto.randomUUID(),
      productName: "Synthetic", amountPaid: "169", status: "completed", orderClassification: "first_order",
    });
    const [thread] = await db.insert(unmatchedSmsThreadsTable).values({ fromPhone: "synthetic-" + crypto.randomUUID(), onboardingHeld: true }).returning();
    await db.insert(unmatchedSmsMessagesTable).values({
      threadId: thread.id, direction: "inbound", body: "Synthetic onboarding",
      createdAt: new Date("2044-03-02T12:00:00Z"),
    });
    mock.runner.mockImplementation(async ({ tools, system }) => {
      const invoke = async (name: string, input: unknown) => {
        const tool = tools.find((t: { name: string }) => t.name === name);
        expect(tool).toBeDefined();
        return JSON.parse(await tool.run(tool.inputSchema.parse(input)));
      };
      const dates = { dateFrom: "2044-03-01", dateTo: "2044-03-03" };
      expect(await invoke("get_dtc_lead_count", dates)).toMatchObject({ total: 1, purchased: 1, conversionRate: 100 });
      expect(await invoke("get_filtered_lead_count", { ...dates, segment: "lead_type", leadType: "DTC" })).toMatchObject({ total: 1 });
      expect(await invoke("list_lead_types", {})).toContain("DTC");
      expect(await invoke("get_incomplete_onboarding_count", dates)).toMatchObject({ total: 1, needsReview: 1, held: 1 });
      await expect(invoke("get_dtc_lead_count", { dateFrom: "2044-03-03", dateTo: "2044-03-01" })).rejects.toThrow();
      await expect(invoke("get_filtered_lead_count", { ...dates, segment: "lead_type" })).rejects.toThrow(/exact saved lead type/);
      expect(system).toContain("Ark Health");
      expect(system).toContain("not purchases made in the range");
      expect(system).toContain("unmatched texters");
      return { content: [{ type: "text", text: "Synthetic verified result" }] };
    });
    expect(await askAssistant("Count saved DTC leads, conversion, and incomplete onboarding.")).toBe("Synthetic verified result");
    expect(mock.runner).toHaveBeenCalledOnce();
  });
});

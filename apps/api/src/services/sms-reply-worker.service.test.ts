import { afterEach, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db, customersTable, smsReplyWorkTable } from "@luma/db";

const mocks = vi.hoisted(() => ({ sales: vi.fn(), support: vi.fn() }));
vi.mock("./alexis-dispatch.service.js", () => ({ resumeAlexisSms: mocks.sales }));
vi.mock("./sophie-dispatch.service.js", () => ({ resumeSophieSms: mocks.support }));
vi.mock("./sms-delivery.service.js", () => ({ sweepSmsDeliveryTimeouts: vi.fn() }));
vi.mock("./unmatched-inbound-sms.service.js", () => ({ sweepPendingUnmatchedSms: vi.fn() }));
import { sweepPendingSmsReplies } from "./sms-reply-worker.service.js";

const people: string[] = [];
afterEach(async () => {
  if (people.length) await db.delete(customersTable).where(inArray(customersTable.id, people.splice(0)));
  vi.unstubAllEnvs();
});

it("processes support despite a full batch of older paused sales replies", async () => {
  const rows = await db.insert(customersTable).values(Array.from({ length: 51 }, () => ({
    firstName: "Synthetic", lastName: "Queue", email: `${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-09-24",
  }))).returning({ id: customersTable.id });
  people.push(...rows.map((row) => row.id));
  const support = rows.at(-1)!;
  await db.insert(smsReplyWorkTable).values(rows.map((row, i) => ({
    personId: row.id, persona: i === 50 ? "support" as const : "sales" as const,
    updatedAt: new Date(Date.now() - (51 - i) * 1000),
  })));
  vi.stubEnv("SALES_SMS_ENABLED", "false");
  await sweepPendingSmsReplies();
  expect(mocks.sales).not.toHaveBeenCalled();
  expect(mocks.support).toHaveBeenCalledWith(support.id);
  // Pausing must retain the unsent inbound work for a later enabled worker.
  const pending = await db.select().from(smsReplyWorkTable).where(inArray(smsReplyWorkTable.personId, people));
  expect(pending.filter((row) => row.persona === "sales")).toHaveLength(50);
});

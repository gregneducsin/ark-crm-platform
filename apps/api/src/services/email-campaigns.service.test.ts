import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, pool, customersTable } from "@luma/db";
const send = vi.hoisted(() => vi.fn());
vi.mock("../lib/email-provider.js", () => ({
  getEmailProvider: () => ({
    provider: { sendEmail: send },
    fromName: "Ark Health",
  }),
}));
const {
  createCampaign,
  testCampaign,
  setCampaignStatus,
  sweepEmailCampaigns,
  campaignAudience,
  saveCampaignSchedule,
} = await import("./email-campaigns.service.js");
async function person(email: string, emailDnd = false) {
  return (
    await db
      .insert(customersTable)
      .values({
        firstName: "Synthetic",
        lastName: "Campaign",
        email,
        emailDnd,
        leadReceivedDate: "2026-11-06",
      })
      .returning()
  )[0];
}
beforeEach(async () => {
  await pool.query("DELETE FROM email_campaign_recipients");
  await pool.query("DELETE FROM email_campaigns");
  await pool.query("DELETE FROM customers");
  send.mockReset().mockResolvedValue({ messageId: "synthetic-provider-id" });
  process.env.EMAIL_UNSUBSCRIBE_SECRET = "test-only";
  process.env.INTAKE_LINK_BASE_URL = "https://example.com";
});
describe("email campaigns", () => {
  it("saves without starting and waits on excluded days", async () => {
    await person("schedule@example.com");
    const c = await createCampaign("staff@example.com");
    const schedule = {
      days: [(new Date().getUTCDay() + 1) % 7],
      start: "00:00",
      end: "23:59",
      timezone: "UTC",
    };
    expect((await saveCampaignSchedule(c.id, schedule)).status).toBe("draft");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    send.mockClear();
    await sweepEmailCampaigns();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT status FROM email_campaign_recipients")).rows[0]
        .status,
    ).toBe("pending");
    await expect(saveCampaignSchedule(c.id, null)).rejects.toThrow("Pause");
    await setCampaignStatus(c.id, "pause", 20, false);
    await saveCampaignSchedule(c.id, null);
    await setCampaignStatus(c.id, "start", 20, true);
    await sweepEmailCampaigns();
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("includes review holds without clearing them, but excludes explicit pauses", async () => {
    const p = await person("review@example.com");
    const paused = await person("paused@example.com");
    await pool.query("UPDATE customers SET ai_paused=true WHERE id=$1", [
      paused.id,
    ]);
    const { getOrCreateEmailConversation } =
      await import("./email-conversations.service.js");
    const conversation = await getOrCreateEmailConversation(p.id);
    await pool.query(
      "UPDATE email_conversations SET needs_attention=true,needs_attention_reason='Staff review' WHERE id=$1",
      [conversation.id],
    );
    expect((await campaignAudience()).map((r) => r.email)).toEqual([
      "review@example.com",
    ]);
    const c = await createCampaign("staff@example.com");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    send.mockClear();
    await sweepEmailCampaigns();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          "SELECT needs_attention,needs_attention_reason FROM email_conversations WHERE id=$1",
          [conversation.id],
        )
      ).rows[0],
    ).toEqual({
      needs_attention: true,
      needs_attention_reason: "Staff review",
    });
  });
  it("deduplicates repeated draft creation", async () => {
    const [a, b] = await Promise.all([
      createCampaign("staff@example.com"),
      createCampaign("staff@example.com"),
    ]);
    expect(a.id).toBe(b.id);
  });
  it("pauses remaining recipients after an uncertain transport result", async () => {
    await person("one@example.com");
    await person("two@example.com");
    const c = await createCampaign("staff@example.com");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    send.mockClear().mockRejectedValue(new Error("timeout"));
    await sweepEmailCampaigns();
    await sweepEmailCampaigns();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query("SELECT status FROM email_campaigns WHERE id=$1", [
          c.id,
        ])
      ).rows[0].status,
    ).toBe("paused");
    expect(
      (
        await pool.query(
          "SELECT status FROM email_campaign_recipients WHERE status='pending'",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("creates a draft with no enrollments or sends", async () => {
    const c = await createCampaign("staff@example.com");
    await sweepEmailCampaigns();
    expect(c.status).toBe("draft");
    expect(send).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT * FROM email_campaign_recipients")).rows,
    ).toHaveLength(0);
  });
  it("sends one idempotent test only to Greg, without enrolling leads", async () => {
    await person("lead@example.com");
    const c = await createCampaign("staff@example.com");
    await Promise.all([testCampaign(c.id), testCampaign(c.id)]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe("gregneducsin@gmail.com");
    expect(send.mock.calls[0][3].fromEmailOverride).toBe("support@tryark.com");
    expect(
      (await pool.query("SELECT * FROM email_campaign_recipients")).rows,
    ).toHaveLength(0);
  });
  it("does not retry an ambiguous test send", async () => {
    send.mockRejectedValue(new Error("timeout"));
    const c = await createCampaign("staff@example.com");
    expect((await testCampaign(c.id)).test_status).toBe("unknown");
    await testCampaign(c.id);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(setCampaignStatus(c.id, "start", 20, true)).rejects.toThrow();
  });
  it("requires a test and approval before enrollment", async () => {
    const c = await createCampaign("staff@example.com");
    await expect(setCampaignStatus(c.id, "start", 20, true)).rejects.toThrow();
    await testCampaign(c.id);
    await expect(setCampaignStatus(c.id, "start", 20, false)).rejects.toThrow();
  });
  it("normalizes duplicate inboxes and honors an opt-out on either record", async () => {
    await person("Same@example.com");
    await person(" same@example.com ");
    await person("blocked@example.com");
    await person("BLOCKED@example.com", true);
    await person("unknown");
    expect((await campaignAudience()).map((x) => x.email)).toEqual([
      "same@example.com",
    ]);
  });
  it("rechecks opt-outs after enrollment, and pauses safely", async () => {
    const p = await person("lead@example.com");
    const c = await createCampaign("staff@example.com");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    await setCampaignStatus(c.id, "pause", 20, false);
    send.mockClear();
    await sweepEmailCampaigns();
    expect(send).not.toHaveBeenCalled();
    await pool.query("UPDATE customers SET email_dnd=true WHERE id=$1", [p.id]);
    await setCampaignStatus(c.id, "start", 20, true);
    await sweepEmailCampaigns();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT status FROM email_campaign_recipients")).rows[0]
        .status,
    ).toBe("skipped");
  });
  it("paces concurrent workers, records acceptance and uses a real unsubscribe URL", async () => {
    await person("one@example.com");
    await person("two@example.com");
    const c = await createCampaign("staff@example.com");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    send.mockClear();
    await Promise.all([sweepEmailCampaigns(), sweepEmailCampaigns()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][2]).toContain("https://example.com/unsubscribe/");
    expect(send.mock.calls[0][2]).not.toContain("{{UNSUBSCRIBE_URL}}");
    expect(
      (
        await pool.query(
          "SELECT * FROM email_campaign_recipients WHERE status='sent' AND sent_at IS NOT NULL",
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("does not resend a crashed in-flight attempt", async () => {
    await person("one@example.com");
    const c = await createCampaign("staff@example.com");
    await testCampaign(c.id);
    await setCampaignStatus(c.id, "start", 20, true);
    await pool.query("UPDATE email_campaign_recipients SET status='sending'");
    send.mockClear();
    await sweepEmailCampaigns();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await pool.query("SELECT status FROM email_campaign_recipients")).rows[0]
        .status,
    ).toBe("unknown");
  });
});

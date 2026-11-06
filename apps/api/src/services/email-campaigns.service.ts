import { pool } from "@luma/db";
import {
  campaignWindowOpen,
  validateCampaignSchedule,
  type CampaignSchedule,
} from "../lib/email/campaign-schedule.js";
import { withPersonLock } from "../lib/db-lock.js";
import { getEmailProvider } from "../lib/email-provider.js";
import { peptideCampaignHtml } from "../lib/email/peptide-campaign.js";
import {
  CAMPAIGN_SENDER,
  TEST_RECIPIENT,
  normalizeCampaignEmail,
  renderCampaign,
} from "../lib/email/campaign-policy.js";
import { getOrCreateEmailConversation } from "./email-conversations.service.js";
import { sendTrackedEmail } from "./email-delivery.service.js";
import { htmlToPlainText } from "../lib/email/templates.js";

// Shared by worker, start, pause and test: no concurrent campaign sends, even across replicas.
const LOCK = "ark-email-campaign-dispatch";
export interface Campaign {
  id: string;
  name: string;
  subject: string;
  html: string;
  status: string;
  per_hour: number;
  schedule: CampaignSchedule | null;
  test_status: string;
  test_sent_at: string | null;
}
async function getCampaign(id: string): Promise<Campaign> {
  const { rows } = await pool.query(
    "SELECT * FROM email_campaigns WHERE id=$1",
    [id],
  );
  if (!rows[0]) throw new Error("Campaign not found");
  return rows[0];
}
// Suppress the entire normalized inbox if ANY matching record has an opt-out,
// explicit AI pause, or unresolved email failure. Review flags alone do not suppress this campaign.
const ELIGIBILITY = `NOT EXISTS (SELECT 1 FROM customers other WHERE lower(btrim(other.email))=lower(btrim(c.email)) AND (
 other.email_dnd OR other.ai_paused
 OR EXISTS (SELECT 1 FROM email_conversations e JOIN email_conversation_messages m ON m.conversation_id=e.id WHERE e.person_id=other.id AND m.delivery_status IN ('queued','unknown','failed'))
 OR EXISTS (SELECT 1 FROM support_email_conversations e JOIN support_email_conversation_messages m ON m.conversation_id=e.id WHERE e.person_id=other.id AND m.delivery_status IN ('queued','unknown','failed'))
 OR EXISTS (SELECT 1 FROM purchases p WHERE p.customer_id=other.id AND p.order_classification='test')
))`;
export async function campaignAudience() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (lower(btrim(c.email))) c.id, lower(btrim(c.email)) AS email FROM customers c WHERE ${ELIGIBILITY} ORDER BY lower(btrim(c.email)), c.created_at, c.id`,
  );
  return rows.filter((r) => normalizeCampaignEmail(r.email));
}
export async function listCampaigns() {
  const { rows } = await pool.query(
    `SELECT c.*, (SELECT json_object_agg(status, n) FROM (SELECT status,count(*)::int n FROM email_campaign_recipients WHERE campaign_id=c.id GROUP BY status) counts) AS counts FROM email_campaigns c ORDER BY created_at DESC LIMIT 100`,
  );
  return rows;
}
export async function createCampaign(actor: string) {
  return withPersonLock(LOCK, async () => {
    // This release contains one announcement. Repeat clicks cannot create a
    // second campaign that would deliver the same announcement again.
    const existing = await pool.query(
      "SELECT * FROM email_campaigns ORDER BY created_at LIMIT 1",
    );
    if (existing.rows[0]) return existing.rows[0];
    const { rows } = await pool.query(
      `INSERT INTO email_campaigns(name,subject,html,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [
        "Peptide announcement",
        "Exciting news! TB-500, BPC-157 & MOTS-C are here",
        peptideCampaignHtml,
        actor,
      ],
    );
    return rows[0];
  });
}
export async function testCampaign(id: string) {
  return withPersonLock(LOCK, async () => {
    const c = await getCampaign(id);
    // A repeated click or lost HTTP response never causes a second test send.
    if (c.test_status !== "not_sent") return c;
    const { provider } = getEmailProvider("system");
    const html = renderCampaign(
      c.html,
      "mailto:support@tryark.com?subject=Unsubscribe%20preview%20only",
    );
    await pool.query(
      "UPDATE email_campaigns SET test_status='sending',test_requested_at=now() WHERE id=$1",
      [id],
    );
    try {
      const result = await provider.sendEmail(
        TEST_RECIPIENT,
        `[TEST] ${c.subject}`,
        html,
        {
          fromName: "Ark Health",
          fromEmailOverride: CAMPAIGN_SENDER,
          replyTo: CAMPAIGN_SENDER,
        },
      );
      if (!result.messageId) throw new Error("No provider acceptance");
      await pool.query(
        "UPDATE email_campaigns SET test_status='sent',test_message_id=$2,test_sent_at=now() WHERE id=$1",
        [id, result.messageId],
      );
    } catch {
      await pool.query(
        "UPDATE email_campaigns SET test_status='unknown' WHERE id=$1",
        [id],
      );
    }
    return getCampaign(id);
  });
}
export async function saveCampaignSchedule(id: string, value: unknown) {
  const schedule = validateCampaignSchedule(value);
  return withPersonLock(LOCK, async () => {
    const c = await getCampaign(id);
    if (c.status !== "draft" && c.status !== "paused")
      throw new Error("Pause the campaign before changing its schedule");
    await pool.query(
      "UPDATE email_campaigns SET schedule=$2::jsonb WHERE id=$1",
      [id, JSON.stringify(schedule)],
    );
    return getCampaign(id);
  });
}
export async function setCampaignStatus(
  id: string,
  action: "start" | "pause",
  perHour: number,
  approved: boolean,
) {
  return withPersonLock(LOCK, async () => {
    const c = await getCampaign(id);
    if (action === "pause") {
      if (c.status === "running")
        await pool.query(
          "UPDATE email_campaigns SET status='paused' WHERE id=$1",
          [id],
        );
      return getCampaign(id);
    }
    if (!approved || c.test_status !== "sent")
      throw new Error(
        "Review the test email and confirm the $175 offer and audience before starting",
      );
    if (!Number.isInteger(perHour) || perHour < 1 || perHour > 60)
      throw new Error("Choose 1–60 emails per hour");
    if (c.status === "completed" || c.status === "running") return c;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (c.status === "draft") {
        const audience = await campaignAudience();
        // Snapshot once; later new leads are not silently enrolled.
        for (let offset = 0; offset < audience.length; offset += 500) {
          const batch = audience.slice(offset, offset + 500);
          await client.query(
            `INSERT INTO email_campaign_recipients(campaign_id,person_id,email) SELECT $1,x.id,x.email FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,email text) ON CONFLICT DO NOTHING`,
            [id, JSON.stringify(batch)],
          );
        }
      }
      await client.query(
        "UPDATE email_campaigns SET status='running',per_hour=$2,next_send_at=now() WHERE id=$1",
        [id, perHour],
      );
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return getCampaign(id);
  });
}
export async function sweepEmailCampaigns() {
  return withPersonLock(LOCK, async () => {
    // A crashed transport has an uncertain outcome. Never return it to pending.
    await pool.query(
      "WITH interrupted AS (UPDATE email_campaign_recipients SET status='unknown',reason='Interrupted send; review provider before retrying' WHERE status='sending' RETURNING campaign_id) UPDATE email_campaigns SET status='paused' WHERE id IN (SELECT campaign_id FROM interrupted) AND status='running'",
    );
    await pool.query(
      "UPDATE email_campaigns SET test_status='unknown' WHERE test_status='sending'",
    );
    const { rows: campaigns } = await pool.query(
      "SELECT * FROM email_campaigns WHERE status='running' AND next_send_at<=now() ORDER BY next_send_at LIMIT 1",
    );
    const c: Campaign | undefined = campaigns.find((c: Campaign) =>
      campaignWindowOpen(c.schedule),
    );
    if (!c) return;
    const { rows } = await pool.query(
      "SELECT * FROM email_campaign_recipients WHERE campaign_id=$1 AND status='pending' ORDER BY id LIMIT 1",
      [c.id],
    );
    const r = rows[0];
    if (!r) {
      await pool.query(
        "UPDATE email_campaigns SET status='completed' WHERE id=$1",
        [c.id],
      );
      return;
    }
    await pool.query(
      "UPDATE email_campaigns SET next_send_at=now()+($2 * interval '1 second') WHERE id=$1",
      [c.id, Math.ceil(3600 / c.per_hour)],
    );
    if (!r.person_id) {
      await pool.query(
        "UPDATE email_campaign_recipients SET status='skipped',reason='Contact removed' WHERE id=$1",
        [r.id],
      );
      return;
    }
    await withPersonLock(r.person_id, async () => {
      const eligible = await pool.query(
        `SELECT c.id FROM customers c WHERE c.id=$1 AND lower(btrim(c.email))=$2 AND ${ELIGIBILITY}`,
        [r.person_id, r.email],
      );
      if (!eligible.rowCount) {
        await pool.query(
          "UPDATE email_campaign_recipients SET status='skipped',reason='Address changed, opt-out, staff hold, test record or prior email issue' WHERE id=$1",
          [r.id],
        );
        return;
      }
      const conversation = await getOrCreateEmailConversation(r.person_id);
      // A person lock or DB call may have waited past the end of the window.
      if (!campaignWindowOpen(c.schedule)) return;
      await pool.query(
        "UPDATE email_campaign_recipients SET status='sending',attempted_at=now() WHERE id=$1",
        [r.id],
      );
      try {
        const result = await sendTrackedEmail({
          persona: "alexis",
          allowCampaignReviewHold: true,
          personId: r.person_id,
          conversationId: conversation.id,
          email: r.email,
          subject: c.subject,
          body: htmlToPlainText(c.html),
          render: (url) => renderCampaign(c.html, url),
          fromEmailOverride: CAMPAIGN_SENDER,
        });
        await pool.query(
          "UPDATE email_campaign_recipients SET status=$2,provider_message_id=$3,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END,reason=$4 WHERE id=$1",
          [
            r.id,
            result.status,
            result.status === "sent" ? result.messageId : null,
            result.status === "sent"
              ? null
              : "Review email provider; no automatic retry",
          ],
        );
        if (result.status !== "sent")
          await pool.query(
            "UPDATE email_campaigns SET status='paused' WHERE id=$1",
            [c.id],
          );
      } catch {
        await pool.query(
          "UPDATE email_campaign_recipients SET status='unknown',reason='Uncertain send; no automatic retry' WHERE id=$1",
          [r.id],
        );
        await pool.query(
          "UPDATE email_campaigns SET status='paused' WHERE id=$1",
          [c.id],
        );
      }
    });
  });
}

import { env } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { createApp } from "./app.js";
import { sweepFollowUpJobs } from "./services/follow-up-jobs.service.js";
import { sweepAbandonedCartTriggers } from "./services/abandoned-cart.service.js";
import { sweepAbandonedCartEmailTriggers } from "./services/abandoned-cart-email.service.js";
import { sweepMetaLeadEmailTriggers } from "./services/meta-lead-email.service.js";
import { sweepReviewRequestTriggers } from "./services/order-fulfillment.service.js";
import { sweepLeadCheckinTriggers } from "./services/lead-checkin.service.js";
import { sweepObjectionReengagementTriggers } from "./services/objection-reengagement.service.js";
import { sweepInboundEmail } from "./services/email-inbound.service.js";
import { notifySlack } from "./lib/slack.js";

// Migrations are applied as a discrete step before this process starts (see
// packages/db/src/migrate.ts's docstring, the Dockerfile entrypoint, and the
// CI workflow) — never opportunistically here.

const app = createApp();

app.listen(env.port, () => {
  logger.info({ port: env.port, nodeEnv: env.nodeEnv }, "Server listening");
});

// Follow-up job sweep: in-process interval, single-instance only (same
// simplification already accepted for rate limiting — revisit together if
// multi-instance hosting is ever chosen). A missed or overlapping tick is
// harmless: sweepFollowUpJobs() only ever touches jobs still `pending`, so a
// slow tick just gets picked up by the next one.
const FOLLOW_UP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  sweepFollowUpJobs().catch((err) => {
    logger.error({ err }, "follow-up job sweep failed");
    void notifySlack(`Follow-up job sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, FOLLOW_UP_SWEEP_INTERVAL_MS);

// Shorter interval than the follow-up sweep above — the opener promise is
// "10 minutes after abandonment," a much tighter window than the hour-plus
// delays in the follow-up sequence, so it needs a finer-grained tick.
const ABANDONED_CART_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
setInterval(() => {
  sweepAbandonedCartTriggers().catch((err) => {
    logger.error({ err }, "abandoned-cart opener sweep failed");
    void notifySlack(`Abandoned-cart opener sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, ABANDONED_CART_SWEEP_INTERVAL_MS);

// Same tight tick as the SMS abandoned-cart sweep above — the email
// sequence's finest-grained step (the opener) has the identical 10-minute
// delay, even though its later steps (urgency/educational/plan_comparison)
// are due days out.
const ABANDONED_CART_EMAIL_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
setInterval(() => {
  sweepAbandonedCartEmailTriggers().catch((err) => {
    logger.error({ err }, "abandoned-cart email sweep failed");
    void notifySlack(`Abandoned-cart email sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, ABANDONED_CART_EMAIL_SWEEP_INTERVAL_MS);

// Same tight tick as the abandoned-cart email sweep above, and for the same
// reason — its opener step has the identical 10-minute delay.
const META_LEAD_EMAIL_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
setInterval(() => {
  sweepMetaLeadEmailTriggers().catch((err) => {
    logger.error({ err }, "meta-lead email sweep failed");
    void notifySlack(`Meta-lead email sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, META_LEAD_EMAIL_SWEEP_INTERVAL_MS);

// Review-request check-ins are due days out (see order-fulfillment.service.ts's
// REVIEW_REQUEST_DELAY_MS), so a coarser tick than the abandoned-cart sweep
// is plenty precise.
const REVIEW_REQUEST_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  sweepReviewRequestTriggers().catch((err) => {
    logger.error({ err }, "review-request sweep failed");
    void notifySlack(`Review-request sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, REVIEW_REQUEST_SWEEP_INTERVAL_MS);

// Lead check-ins are due 6 days out — same coarse tick as the review-request
// sweep above is plenty precise for a delay measured in days.
const LEAD_CHECKIN_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  sweepLeadCheckinTriggers().catch((err) => {
    logger.error({ err }, "lead check-in sweep failed");
    void notifySlack(`Lead check-in sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, LEAD_CHECKIN_SWEEP_INTERVAL_MS);

// Objection re-engagement is due 2 weeks out — same coarse tick as the
// lead-checkin sweep above is plenty precise for a delay measured in weeks.
const OBJECTION_REENGAGEMENT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
setInterval(() => {
  sweepObjectionReengagementTriggers().catch((err) => {
    logger.error({ err }, "objection re-engagement sweep failed");
    void notifySlack(`Objection re-engagement sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}, OBJECTION_REENGAGEMENT_SWEEP_INTERVAL_MS);

// Inbound-email IMAP poll — same in-process interval pattern as the sweeps
// above, just polling a mailbox instead of due DB rows (see
// email-inbound.service.ts's sweepInboundEmail docstring). Gated on
// GOOGLE_WORKSPACE_SMTP_USER being set (unlike the SMS sweeps, which always
// run and just no-op per item when unconfigured): an unconfigured mailbox
// can't do anything useful, so starting the poll would only produce a
// connection-refused log line every minute.
const EMAIL_INBOUND_SWEEP_INTERVAL_MS = 60 * 1000;
if (process.env.GOOGLE_WORKSPACE_SMTP_USER) {
  setInterval(() => {
    sweepInboundEmail().catch((err) => {
      logger.error({ err }, "inbound email sweep failed");
      void notifySlack(`Inbound email sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, EMAIL_INBOUND_SWEEP_INTERVAL_MS);
} else {
  logger.info("GOOGLE_WORKSPACE_SMTP_USER not set — inbound email polling disabled");
}

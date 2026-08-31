import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, intakeLinkTokensTable, followUpJobsTable, type IntakeLinkToken } from "@luma/db";
import { generateRawToken, hashToken } from "../lib/crypto.js";

const INTAKE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const FOLLOW_UP_DELAY_MS = 2 * 60 * 60 * 1000;

export type PromoVariant = IntakeLinkToken["promoApplied"];
export type IntakeLeadSource = IntakeLinkToken["leadSource"];

function baskQuestionnaireUrl(promo: PromoVariant): string {
  const envVar = promo === "first_month_20" ? "BASK_QUESTIONNAIRE_PROMO_URL" : "BASK_QUESTIONNAIRE_URL";
  const url = process.env[envVar];
  if (!url) {
    throw new Error(`${envVar} is not configured.`);
  }
  return url;
}

function intakeLinkBaseUrl(): string {
  const url = process.env.INTAKE_LINK_BASE_URL;
  if (!url) {
    throw new Error("INTAKE_LINK_BASE_URL is not configured.");
  }
  return url;
}

/**
 * Mint a one-time trigger link for a lead (e.g. an abandoned-questionnaire
 * nudge). The raw token is returned exactly once and is never stored — only
 * its SHA-256 hash is persisted, same convention as session/invitation tokens.
 *
 * `promo` picks which Bask URL variant this link redirects to, decided now
 * (e.g. by whether the conversation used the first_month_offer topic) —
 * never re-derived at click time, which happens hours later with no memory
 * of the conversation.
 *
 * `leadSource` is stored for the same reason: whoever's minting this link
 * already knows which conversation script this person is on (the caller's
 * own context), and a follow-up nudge sent hours later — see
 * follow-up-jobs.service.ts — needs that same value to log itself into the
 * right kind of conversation, since it can end up being the very first SMS
 * this person ever gets, with no existing conversation row to read it from.
 */
export async function createIntakeLink(personId: string, promo: PromoVariant = "none", leadSource: IntakeLeadSource = "abandoned_cart"): Promise<{ url: string; expiresAt: Date }> {
  const rawToken = generateRawToken();
  const expiresAt = new Date(Date.now() + INTAKE_LINK_TTL_MS);

  await db.insert(intakeLinkTokensTable).values({
    personId,
    tokenHash: hashToken(rawToken),
    promoApplied: promo,
    leadSource,
    expiresAt,
  });

  return { url: `${intakeLinkBaseUrl()}/go/${rawToken}`, expiresAt };
}

/**
 * Resolve a click on an intake link. Always returns a Bask questionnaire URL
 * to redirect to — an unknown token falls back to the plain URL so a customer
 * never lands on an error page — but only a valid, unexpired, first-time
 * click on a known token arms the 2-hour follow-up job.
 */
export async function handleIntakeLinkClick(rawToken: string): Promise<{ redirectUrl: string }> {
  const tokenHash = hashToken(rawToken);

  return db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(intakeLinkTokensTable)
      .where(eq(intakeLinkTokensTable.tokenHash, tokenHash))
      .for("update");

    if (!token) {
      return { redirectUrl: baskQuestionnaireUrl("none") };
    }

    const alreadyClicked = token.clickedAt !== null;
    const expired = token.expiresAt.getTime() <= Date.now();
    // Expiry only ever gated whether this click armed the follow-up job —
    // an expired link still honored its promo variant forever, so a $20-off
    // link kept discounting orders well past the offer's 24-hour window.
    // Once expired, fall back to the plain URL, same as an unknown token.
    const redirectUrl = expired ? baskQuestionnaireUrl("none") : baskQuestionnaireUrl(token.promoApplied);

    if (!alreadyClicked && !expired) {
      await tx.update(intakeLinkTokensTable).set({ clickedAt: sql`now()` }).where(eq(intakeLinkTokensTable.id, token.id));

      // A person can have more than one intake link minted for them over
      // time (a new one goes out every time an abandoned-cart/meta-lead
      // trigger fires again, or Alexis sends another one mid-conversation) —
      // nothing stops an earlier link, from a previous nudge, from still
      // being clickable when a newer one goes out. If they click an old one
      // after already having a newer chain armed (or click two different
      // links close together), each click was arming its own independent
      // 2-hour-later/3-hour-later follow-up pair with no awareness of the
      // other, so the person could end up getting the same nudge twice.
      // This click is the most recent signal of intent, so it supersedes
      // any follow-up chain still in flight from an earlier click.
      await tx
        .update(followUpJobsTable)
        .set({ status: "cancelled", cancelledReason: "superseded_by_newer_click" })
        .where(
          and(
            eq(followUpJobsTable.personId, token.personId),
            or(eq(followUpJobsTable.status, "pending"), eq(followUpJobsTable.status, "processing")),
          ),
        );

      await tx.insert(followUpJobsTable).values({
        personId: token.personId,
        intakeLinkTokenId: token.id,
        messageStep: "provider_check_in",
        dueAt: new Date(Date.now() + FOLLOW_UP_DELAY_MS),
      });
    }

    return { redirectUrl };
  });
}

/** Whether the most recently minted intake link for this person has been clicked. */
export async function hasClickedMostRecentIntakeLink(personId: string): Promise<boolean> {
  const [row] = await db
    .select({ clickedAt: intakeLinkTokensTable.clickedAt })
    .from(intakeLinkTokensTable)
    .where(eq(intakeLinkTokensTable.personId, personId))
    .orderBy(desc(intakeLinkTokensTable.createdAt))
    .limit(1);
  return row?.clickedAt != null;
}

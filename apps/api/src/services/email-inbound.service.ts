import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser } from "mailparser";
import { eq } from "drizzle-orm";
import { db, customersTable, emailConversationsTable, supportEmailConversationsTable } from "@luma/db";
import { recordWebhookEventIfNew, markWebhookEventProcessed, markWebhookEventFailed, caseInsensitiveEmailEq } from "./webhooks.service.js";
import { processInboundEmail } from "./alexis-email-dispatch.service.js";
import { processInboundSupportEmail } from "./sophie-email-dispatch.service.js";
import { recordAndClassifyUnmatchedEmail } from "./unmatched-inbound-email.service.js";
import { htmlToPlainText } from "../lib/email/templates.js";
import { logger } from "../lib/logger.js";
import { notifySlack } from "../lib/slack.js";

/**
 * Cuts off a reply body at the start of the quoted history a mail client
 * appends below every reply ("On Tue, ... wrote:", or a run of "> " quote
 * lines) — without this, the pre-check/guardrail loop and the AI turn both
 * see the entire prior conversation pasted into a single inbound message
 * every time, which both re-triggers on old content and confuses the model
 * about what's actually new. Best-effort: matches the common Gmail/Apple
 * Mail/Outlook quote-header shapes, not exhaustive.
 */
const QUOTE_HEADER_RE = /(^|\n)(on .{0,300} wrote:|-{2,}\s*original message\s*-{2,}|from:\s*.+\n+sent:\s*.+)/i;

export function stripQuotedReply(bodyText: string): string {
  const lines = bodyText.split("\n");
  const quoteHeaderMatch = bodyText.match(QUOTE_HEADER_RE);
  let cut = quoteHeaderMatch ? bodyText.indexOf(quoteHeaderMatch[0]) : -1;

  if (cut === -1) {
    // Fall back to the first line that starts a run of "> " quoted lines.
    const idx = lines.findIndex((l) => l.trimStart().startsWith(">"));
    if (idx !== -1) {
      cut = lines.slice(0, idx).join("\n").length;
    }
  }

  const trimmed = cut === -1 ? bodyText : bodyText.slice(0, cut);
  return trimmed.trim();
}

function extractBodyText(parsed: { text?: string; html?: string | false }): string {
  if (parsed.text?.trim()) return parsed.text.trim();
  if (parsed.html) return htmlToPlainText(parsed.html);
  return "";
}

async function findCustomerIdByEmail(email: string): Promise<string | undefined> {
  const [row] = await db.select({ id: customersTable.id }).from(customersTable).where(caseInsensitiveEmailEq(email));
  return row?.id;
}

async function hasSupportEmailConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: supportEmailConversationsTable.id }).from(supportEmailConversationsTable).where(eq(supportEmailConversationsTable.personId, personId));
  return Boolean(row);
}

async function hasEmailConversation(personId: string): Promise<boolean> {
  const [row] = await db.select({ id: emailConversationsTable.id }).from(emailConversationsTable).where(eq(emailConversationsTable.personId, personId));
  return Boolean(row);
}

/**
 * Same support-conversation-first routing as iblusend-webhook.service.ts's
 * dispatchInboundMessage, matched by email instead of phone. See that
 * function's docstring for the full reasoning — identical here.
 */
async function dispatchInboundEmail(personId: string, subject: string, bodyText: string, messageId: string | null, receivingAddress: string): Promise<void> {
  if (await hasSupportEmailConversation(personId)) {
    await processInboundSupportEmail(personId, subject, bodyText, messageId, receivingAddress);
    return;
  }
  if (await hasEmailConversation(personId)) {
    await processInboundEmail(personId, subject, bodyText, messageId, undefined, receivingAddress);
    return;
  }
  logger.warn({ personId }, "inbound email from a person with no Alexis or Sophie email conversation — no auto-reply sent");
}

interface ImapMailbox {
  readonly host: string;
  readonly user: string;
  readonly pass: string;
}

/**
 * EMAIL_INBOUND_EXTRA_MAILBOXES lets additional real mailboxes on the same
 * Google Workspace (not aliases of the primary one — those are already
 * covered for free, since mail sent to an alias lands in the primary
 * mailbox's own inbox) also get polled for inbound routing — e.g. a
 * hello@ inbox or a staff member's own address that customers sometimes
 * reply to directly. Each entry needs its own 2-Step-Verification app
 * password, same requirement as the primary mailbox. Format:
 * "user1@domain:apppassword1,user2@domain:apppassword2" — the separator
 * between user and password can be a ":" or plain whitespace (an email
 * address never contains either, so the first one found is unambiguous —
 * this tolerates someone pasting "user password" instead of "user:password"),
 * and comma separates entries. Whitespace inside the password itself
 * (Google shows app passwords as four space-separated groups) is fine and
 * gets stripped either way.
 */
export function parseExtraMailboxes(raw: string | undefined): ImapMailbox[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const sepMatch = entry.match(/[:\s]/);
      if (!sepMatch || sepMatch.index === undefined) {
        throw new Error(`EMAIL_INBOUND_EXTRA_MAILBOXES entry is missing the separator between user and app password: "${entry}"`);
      }
      const user = entry.slice(0, sepMatch.index).trim();
      const pass = entry.slice(sepMatch.index + 1).trim().replace(/\s+/g, "");
      if (!user || !pass) {
        throw new Error(`EMAIL_INBOUND_EXTRA_MAILBOXES entry has an empty user or app password: "${entry}"`);
      }
      return { host: "imap.gmail.com", user, pass };
    });
}

/**
 * EMAIL_INBOUND_IGNORED_SENDERS silently drops mail from known automated
 * senders (e.g. a practice-management platform's own operational alerts —
 * new patient registered, prescription reminder, order notification — that
 * happen to be addressed to the same polled mailbox as real customer
 * inquiries, whether directly or via a same-Workspace domain alias) before
 * it ever reaches the unmatched-sender triage queue. Comma-separated, exact
 * address match, case-insensitive. Distinct from spam/irrelevant
 * classification (which still creates a thread for review) — an ignored
 * sender never creates a thread or record at all, since these are known,
 * expected, non-customer senders rather than something worth a human
 * glancing at even once.
 */
export function isIgnoredSender(fromAddress: string, raw: string | undefined): boolean {
  if (!raw?.trim()) return false;
  const ignored = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return ignored.includes(fromAddress.trim().toLowerCase());
}

export function imapConfigs(): ImapMailbox[] {
  const user = process.env.GOOGLE_WORKSPACE_SMTP_USER;
  const rawPass = process.env.GOOGLE_WORKSPACE_SMTP_APP_PASSWORD;
  if (!user || !rawPass) {
    throw new Error("GOOGLE_WORKSPACE_SMTP_USER/GOOGLE_WORKSPACE_SMTP_APP_PASSWORD is not set — required for IMAP polling too (same mailbox, same app password).");
  }
  // Google shows an app password as 4 space-separated groups — stripped the
  // same way parseExtraMailboxes already tolerates it below, so pasting it
  // exactly as displayed doesn't silently fail login (confirmed to happen:
  // a space-containing value here is sent verbatim as the IMAP password and
  // gets rejected, while the identical raw value parsed by
  // parseExtraMailboxes already had this whitespace stripped).
  const pass = rawPass.replace(/\s+/g, "");
  return [{ host: "imap.gmail.com", user, pass }, ...parseExtraMailboxes(process.env.EMAIL_INBOUND_EXTRA_MAILBOXES)];
}

export interface EmailInboundSweepResult {
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
}

/**
 * Polls the connected Google Workspace mailbox(es) for unread mail, once per
 * call — same "sweep" shape as the SMS trigger sweeps (sweepAbandonedCartTriggers
 * etc.), just polling an inbox instead of due DB rows. Idempotency is DB-level
 * (webhook_events, keyed on the RFC 5322 Message-ID), not merely the IMAP
 * \Seen flag — a flag that failed to set, or a mailbox re-sync, can't cause
 * a double-reply. Safe to call repeatedly, including overlapping runs, for
 * the same reason every other sweep in this codebase is: whichever call
 * wins the DB-level claim (recordWebhookEventIfNew) is the only one that acts.
 *
 * Polls the primary mailbox plus every EMAIL_INBOUND_EXTRA_MAILBOXES entry,
 * one mailbox at a time. A single mailbox's connection failure (bad app
 * password, revoked access, etc.) is caught and logged, not thrown — it
 * shouldn't stop the primary mailbox (or any other extra one) from being
 * polled on the same sweep.
 */
export async function sweepInboundEmail(): Promise<EmailInboundSweepResult> {
  const mailboxes = imapConfigs();
  let processedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const mailbox of mailboxes) {
    try {
      const result = await sweepMailbox(mailbox);
      processedCount += result.processedCount;
      skippedCount += result.skippedCount;
      failedCount += result.failedCount;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.error({ user: mailbox.user, reason }, "inbound email sweep failed to poll mailbox");
      // Log-only here was silent — a revoked app password or connection
      // failure stopped that mailbox's inbound routing entirely, with
      // nothing surfacing outside the server logs until someone thought to
      // look. Every other failure class in this sweep (per-message fetch,
      // per-message processing) already alerts; a whole mailbox going
      // unreachable is strictly worse and deserves the same visibility.
      void notifySlack(`Inbound email sweep — failed to poll mailbox ${mailbox.user}: ${reason}`);
      failedCount++;
    }
  }

  if (processedCount > 0 || failedCount > 0) {
    logger.info({ processedCount, skippedCount, failedCount }, "inbound email sweep completed");
  }

  return { processedCount, skippedCount, failedCount };
}

async function sweepMailbox({ host, user, pass }: ImapMailbox): Promise<EmailInboundSweepResult> {
  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user, pass }, logger: false });
  // ImapFlow is a Node EventEmitter — a socket timeout/reset emits "error"
  // on the client itself, not just a rejection on whichever call was
  // in flight. An EventEmitter throws synchronously and crashes the whole
  // process on an "error" event with no listener, which is exactly what
  // was taking down the entire API server (not just this sweep) on every
  // IMAP socket timeout. The awaited calls below still reject and get
  // caught by the existing try/catch/logger.error path — this listener's
  // only job is to stop that crash, not to duplicate the logging.
  client.on("error", (err) => {
    logger.warn({ user, reason: err instanceof Error ? err.message : String(err) }, "IMAP client error");
  });

  let processedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        let message: FetchMessageObject | false;
        try {
          message = await client.fetchOne(String(uid), { source: true, uid: true }, { uid: true });
        } catch (err) {
          logger.warn({ uid, reason: err instanceof Error ? err.message : String(err) }, "failed to fetch inbound email");
          failedCount++;
          continue;
        }
        if (!message || !message.source) {
          skippedCount++;
          continue;
        }

        const parsed = await simpleParser(message.source);
        const fromAddress = parsed.from?.value[0]?.address;
        const externalEventId = parsed.messageId ?? `imap-uid-${uid}`;

        if (fromAddress && isIgnoredSender(fromAddress, process.env.EMAIL_INBOUND_IGNORED_SENDERS)) {
          await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => undefined);
          skippedCount++;
          continue;
        }

        const recorded = await recordWebhookEventIfNew("email_inbound", externalEventId, { uid, from: fromAddress, subject: parsed.subject });
        if (!recorded) {
          // Already processed this delivery — still mark it read so future
          // polls don't keep re-fetching it.
          await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => undefined);
          skippedCount++;
          continue;
        }

        try {
          if (!fromAddress) {
            throw new Error("Inbound email has no From address.");
          }
          const personId = await findCustomerIdByEmail(fromAddress);
          const bodyText = stripQuotedReply(extractBodyText(parsed));
          if (!personId) {
            await recordAndClassifyUnmatchedEmail({
              fromAddress,
              fromName: parsed.from?.value[0]?.name || null,
              subject: parsed.subject ?? "(no subject)",
              body: bodyText,
              messageId: parsed.messageId ?? null,
              receivingAddress: user,
            });
            await markWebhookEventProcessed(recorded.id);
          } else {
            await dispatchInboundEmail(personId, parsed.subject ?? "(no subject)", bodyText, parsed.messageId ?? null, user);
            await markWebhookEventProcessed(recorded.id, personId);
          }
          processedCount++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await markWebhookEventFailed(recorded.id, reason);
          logger.error({ reason }, "inbound email processing failed");
          failedCount++;
        }

        await client.messageFlagsAdd({ uid: String(uid) }, ["\\Seen"], { uid: true }).catch(() => undefined);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return { processedCount, skippedCount, failedCount };
}

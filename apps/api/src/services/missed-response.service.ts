import { sql } from "drizzle-orm";
import { db, conversationsTable, conversationMessagesTable, supportConversationsTable, supportConversationMessagesTable } from "@luma/db";
import type { NeedsAttentionItem, NeedsAttentionPersona } from "./needs-attention.service.js";

/** Conservative, deterministic closing checks: uncertain replies stay visible to staff. */
export function isClosingReply(body: string, previousReply: string): boolean {
  const text = body.toLowerCase().trim().replace(/[.!]+$/g, "").trim();
  if (/^(stop|unsubscribe|cancel|end|quit|stopall)$/.test(text)) return true;
  if (/^(thanks|thank you|thank you so much|thanks so much|ok thanks|okay thanks|no thanks|no thank you|you're welcome|you’re welcome|👍|🙏)$/.test(text)) return true;
  // A bare "no" to a medication/eligibility question is NOT a closing reply.
  if (/^(no|nope|not right now|all good|no questions|no more questions)$/.test(text)
    && /(?:any|other|more|further) questions|anything else|help with anything/i.test(previousReply)) return true;
  // Short answers to a staff referral-source question complete that exchange.
  if (/^(a friend|friend|family|a family member|facebook|instagram|google|online|word of mouth)$/.test(text)
    && /hear (?:about|of) us|find us|referred you|referral|how did you hear/i.test(previousReply)) return true;
  return false;
}

interface Candidate extends Record<string, unknown> {
  conversationId: string;
  personId: string;
  firstName: string;
  lastName: string;
  inboundId: string;
  inboundAt: Date | string;
  body: string;
  previousReply: string | null;
  pendingBodies: string[];
}

/** Read-derived alerts, refreshed by the existing dashboard poll. No sends, AI calls,
 * historical record rewrites, or automated release of a staff hold. No date cutoff:
 * legacy unanswered messages are reviewed under the same rules as new ones. */
export async function listMissedSmsResponses(now = new Date()): Promise<NeedsAttentionItem[]> {
  const items: NeedsAttentionItem[] = [];
  const cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  for (const persona of ["alexis", "sophie"] as const) {
    const conversations = persona === "alexis" ? conversationsTable : supportConversationsTable;
    const messages = persona === "alexis" ? conversationMessagesTable : supportConversationMessagesTable;
    const otherConversations = persona === "alexis" ? supportConversationsTable : conversationsTable;
    const otherMessages = persona === "alexis" ? supportConversationMessagesTable : conversationMessagesTable;
    const result = await db.execute<Candidate>(sql`
      select c.id as "conversationId", c.person_id as "personId",
        customer.first_name as "firstName", customer.last_name as "lastName",
        inbound.id as "inboundId", inbound.created_at as "inboundAt", inbound.body,
        previous.body as "previousReply",
        array(select m.body from ${messages} m
          where m.conversation_id = c.id and m.direction = 'inbound'
            and (previous.created_at is null or m.created_at > previous.created_at)
            and m.created_at > coalesce((select max(reviewed.created_at)
              from missed_sms_response_reviews r join ${messages} reviewed on reviewed.id = r.inbound_id
              where r.persona = ${persona} and r.conversation_id = c.id), '-infinity'::timestamptz)
          order by m.created_at, m.id) as "pendingBodies"
      from ${conversations} c
      join customers customer on customer.id = c.person_id
      join lateral (select id, body, created_at from ${messages}
        where conversation_id = c.id and direction = 'inbound'
        order by created_at desc, id desc limit 1) inbound on true
      left join lateral (select body, created_at from ${messages}
        where conversation_id = c.id and direction = 'outbound'
          and delivery_status in ('sent', 'delivered', 'read')
          and created_at < inbound.created_at
        order by created_at desc, id desc limit 1) previous on true
      where c.status = 'active' and not c.needs_attention
        and inbound.created_at <= ${cutoff}::timestamptz
        and not exists (select 1 from missed_sms_response_reviews r
          where r.persona = ${persona} and r.conversation_id = c.id and r.inbound_id = inbound.id)
        and not exists (select 1 from ${messages} m
          where m.conversation_id = c.id and m.direction = 'outbound' and m.delivery_status = 'queued'
            and m.created_at >= inbound.created_at and m.created_at > ${cutoff}::timestamptz)
        and not exists (select 1 from ${messages} m
          where m.conversation_id = c.id and m.direction = 'outbound'
            and m.created_at >= inbound.created_at
            and m.delivery_status in ('sent', 'delivered', 'read')
            and coalesce(m.sent_at, m.created_at) >= inbound.created_at)
        and not exists (select 1 from ${otherMessages} m
          join ${otherConversations} other on other.id = m.conversation_id
          where other.person_id = c.person_id and m.direction = 'outbound' and m.sent_by = 'staff'
            and m.created_at >= inbound.created_at and m.delivery_status in ('sent', 'delivered', 'read'))
        and not exists (select 1 from email_conversation_messages m
          join email_conversations other on other.id = m.conversation_id
          where other.person_id = c.person_id and m.direction = 'outbound' and m.sent_by = 'staff'
            and m.created_at >= inbound.created_at and m.delivery_status = 'sent')
        and not exists (select 1 from support_email_conversation_messages m
          join support_email_conversations other on other.id = m.conversation_id
          where other.person_id = c.person_id and m.direction = 'outbound' and m.sent_by = 'staff'
            and m.created_at >= inbound.created_at and m.delivery_status = 'sent')
    `);
    for (const row of result.rows) {
      // Check the whole unanswered burst; "thanks" must not hide the preceding question.
      if (row.pendingBodies.every((body) => isClosingReply(body, row.previousReply ?? ""))) continue;
      items.push({
        conversationId: row.conversationId, personId: row.personId,
        firstName: row.firstName, lastName: row.lastName, channel: "sms", persona,
        lastMessagePreview: row.body, lastMessageAt: new Date(row.inboundAt).toISOString(),
        missedInboundId: row.inboundId,
        reason: "Possible missed SMS response — customer message is over 15 minutes old with no confirmed later reply. Review the thread and delivery status before replying.",
      });
    }
  }
  return items;
}

/** Dismiss only the inbound message the reviewer actually saw, never a newer one.
 * This does not clear an independently raised safety/delivery flag. */
export async function reviewMissedSmsResponse(persona: NeedsAttentionPersona, conversationId: string, inboundId: string): Promise<void> {
  const messages = persona === "alexis" ? conversationMessagesTable : supportConversationMessagesTable;
  await db.execute(sql`insert into missed_sms_response_reviews (persona, conversation_id, inbound_id)
    select ${persona}, conversation_id, id from ${messages}
      where id = ${inboundId}::uuid and conversation_id = ${conversationId}::uuid and direction = 'inbound'
    on conflict do nothing`);
}

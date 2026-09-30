import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@luma/db";
import type { UnifiedConversationSummary, UnifiedConversationPage, UnifiedConversationListOptions } from "@luma/shared";

// Identifiers come only from this fixed list; request values are SQL parameters.
const sources = [
  ["conversations", "conversation_messages", true],
  ["email_conversations", "email_conversation_messages", true],
  ["support_conversations", "support_conversation_messages", false],
  ["support_email_conversations", "support_email_conversation_messages", false],
] as const;
const threads = sql.join(sources.map(([table, messages, sales], rank) => sql`
  select c.person_id, c.id, ${rank}::int as source, ${sales}::boolean as sales,
    c.needs_attention, ${sales ? sql`c.lead_source` : sql`null::text`} as lead_source,
    latest.created_at as last_message_at, latest.id as message_id
  from ${sql.identifier(table)} c
  left join lateral (
    select id, created_at from ${sql.identifier(messages)}
    where conversation_id = c.id order by created_at desc, id desc limit 1
  ) latest on true
`), sql` union all `);
const cursorSchema = z.object({ at: z.string().datetime().nullable(), id: z.string().uuid(), filters: z.string() });
export class InvalidConversationCursor extends Error {}
function filtersKey(options: UnifiedConversationListOptions) {
  return JSON.stringify([options.search?.trim().toLowerCase() ?? "", options.leadSource ?? "all", !!options.onlyNeedsAttention]);
}

/** Keyset pagination limits preview/sentiment reads to the requested page. */
export async function listUnifiedConversationPage(options: UnifiedConversationListOptions): Promise<UnifiedConversationPage> {
  const limit = Math.min(100, Math.max(1, options.limit ?? 50));
  const filters = filtersKey(options);
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (options.cursor) {
    try {
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")));
      if (cursor.filters !== filters) throw new Error("Filters changed");
    } catch { throw new InvalidConversationCursor("Invalid conversation cursor"); }
  }
  const after = !cursor ? sql`true` : cursor.at === null
    ? sql`p.last_message_at is null and p.person_id > ${cursor.id}::uuid`
    : sql`(p.last_message_at < ${cursor.at}::timestamptz or p.last_message_at is null
        or (p.last_message_at = ${cursor.at}::timestamptz and p.person_id > ${cursor.id}::uuid))`;
  const search = options.search?.trim().toLowerCase() ?? "";
  const rows = await db.execute<UnifiedConversationSummary & { cursorAt: string | null }>(sql`
    with threads as materialized (${threads}),
    people as (
      select person_id, max(last_message_at) as last_message_at,
        bool_or(needs_attention) as needs_attention,
        bool_or(sales) as has_sales, bool_or(not sales) as has_support,
        (array_agg(lead_source order by source desc) filter (where sales))[1] as lead_source
      from threads group by person_id
    ),
    page as (
      select p.*, c.first_name, c.last_name from people p
      join customers c on c.id = p.person_id
      where ${after}
        and (${!options.onlyNeedsAttention} or p.needs_attention)
        and (${options.leadSource === undefined || options.leadSource === "all"} or p.lead_source = ${options.leadSource ?? "all"})
        and (${search === ""} or strpos(lower(c.first_name || ' ' || c.last_name), ${search}) > 0)
      order by p.last_message_at desc nulls last, p.person_id asc limit ${limit + 1}
    )
    select p.person_id as "personId", p.first_name as "firstName", p.last_name as "lastName",
      to_char(p.last_message_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "lastMessageAt",
      to_char(p.last_message_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "cursorAt",
      preview.body as "lastMessagePreview", sentiment.sentiment as "lastSentiment",
      p.needs_attention as "needsAttention", p.lead_source as "leadSource",
      p.has_sales as "hasSalesThread", p.has_support as "hasSupportThread"
    from page p
    left join lateral (
      select t.* from threads t where t.person_id = p.person_id
      order by t.last_message_at desc nulls last, t.source asc limit 1
    ) newest on true
    left join lateral (
      ${sql.join(sources.map(([, messages], rank) => sql`
        select body from ${sql.identifier(messages)} where ${rank} = newest.source and id = newest.message_id
      `), sql` union all `)}
    ) preview on true
    left join lateral (
      select sentiment from (
        ${sql.join(sources.map(([, messages], rank) => sql`
          (select sentiment, created_at, id from ${sql.identifier(messages)}
           where ${rank} = newest.source and conversation_id = newest.id and direction = 'inbound'
           order by created_at desc, id desc limit 1)
        `), sql` union all `)}
      ) inbound order by created_at desc, id desc limit 1
    ) sentiment on true
    order by p.last_message_at desc nulls last, p.person_id asc
  `);
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  const nextCursor = rows.rows.length > limit && last
    ? Buffer.from(JSON.stringify({ at: last.cursorAt, id: last.personId, filters })).toString("base64url") : null;
  const conversations = visible.map(({ cursorAt: _, ...row }) => row);
  const version = createHash("sha256").update(JSON.stringify({ conversations, nextCursor })).digest("hex");
  return { conversations, nextCursor, version };
}

/** Global count, independent of loaded pages and active filters. */
export async function countUnifiedAttention(): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    select count(distinct t.person_id)::int as count from (
      ${sql.join(sources.map(([table]) => sql`select person_id from ${sql.identifier(table)} where needs_attention`), sql` union all `)}
    ) t join customers c on c.id = t.person_id
  `);
  return result.rows[0]?.count ?? 0;
}

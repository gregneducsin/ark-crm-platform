import { getIncompleteOnboardingCount } from "./incomplete-onboarding-count.service.js";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import {
  customersSummaryQuerySchema,
  listCustomersQuerySchema,
  purchasesSummaryQuerySchema,
  listPurchasesQuerySchema,
  questionnairesQuerySchema,
  type AiAssistantMessage,
} from "@luma/shared";
import { getFilteredLeadCount } from "./filtered-lead-count.service.js";
import { getDtcLeadCount } from "./dtc-lead-count.service.js";
import * as customersService from "./customers.service.js";
import * as purchasesService from "./purchases.service.js";
import * as questionnairesService from "./questionnaires.service.js";
import * as marketingSpendService from "./marketing-spend.service.js";
import * as employeesService from "./employees.service.js";
import * as payrollWeeksService from "./payroll-weeks.service.js";
import * as botEngagementService from "./bot-engagement.service.js";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not configured.");
  }
  if (!cachedClient) {
    cachedClient = new Anthropic();
  }
  return cachedClient;
}

const periodSchema = z
  .union([z.number().int().positive(), z.literal("all")])
  .optional()
  .describe('Trailing number of days to include, or "all" for no date filter. Defaults to 30 if omitted. Ignored if dateFrom/dateTo are given.');

// Shared by every summary tool below — an explicit calendar range (e.g. "last
// Friday to today") is a fixed window that no relative trailing-day period
// can express exactly. Compute the actual YYYY-MM-DD values yourself from
// today's date (given in the system prompt) rather than approximating with
// period whenever the question names or implies specific dates.
const dateRangeFields = {
  dateFrom: z.string().optional().describe("YYYY-MM-DD, inclusive. Use for an exact calendar range instead of period."),
  dateTo: z.string().optional().describe("YYYY-MM-DD, inclusive. Use for an exact calendar range instead of period."),
};

// Every tool is a read-only wrapper around an existing service function — the
// assistant never gets raw SQL or write access, only the same business logic
// (first-touch attribution, recurring-purchase exclusion, etc.) the
// dashboard itself uses, so its answers can't diverge from what's on screen.
const tools = [
  betaZodTool({
    name: "get_incomplete_onboarding_count",
    description: "Count current unmatched SMS texters who have not become linked saved leads, separately from saved lead totals. One sender thread with inbound texts counts once. Excludes linked contacts, phone matches to saved customers, dismissed and spam threads. Dates filter first recorded inbound SMS date, not last activity. All SMS sources, not verified DTC. Also returns needsReview and held counts, which may overlap.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async (input) => JSON.stringify(await getIncompleteOnboardingCount(customersSummaryQuerySchema.parse(input))),
  }),
  betaZodTool({
    name: "get_filtered_lead_count",
    description: "Exact saved-lead count by segment. Meta form-fill and questionnaire use the dashboard's mutually exclusive first-touch sources; SMS Inquiry uses its saved leadType. For another exact saved lead-type label use lead_type and supply leadType. Does not count unmatched texters. Date bounds filter lead-received date. No pagination is needed.",
    inputSchema: z.object({
      segment: z.enum(["meta_form_fill", "questionnaire", "sms_inquiry", "lead_type"]),
      leadType: z.string().optional().describe("Required for lead_type: exact saved label. Use list_lead_types if unknown."),
      period: periodSchema, ...dateRangeFields,
    }),
    run: async ({ segment, leadType, ...input }) => JSON.stringify(await getFilteredLeadCount(customersSummaryQuerySchema.parse(input), segment, leadType)),
  }),
  betaZodTool({
    name: "list_lead_types",
    description: "List exact saved lead-type labels. Use before counting a label you do not recognize; never guess its spelling.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await customersService.listDistinctLeadTypes()),
  }),
  betaZodTool({
    name: "get_dtc_lead_count",
    description: "Exact count and conversion summary of saved DTC (direct-to-consumer / text-us-directly ad) leads, filtered by lead-received date. Returns total, purchased, notPurchased and conversionRate (percentage rounded to one decimal, null when no leads). Purchased means a completed first_order, counted once per customer regardless of purchase date. Use for DTC purchase counts and conversion rates as well as lead counts. Use for how many DTC leads, not get_leads_summary or paginated rows. Excludes unmatched texting contacts not yet saved as leads; their count is unavailable from this tool, not zero.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async (input) => JSON.stringify(await getDtcLeadCount(customersSummaryQuerySchema.parse(input))),
  }),
  betaZodTool({
    name: "get_leads_summary",
    description:
      "Get lead/customer summary totals for a time period: total leads, leads sourced from Meta form fill vs questionnaire (first-touch, no double-counting), purchased vs not purchased, and conversion rate. A lead only counts as 'purchased' if it has a completed first-order purchase. For an exact calendar range (e.g. \"last Friday to today\"), pass dateFrom/dateTo instead of period.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async ({ period, dateFrom, dateTo }) => {
      const parsed = customersSummaryQuerySchema.parse({ period, dateFrom, dateTo });
      return JSON.stringify(await customersService.getCustomersSummary(parsed));
    },
  }),
  betaZodTool({
    name: "list_leads",
    description:
      "List individual leads/customers with optional filters. Use this for specific leads or example rows, not aggregate counts. Use get_dtc_lead_count for DTC, get_filtered_lead_count for segments, get_incomplete_onboarding_count for unmatched texters, and get_leads_summary for overall totals. Returns total alongside rows; page with offset only when individual records are needed.",
    inputSchema: z.object({
      search: z.string().optional().describe("Search by name, email, or phone."),
      leadType: z.string().optional(),
      purchaseStatus: z.enum(["purchased", "not_purchased"]).optional(),
      dateFrom: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by lead-received date."),
      dateTo: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by lead-received date."),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional().describe("Skip this many matching rows — use with limit to page past the first batch."),
    }),
    run: async (input) => {
      const parsed = listCustomersQuerySchema.parse({ ...input, limit: input.limit ?? 10 });
      const { customers, total } = await customersService.listCustomers(parsed);
      const rows = customers.map((c) => ({
        name: `${c.firstName} ${c.lastName}`,
        email: c.email,
        leadType: c.leadType,
        leadReceivedDate: c.leadReceivedDate,
        purchaseCount: c.purchaseCount,
        totalPaid: c.totalPaid,
      }));
      return JSON.stringify({ total, rows });
    },
  }),
  betaZodTool({
    name: "get_orders_summary",
    description:
      "Get order/purchase summary totals for a time period: purchasing customers, total revenue, completed orders, new (first-order) customers, and recurring customers. Only completed orders count. For an exact calendar range (e.g. \"last Friday to today\"), pass dateFrom/dateTo instead of period.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async ({ period, dateFrom, dateTo }) => {
      const parsed = purchasesSummaryQuerySchema.parse({ period, dateFrom, dateTo });
      return JSON.stringify(await purchasesService.getPurchasesSummary(parsed));
    },
  }),
  betaZodTool({
    name: "list_orders",
    description:
      "List individual orders/purchases, optionally filtered to new (first_order) or recurring only, or by date. Returns `total` alongside the returned rows — if total exceeds the rows returned, pass a larger offset to page through the rest.",
    inputSchema: z.object({
      orderClassification: z.enum(["first_order", "recurring", "unknown"]).optional(),
      dateFrom: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by purchase date."),
      dateTo: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by purchase date."),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional().describe("Skip this many matching rows — use with limit to page past the first batch."),
    }),
    run: async (input) => {
      const parsed = listPurchasesQuerySchema.parse({ ...input, limit: input.limit ?? 10 });
      const { purchases, total } = await purchasesService.listPurchases(parsed);
      const rows = purchases.map((p) => ({
        customer: `${p.customerFirstName} ${p.customerLastName}`,
        purchaseDate: p.purchaseDate,
        productName: p.productName,
        amountPaid: p.amountPaid,
        status: p.status,
        orderClassification: p.orderClassification,
      }));
      return JSON.stringify({ total, rows });
    },
  }),
  betaZodTool({
    name: "get_questionnaires_performance",
    description:
      "Get questionnaire performance for a time period: leads with a questionnaire, first-time customers, completed purchases, total revenue, conversion rate, plus a per-questionnaire-ID breakdown (leads, customers, conversion rate, purchases, revenue, avg order value, last purchase date). 'Within the period' is judged by questionnaire activity date. For an exact calendar range, pass dateFrom/dateTo instead of period.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async ({ period, dateFrom, dateTo }) => {
      const parsed = questionnairesQuerySchema.parse({ period, dateFrom, dateTo });
      return JSON.stringify(await questionnairesService.getQuestionnairesData(parsed));
    },
  }),
  betaZodTool({
    name: "get_marketing_cpa_weeks",
    description:
      "Get Marketing CPA data for every Friday-to-Thursday period on record: ad spend, cost per acquisition, leads received, closed deals, acquisition revenue, conversion rate, avg days to close, still-open count, and recurring-purchase exclusions, broken down by Meta Form Fill, E-commerce, and Combined. A 'closed deal' is a lead that entered the CRM in that specific week and later made a first-order purchase — recurring purchases from older leads never count toward a week's figures.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await marketingSpendService.listMarketingCpaWeeks()),
  }),
  betaZodTool({
    name: "get_bot_engagement_summary",
    description:
      "For leads who made a qualifying (first-order, completed) purchase in a period: how many actually replied to Alexis (SMS or email, a real two-way exchange, not just receiving the automated opener) before buying vs how many never did, and the average days from lead-received to purchase for each group. Use this for questions like 'how many people who purchased talked to the bot' or 'does talking to the bot speed up or slow down closing.' For an exact calendar range, pass dateFrom/dateTo instead of period.",
    inputSchema: z.object({ period: periodSchema, ...dateRangeFields }),
    run: async ({ period, dateFrom, dateTo }) => {
      const parsed = customersSummaryQuerySchema.parse({ period, dateFrom, dateTo });
      return JSON.stringify(await botEngagementService.getBotEngagementSummary(parsed));
    },
  }),
  betaZodTool({
    name: "list_employees",
    description: "List all payroll employees with their hourly rate and status.",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await employeesService.listEmployees()),
  }),
  betaZodTool({
    name: "get_payroll_weeks",
    description: "List payroll weeks and their status (draft, approved, paid).",
    inputSchema: z.object({}),
    run: async () => JSON.stringify(await payrollWeeksService.listPayrollWeeks()),
  }),
];

function systemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the data assistant embedded in Ark Health's internal operations dashboard (a healthcare customer/order/payroll CRM). Today's date is ${today}.

Answer questions about leads, orders, questionnaires, marketing CPA, and payroll using the tools available. Never guess, round, or estimate a number you could look up — call a tool and cite the exact figure it returns.

Key domain rules to keep in mind when interpreting tool results:
- For incomplete onboarding or people who texted but are not saved leads, use get_incomplete_onboarding_count. Report "unmatched texters" separately from saved leads; count sender threads, not verified unique people. Date bounds refer to first inbound SMS date (UTC), and counts reflect current unresolved status. Do not label these all DTC, add them to saved DTC totals, or claim they are historical drop-offs. needsReview and held are overlapping subsets, not additional leads. State the selected period; use period "all" for all current incomplete onboarding.
- When asked for saved DTC leads plus incomplete onboarding, call both tools and present separate labeled counts. The incomplete-onboarding tool provides all-source unmatched counts, not DTC attribution.
- For SMS Inquiry counts use get_filtered_lead_count with sms_inquiry. For Meta form-fill counts use meta_form_fill; for questionnaire-source lead counts use questionnaire. Both source counts match dashboard first-touch attribution, not saved lead-type labels. Say "Meta form-fill leads" or "questionnaire-source leads" in the answer. DTC is a separate text-ad segment; do not present Meta form-fill counts as all Meta advertising leads or add source and lead-type counts together.
- If "Meta leads" is ambiguous between form fills and all Meta advertising including DTC, give the Meta form-fill count with that explicit label; offer DTC separately rather than inventing a combined count.
- For an explicitly named saved lead-type label use lead_type and its exact stored label (discover with list_lead_types if needed). For people who completed questionnaires regardless of source, use get_questionnaires_performance instead.
- Filtered counts return the actual dateFrom/dateTo: use those bounds verbatim, do not recalculate them. Null dateTo means no upper date filter. Unmatched contacts are excluded, not zero.
- DTC means direct-to-consumer, the text-us-directly advertising leads stored with leadType "DTC". For DTC counts always use get_dtc_lead_count. Report its exact total as "saved DTC leads". Use the returned dateFrom/dateTo verbatim for calendar bounds; never infer a different start date from period. A null dateTo means no upper date filter. These exclude unmatched texting contacts still awaiting onboarding/name/email; do not claim their count is zero or combine them with the saved count. If asked for all initial DTC texters, explain that this tool only counts saved leads; the incomplete-onboarding tool can separately count all-source unmatched texters but cannot establish their DTC attribution.
- For DTC purchases and conversion rates use get_dtc_lead_count, never overall order totals or list rows. Report purchased out of total saved DTC leads and the returned percentage. Date filters select when leads arrived; purchases can occur later. Label this as conversion of leads received in that range, not purchases made in the range. A null conversionRate means no leads and must be reported as N/A, not 0%. Failed, pending, refunded, cancelled, recurring-only and unclassified orders do not qualify.\n- For a count, a tool's total is authoritative; never count returned sample rows or paginate merely to count.
- "Purchased" only means a completed, first-order purchase — a recurring-only purchase does not count as a lead having converted.
- Marketing CPA weeks run Friday through Thursday. A closed deal in a given week is a lead that was *received* that week and later converted — not a lead that merely purchased that week.
- Lead source (Meta Form Fill vs Questionnaire) is first-touch attributed — a lead is never double-counted across sources.
- "Talked to the bot" (get_bot_engagement_summary) means the customer actually replied — SMS or email — before their purchase date, not merely receiving the automated opener text. Sophie's support conversations (which only start after a purchase) are excluded from this since they can't have happened "before" it.
- Whenever a question names or implies specific dates ("last Friday to today," "since the 18th," "in August") rather than a rolling window ("last 30 days," "this week"), compute the exact YYYY-MM-DD dateFrom/dateTo yourself from today's date above and pass those instead of period — period is only a trailing-day count and can't express a fixed calendar range exactly.
- The list tools (list_leads, list_orders) return a "total" field alongside the rows. If total is larger than the rows you got back, call again with a larger offset to see the rest rather than reporting only the first batch as the complete answer.

This is an internal staff tool. Answer business reporting questions directly using the available tools. State a brief limitation when the returned data does not cover the requested scope; unavailable data is not zero. If a question falls outside what these tools cover, say so in one sentence rather than guessing.

Keep every answer short by default: the number(s) asked for, in one or two sentences or a short list, in plain business language (not JSON or code) — no extra background, methodology, or unsolicited context. The user will ask a follow-up if they want more detail, so don't front-load it. If a time period isn't specified, default to the last 30 days and say so in that same short answer.`;
}

export async function askAssistant(question: string, history: AiAssistantMessage[] = []): Promise<string> {
  const client = getClient();

  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: question },
  ];

  const finalMessage = await client.beta.messages.toolRunner({
    model: "claude-opus-5",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: systemPrompt(),
    tools,
    messages,
    max_iterations: 8,
  });

  const textBlock = finalMessage.content.find((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === "text");
  return textBlock?.text ?? "I wasn't able to come up with an answer to that — could you rephrase the question?";
}

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
  .describe('Trailing number of days to include, or "all" for no date filter. Defaults to 30 if omitted.');

// Every tool is a read-only wrapper around an existing service function — the
// assistant never gets raw SQL or write access, only the same business logic
// (first-touch attribution, recurring-purchase exclusion, etc.) the
// dashboard itself uses, so its answers can't diverge from what's on screen.
const tools = [
  betaZodTool({
    name: "get_leads_summary",
    description:
      "Get lead/customer summary totals for a time period: total leads, leads sourced from Meta form fill vs questionnaire (first-touch, no double-counting), purchased vs not purchased, and conversion rate. A lead only counts as 'purchased' if it has a completed first-order purchase.",
    inputSchema: z.object({ period: periodSchema }),
    run: async ({ period }) => {
      const parsed = customersSummaryQuerySchema.parse({ period: period ?? 30 });
      return JSON.stringify(await customersService.getCustomersSummary(parsed));
    },
  }),
  betaZodTool({
    name: "list_leads",
    description:
      "List individual leads/customers with optional filters. Use this to answer questions about specific leads, or to see example rows, not for aggregate counts (use get_leads_summary for those).",
    inputSchema: z.object({
      search: z.string().optional().describe("Search by name, email, or phone."),
      leadType: z.string().optional(),
      purchaseStatus: z.enum(["purchased", "not_purchased"]).optional(),
      dateFrom: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by lead-received date."),
      dateTo: z.string().optional().describe("YYYY-MM-DD, inclusive, filters by lead-received date."),
      limit: z.number().int().min(1).max(25).optional(),
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
      "Get order/purchase summary totals for a time period: purchasing customers, total revenue, completed orders, new (first-order) customers, and recurring customers. Only completed orders count.",
    inputSchema: z.object({ period: periodSchema }),
    run: async ({ period }) => {
      const parsed = purchasesSummaryQuerySchema.parse({ period: period ?? 30 });
      return JSON.stringify(await purchasesService.getPurchasesSummary(parsed));
    },
  }),
  betaZodTool({
    name: "list_orders",
    description: "List individual orders/purchases, optionally filtered to new (first_order) or recurring only.",
    inputSchema: z.object({
      orderClassification: z.enum(["first_order", "recurring", "unknown"]).optional(),
      limit: z.number().int().min(1).max(25).optional(),
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
      "Get questionnaire performance for a time period: leads with a questionnaire, first-time customers, completed purchases, total revenue, conversion rate, plus a per-questionnaire-ID breakdown (leads, customers, conversion rate, purchases, revenue, avg order value, last purchase date). 'Within the period' is judged by questionnaire activity date.",
    inputSchema: z.object({ period: periodSchema }),
    run: async ({ period }) => {
      const parsed = questionnairesQuerySchema.parse({ period: period ?? 30 });
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
      "For leads who made a qualifying (first-order, completed) purchase in a period: how many actually replied to Alexis (SMS or email, a real two-way exchange, not just receiving the automated opener) before buying vs how many never did, and the average days from lead-received to purchase for each group. Use this for questions like 'how many people who purchased talked to the bot' or 'does talking to the bot speed up or slow down closing.'",
    inputSchema: z.object({ period: periodSchema }),
    run: async ({ period }) => {
      const parsed = customersSummaryQuerySchema.parse({ period: period ?? 30 });
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
- "Purchased" only means a completed, first-order purchase — a recurring-only purchase does not count as a lead having converted.
- Marketing CPA weeks run Friday through Thursday. A closed deal in a given week is a lead that was *received* that week and later converted — not a lead that merely purchased that week.
- Lead source (Meta Form Fill vs Questionnaire) is first-touch attributed — a lead is never double-counted across sources.
- "Talked to the bot" (get_bot_engagement_summary) means the customer actually replied — SMS or email — before their purchase date, not merely receiving the automated opener text. Sophie's support conversations (which only start after a purchase) are excluded from this since they can't have happened "before" it.

This is an internal staff tool with full access to the business's own operational data — there is nothing here to refuse or hedge on. If a question is about leads, orders, CPA, or payroll and a tool can answer it, answer it directly and exactly, with no disclaimers or caveats. If a question genuinely falls outside what these tools cover, say so in one sentence rather than guessing.

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

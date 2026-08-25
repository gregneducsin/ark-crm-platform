import { describe, expect, it, vi } from "vitest";
import { db, customersTable } from "@luma/db";
import { getOrCreateConversation, appendMessage, updateConversationState } from "./conversations.service.js";
import { getOrCreateSupportConversation, appendSupportMessage, updateSupportConversationState } from "./support-conversations.service.js";
import { getOrCreateEmailConversation, appendEmailMessage, updateEmailConversationState } from "./email-conversations.service.js";
import { getOrCreateSupportEmailConversation, appendSupportEmailMessage, updateSupportEmailConversationState } from "./support-email-conversations.service.js";
import { listNeedsAttention, getNeedsAttentionMessages, clearNeedsAttentionItem } from "./needs-attention.service.js";

const notifySlackMock = vi.fn();
vi.mock("../lib/slack.js", () => ({ notifySlack: (...args: unknown[]) => notifySlackMock(...args) }));

async function seedCustomer(firstName: string): Promise<string> {
  const [row] = await db
    .insert(customersTable)
    .values({ firstName, lastName: "Attention", email: `attention-${crypto.randomUUID()}@example.com`, leadReceivedDate: "2026-08-15" })
    .returning({ id: customersTable.id });
  return row.id;
}

describe("listNeedsAttention", () => {
  it("returns flagged conversations across all 4 channels and excludes unflagged ones", async () => {
    const alexisSmsPerson = await seedCustomer("AlexisSms");
    const alexisSmsConvo = await getOrCreateConversation(alexisSmsPerson);
    await appendMessage(alexisSmsConvo.id, "inbound", "help, I have a medical question", {});
    await updateConversationState(alexisSmsConvo.id, { needsAttention: true });

    const sophieSmsPerson = await seedCustomer("SophieSms");
    const sophieSmsConvo = await getOrCreateSupportConversation(sophieSmsPerson);
    await appendSupportMessage(sophieSmsConvo.id, "inbound", "is this covered by insurance", {});
    await updateSupportConversationState(sophieSmsConvo.id, { needsAttention: true });

    const alexisEmailPerson = await seedCustomer("AlexisEmail");
    const alexisEmailConvo = await getOrCreateEmailConversation(alexisEmailPerson);
    await appendEmailMessage(alexisEmailConvo.id, "inbound", "Question", "what state am I in for this", {});
    await updateEmailConversationState(alexisEmailConvo.id, { needsAttention: true });

    const sophieEmailPerson = await seedCustomer("SophieEmail");
    const sophieEmailConvo = await getOrCreateSupportEmailConversation(sophieEmailPerson);
    await appendSupportEmailMessage(sophieEmailConvo.id, "inbound", "Re: order", "emergency, please call me", {});
    await updateSupportEmailConversationState(sophieEmailConvo.id, { needsAttention: true });

    const notFlaggedPerson = await seedCustomer("NotFlagged");
    await getOrCreateConversation(notFlaggedPerson);

    const items = await listNeedsAttention();
    const byPerson = Object.fromEntries(items.map((i) => [i.personId, i]));

    expect(byPerson[alexisSmsPerson]).toMatchObject({ channel: "sms", persona: "alexis" });
    expect(byPerson[sophieSmsPerson]).toMatchObject({ channel: "sms", persona: "sophie" });
    expect(byPerson[alexisEmailPerson]).toMatchObject({ channel: "email", persona: "alexis" });
    expect(byPerson[sophieEmailPerson]).toMatchObject({ channel: "email", persona: "sophie" });
    expect(byPerson[notFlaggedPerson]).toBeUndefined();
  });
});

describe("getNeedsAttentionMessages", () => {
  it("returns the email conversation's recent messages with subjects, oldest first", async () => {
    const personId = await seedCustomer("EmailHistory");
    const convo = await getOrCreateEmailConversation(personId);
    await appendEmailMessage(convo.id, "inbound", "First subject", "first body", {});
    await appendEmailMessage(convo.id, "outbound", "Second subject", "second body", {});

    const messages = await getNeedsAttentionMessages("email", "alexis", convo.id);
    expect(messages.map((m) => m.subject)).toEqual(["First subject", "Second subject"]);
    expect(messages.map((m) => m.direction)).toEqual(["inbound", "outbound"]);
  });

  it("returns the SMS conversation's recent messages with a null subject", async () => {
    const personId = await seedCustomer("SmsHistory");
    const convo = await getOrCreateConversation(personId);
    await appendMessage(convo.id, "inbound", "hi there", {});

    const messages = await getNeedsAttentionMessages("sms", "alexis", convo.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBeNull();
    expect(messages[0].body).toBe("hi there");
  });
});

describe("clearNeedsAttentionItem", () => {
  it("clears the flag for each of the 4 channel/persona combinations", async () => {
    const alexisSmsPerson = await seedCustomer("ClearAlexisSms");
    const alexisSmsConvo = await getOrCreateConversation(alexisSmsPerson);
    await updateConversationState(alexisSmsConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("sms", "alexis", alexisSmsConvo.id);

    const sophieSmsPerson = await seedCustomer("ClearSophieSms");
    const sophieSmsConvo = await getOrCreateSupportConversation(sophieSmsPerson);
    await updateSupportConversationState(sophieSmsConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("sms", "sophie", sophieSmsConvo.id);

    const alexisEmailPerson = await seedCustomer("ClearAlexisEmail");
    const alexisEmailConvo = await getOrCreateEmailConversation(alexisEmailPerson);
    await updateEmailConversationState(alexisEmailConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("email", "alexis", alexisEmailConvo.id);

    const sophieEmailPerson = await seedCustomer("ClearSophieEmail");
    const sophieEmailConvo = await getOrCreateSupportEmailConversation(sophieEmailPerson);
    await updateSupportEmailConversationState(sophieEmailConvo.id, { needsAttention: true });
    await clearNeedsAttentionItem("email", "sophie", sophieEmailConvo.id);

    const items = await listNeedsAttention();
    const flaggedPersonIds = new Set(items.map((i) => i.personId));
    for (const personId of [alexisSmsPerson, sophieSmsPerson, alexisEmailPerson, sophieEmailPerson]) {
      expect(flaggedPersonIds.has(personId)).toBe(false);
    }
  });
});

describe("Slack alert on needsAttention — all 4 channels", () => {
  it("alerts once per channel when a conversation is first flagged", async () => {
    notifySlackMock.mockClear();

    const alexisSmsPerson = await seedCustomer("SlackAlexisSms");
    const alexisSmsConvo = await getOrCreateConversation(alexisSmsPerson);
    await updateConversationState(alexisSmsConvo.id, { needsAttention: true, needsAttentionReason: "alexis sms reason" });

    const sophieSmsPerson = await seedCustomer("SlackSophieSms");
    const sophieSmsConvo = await getOrCreateSupportConversation(sophieSmsPerson);
    await updateSupportConversationState(sophieSmsConvo.id, { needsAttention: true, needsAttentionReason: "sophie sms reason" });

    const alexisEmailPerson = await seedCustomer("SlackAlexisEmail");
    const alexisEmailConvo = await getOrCreateEmailConversation(alexisEmailPerson);
    await updateEmailConversationState(alexisEmailConvo.id, { needsAttention: true, needsAttentionReason: "alexis email reason" });

    const sophieEmailPerson = await seedCustomer("SlackSophieEmail");
    const sophieEmailConvo = await getOrCreateSupportEmailConversation(sophieEmailPerson);
    await updateSupportEmailConversationState(sophieEmailConvo.id, { needsAttention: true, needsAttentionReason: "sophie email reason" });

    expect(notifySlackMock).toHaveBeenCalledTimes(4);
    const messages = notifySlackMock.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => m.includes("alexis sms reason"))).toBe(true);
    expect(messages.some((m) => m.includes("sophie sms reason"))).toBe(true);
    expect(messages.some((m) => m.includes("alexis email reason"))).toBe(true);
    expect(messages.some((m) => m.includes("sophie email reason"))).toBe(true);
  });
});

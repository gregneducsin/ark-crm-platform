import { describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sales: vi.fn(), support: vi.fn() }));
vi.mock("../lib/messaging/provider.js", () => ({ ProviderError: class extends Error {}, callClaudeInteractive: mocks.sales }));
vi.mock("../lib/support/provider.js", () => ({ SophieProviderError: class extends Error {}, callSophieInteractive: mocks.support }));
vi.mock("./intake-links.service.js", () => ({ createIntakeLink: () => { throw new Error("No intake links in this test"); } }));
vi.mock("../lib/logger.js", () => ({ logger: { warn: () => {}, error: () => {}, info: () => {} } }));
import { runAlexisTurn } from "./alexis-conversation.service.js";
import { runSophieTurn } from "./sophie-conversation.service.js";
function baseBody(overrides: any = {}) {
  return {
    messages: [{ direction: "inbound", body: "Hi, I'm interested in learning more." }],
    leadSource: "abandoned_cart",
    currentSlots: {
      selectedProduct: null,
      currentlyTaking: null,
      wantsProcessExplanation: null,
      hasTimeForIntake: null,
      wantsPlanInclusions: null,
      readyForForm: null,
      planLength: null,
      dosagePreference: null,
      startTimingPreference: null,
      state: null,
    },
    lastQuestion: null,
    pendingTopic: null,
    lastDraft: null,
    objectionStage: 0,
    objectionKey: null,
    linkProvided: false,
    promoOffered: false,
    consumerAffairsCart: false,
    customerFirstName: "Test",
    ...overrides,
  };
}


const inbound = (body: string) => ({ direction: "inbound" as const, body });
const outbound = (body: string) => ({ direction: "outbound" as const, body });
const supportBody = (messages: ReturnType<typeof inbound>[]) => ({ messages, orderState: { prescriptionWritten: false, orderShipped: false, trackingNumber: null, paymentFailed: false }, reviewRequested: false, lastQuestion: null, pendingTopic: null, lastDraft: null });
describe("unhandled inbound safety across rapid texts", () => {
  for (const reverse of [false, true]) {
    it.each([
      ["This is an emergency", "EMERGENCY_CONTENT"],
      ["I have chest pain", "EMERGENCY_CONTENT"],
      ["I feel nauseous", "SIDE_EFFECT_REPORT"],
      ["STOP", "OPT_OUT"],
      ["I will contact my attorney", "LEGAL_CONTENT"],
    ])("sales retains %s with a second text (reverse=${reverse})", async (text, code) => {
      mocks.sales.mockClear();
      const messages = [inbound(text), inbound("Hello")]; if (reverse) messages.reverse();
      const result = await runAlexisTurn("synthetic", baseBody({ messages }));
      expect(result).toMatchObject({ ok: true, preCheckCode: code, source: "pre_check_block" });
      expect(mocks.sales).not.toHaveBeenCalled();
    });
    it.each([
      ["This is an emergency", "EMERGENCY_CONTENT"],
      ["I have chest pain", "EMERGENCY_CONTENT"],
      ["Please reschedule my shipment", "ACCOUNT_CHANGE_REQUEST"],
      ["How many mg should I take?", "PRESCRIPTION_QUESTION"],
      ["STOP", "OPT_OUT"],
    ])("support retains %s with a second text (reverse=${reverse})", async (text, code) => {
      mocks.support.mockClear();
      const messages = [inbound(text), inbound("Hello")]; if (reverse) messages.reverse();
      const result = await runSophieTurn(supportBody(messages));
      expect(result).toMatchObject({ ok: true, preCheckCode: code, source: "pre_check_block" });
      expect(mocks.support).not.toHaveBeenCalled();
    });
  }
  it("gives consent and emergencies priority over other pending requests", async () => {
    const messages = [inbound("Please reschedule my shipment"), inbound("This is an emergency"), inbound("Hello")];
    expect(await runSophieTurn(supportBody(messages))).toMatchObject({ preCheckCode: "EMERGENCY_CONTENT" });
    expect(await runAlexisTurn("synthetic",baseBody({messages}))).toMatchObject({ preCheckCode: "EMERGENCY_CONTENT" });
    messages.push(inbound("STOP"));
    expect(await runSophieTurn(supportBody(messages))).toMatchObject({ preCheckCode: "OPT_OUT" });
    expect(await runAlexisTurn("synthetic",baseBody({messages}))).toMatchObject({ preCheckCode: "OPT_OUT" });
  });
  it("does not re-escalate a handled older message on a new ordinary turn", async () => {
    mocks.sales.mockImplementation(()=>{throw new Error("MODEL_REACHED")});
    mocks.support.mockImplementation(()=>{throw new Error("MODEL_REACHED")});
    const messages = [inbound("This is an emergency"),outbound("Synthetic staff reply."),inbound("Hello")];
    await expect(runAlexisTurn("synthetic",baseBody({messages}))).rejects.toThrow("MODEL_REACHED");
    await expect(runSophieTurn({ ...supportBody([]),messages })).rejects.toThrow("MODEL_REACHED");
  });
});

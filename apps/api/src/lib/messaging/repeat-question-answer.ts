/** Only accepts a turn that already passed the persona's independent field checks. */
export function selectRepeatQuestionAnswer(turn: {
  source: string;
  preCheckCode: string | null;
  requiresStaff: boolean;
  action: string;
  reply: string | null;
}, lastDraft: string | null): string | null {
  // In particular, Alexis's last-resort safety/format exceptions must not use
  // this path. Do not salvage rejected turns or staff/medical escalations.
  if (turn.source !== "model" || turn.preCheckCode !== null || turn.requiresStaff ||
      !["reply", "ask_product", "explain_process", "explain_pricing", "explain_inclusions"].includes(turn.action)) return null;
  const reply = turn.reply?.trim();
  if (!reply || reply.includes("?") || /[:;,]$/.test(reply)) return null;
  if (/\b(?:please (?:confirm|tell|choose|share)|(?:could|would) you|let me know)\b/i.test(reply)) return null;
  const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
  if (lastDraft && normalize(reply) === normalize(lastDraft)) return null;
  // Exclude standalone acknowledgments and question setup. Keep the original
  // validated text intact; stripping here is only for the usefulness check.
  const content = reply.replace(/^(?:(?:okay|ok|got it|thanks|thank you|understood|sure|great|perfect|no problem|happy to help|i understand|totally understand)[!.,\s]*)+/i, "").trim();
  if (content.split(/\s+/).length < 4 || content.length < 20) return null;
  if (/^(?:what|which|where|when|who|how|that (?:makes sense|sounds)|for (?:letting|sharing|confirming)|just (?:to clarify|checking|want to clarify)|before (?:we|i)|one (?:more|last) (?:thing|question)|(?:could|can|would|will) you|please (?:confirm|tell|choose|share)|let me know|(?:here|these|those) (?:are|is) (?:the|your) (?:options|details)|thanks? for|thank you for)/i.test(content)) return null;
  return reply;
}

/**
 * Customer statements only, newest first. Never infer financing approval,
 * a discount, payment dates or account actions from an objection.
 */
export function renderConcernFollowUp(firstName: string, newestInbound: readonly string[], objectionKey?: string | null): string | null {
  const name = firstName.trim() || "there";
  for (const raw of newestInbound) {
    const body = raw.replace(/’/g, "'").replace(/\bit's\b/gi, "it is");
    if (/\b(?:all (?:fixed|sorted|resolved)|(?:it|that|issue|problem) (?:is |was )?(?:fixed|resolved)|works now|working now|price works|cost is fine|never mind|nevermind)\b/i.test(body)) return null;
    if (/\b(?:too expensive|can't afford|cannot afford|budget|costs? too much|cheaper|less expensive|can't pay|cannot pay|not afford|wait until|payday)\b/i.test(body)) {
      return "Hi " + name + ", I understand cost or payment timing was a concern. Would you like to go over the available options?";
    }
    if (/\b(?:checkout|check out|payment|pay|form|link|email)\b/i.test(body) &&
        /\b(?:where|how|can't|cannot|couldn't|won't|haven't|didn't|not|missing|wrong|error|issue|problem|concern|confused|help|find)\b/i.test(body)) {
      return "Hi " + name + ", following up on your question about the form or checkout. Would you like help with that step?";
    }
  }
  if (objectionKey === "price") return "Hi " + name + ", I understand cost was a concern. Would you like to go over the available options?";
  return null;
}

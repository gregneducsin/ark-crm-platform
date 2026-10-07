/** Narrow signals about the messaging experience, not medication effectiveness. */
export function isMessagingFeedback(text: string): boolean {
  return /\b(?:chat\s*bot|chatbot|robot|automated|ai\s+(?:chat|bot)|messaging system)\b/i.test(text) &&
    /\b(?:delay|timing|too fast|too quick|believable|pretend|acting like|recommendation|complaint|human|person)\b/i.test(text)
    || /\b(?:you|you're|you are|your bot)\b[\s\S]{0,60}\b(?:keep asking|already (?:answered|told)|repeating|same question|not listening)\b/i.test(text);
}

/** Do not turn a stated support plan into another engagement question. */
export function hasStatedSupportPlan(text: string): boolean {
  const plan = /\b(?:i|we)(?:'ll|’ll| will| are going to| am going to)\s+(?:stick with|continue|give it a go|give it (?:some|more) time)\b/i.exec(text);
  return Boolean(plan) && !/\?|\b(?:unless|if|help|concern|problem|please|refund|cancel|need|want|where|when|what|how)\b|\b(?:can|could|would) you\b/i.test(text) &&
    !/\bbut\b/i.test(text.slice((plan?.index ?? 0) + (plan?.[0].length ?? 0)));
}

export function omitGenericSupportQuestion<T extends { nextQuestion: string | null }>(turn: T): T {
  const question = turn.nextQuestion?.trim() ?? "";
  return /^(?:(?:is there|do you need)\s+)?anything else\b|^\b(?:can|is there anything)\s+(?:i|we)\s+help\b/i.test(question)
    ? { ...turn, nextQuestion: null } : turn;
}

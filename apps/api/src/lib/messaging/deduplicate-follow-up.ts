/**
 * Remove a verbatim trailing copy of nextQuestion from reply before safety
 * validation. Case, whitespace and punctuation may differ (including a missing
 * question mark). Never use fuzzy word overlap to delete customer-facing text.
 * The retained nextQuestion still goes through every normal safety check.
 */
export function deduplicateFollowUp<T extends { reply: string | null; nextQuestion: string | null }>(turn: T): T {
  const question = turn.nextQuestion?.trim();
  if (!turn.reply || !question || !question.endsWith("?") || (question.match(/\?/g)?.length ?? 0) !== 1) return turn;
  // Do not split URLs, contractions, or numbers into unrelated word fragments.
  const tokens = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)];
  const normalize = (text: string) => text.toLowerCase().replace(/’/g, "'");
  const questionWords = tokens(question).map((word) => normalize(word[0]));
  if (questionWords.length < 3 || /https?:\/\//i.test(question)) return turn;
  let reply = turn.reply.trim();
  let changed = false;
  while (reply) {
    const words = tokens(reply);
    const tail = words.slice(-questionWords.length);
    if (tail.length !== questionWords.length || !tail.every((word, i) => normalize(word[0]) === questionWords[i])) break;
    const start = tail[0].index!;
    // Only detach a trailing question clause, never a suffix inside a word.
    reply = reply.slice(0, start).trim().replace(/[,;:\-–—]+$/, "").trim();
    reply = reply.replace(/(?:^|(?<=[.!])\s+)(?:one more thing|one last thing|just to clarify|before we move on|to make sure we can serve you)[,;:\s]*$/i, "").trim();
    changed = true;
  }
  return changed ? { ...turn, reply: reply || null } : turn;
}

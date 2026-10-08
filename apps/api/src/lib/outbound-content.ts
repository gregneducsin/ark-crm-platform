/**
 * Detect link candidates independently of their top-level domain. Every match
 * still has to equal an approved destination in the caller. Explicit schemes
 * also catch IP addresses, localhost and non-HTTP links. Bare email addresses
 * are not treated as web links.
 */
export const OUTBOUND_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"\x60]+|(?<![\p{L}\p{N}@._-])(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?::\d+)?(?:[/?#][^\s<>"\x60]*)?/giu;

/** Model reasoning/tool markup is never customer-facing content. Fail closed. */
export function hasInternalMarkup(text: string): boolean {
  return /<\/?[a-z][\w:.-]*(?:\s[^<>]*)?>|&lt;\/?(?:analysis|think|thinking|reasoning|tool_call|tool_result)\b|<\|[^|]+\|>|```|\[(?:analysis|thinking|reasoning|tool_call|tool_result)\]/i.test(text);
}

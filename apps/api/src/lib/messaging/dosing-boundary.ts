import type { BotPreviewRequestBody } from "./types.js";

// Alexis handles enrollment, not dose collection or interpretation. In particular,
// a bare number is never converted to a dose or attached to a medication.
const DOSE_UNIT = /(?<![a-z])(?:mg|mcg|[µμ]g|ml|milligrams?|micrograms?|millilit(?:er|re)s?|units?)\b/i;
const DOSE_WORD = /\b(?:dose|doses|dosage|dosing|titration|titrate)\b/i;
const MEDICATION_CONTEXT = /\b(?:semaglutide|tirzepatide|ozempic|wegovy|mounjaro|zepbound|glp[- ]?1|medication|prescription|dose|dosing)\b/i;
const DOSE_HISTORY = /\b(?:i\s+(?:was|am|used to be|had been)|i['’]m)\s+(?:up\s+to|on|taking|at)\s+\d+(?:\.\d+)?\b/i;
const DOSE_REQUEST = /\b(?:(?:can|could|should|may|would)\s+i|(?:can|could|will|would)\s+you|(?:i\s+(?:want|need)|i['’]d\s+like)\s+to|what\s+(?:dose|dosage)|how\s+(?:much|many)\s+(?:should|can|do)\s+i\s+(?:take|use|inject))\b/i;

export function inboundDosingBoundary(body: Pick<BotPreviewRequestBody, "messages" | "lastQuestion"> & { currentSlots: Pick<BotPreviewRequestBody["currentSlots"], "selectedProduct"> }): "history" | "review" | null {
  const context = body.currentSlots.selectedProduct !== null || body.messages.some(m => MEDICATION_CONTEXT.test(m.body));
  const classify = (last: string): "history" | "review" | null => {
    const bareDoseAnswer = /^\s*\d+(?:\.\d+)?\s*$/.test(last) && DOSE_WORD.test(body.lastQuestion ?? "");
    const doseMention = DOSE_WORD.test(last) || DOSE_UNIT.test(last) || bareDoseAnswer || (context && DOSE_HISTORY.test(last));
    if (!doseMention) return null;
    if (DOSE_REQUEST.test(last) || /\b(?:safe|appropriate|okay|ok|increase|decrease|restart|resume|continue|switch)\b/i.test(last)) return "review";
    // A mixed price/enrollment question still reaches the model, which must leave
    // dosing to intake. The independent output boundary below applies either way.
    if (/[?$]/.test(last) || /\b(?:price|cost|pay|month|sign\s*up|questionnaire)\b/i.test(last)) return null;
    return "history";
  };
  const pending: string[] = [];
  for (const message of [...body.messages].reverse()) {
    if (message.direction === "outbound") break;
    pending.push(message.body);
  }
  // A second quick text must not hide an unresolved dosing decision.
  if (pending.some(text => classify(text) === "review")) return "review";
  return classify(pending[0] ?? "");
}

/** This check is independent of topic citations and retry/format waivers. */
export function hasDosingDetails(text: string | null): boolean {
  if (!text) return false;
  if (DOSE_UNIT.test(text)) return true;
  if (/\b(?:your|same|that)\s+(?:dose|dosage)\b[^.!?\n]{0,40}\b(?:approved|fine|safe|appropriate|unchanged|continue|remain|work)\b/i.test(text)) return true;
  if (/\b(?:dose|dosage)\s*(?:of|is|was|at|:)?\s*\d/i.test(text)) return true;
  if (/\b(?:you\s+(?:were|are)|you['’]re)\s+(?:up\s+to|taking)\s+\d/i.test(text)) return true;
  if (/\b(?:start|continue|restart|resume|stay)\s+(?:at|on|from)\s+\d+(?:\.\d+)?(?!\d|\.\d)\b(?!\s*(?:-|\s)\s*months?\b)/i.test(text)) return true;
  return /\b(?:you\s+(?:can|may|should|could|will)|you['’]ll|let['’]s|we\s+can)\b[^.!?\n]{0,100}\b(?:start|stay|continue|restart|resume|increase|decrease|lower|raise|request)\b[^.!?\n]{0,70}\b(?:dose|dosage)\b/i.test(text)
    || /\b(?:start|stay|continue|restart|resume|increase|decrease|lower|raise)\b[^.!?\n]{0,35}\b(?:your|the\s+same|that)\s+(?:dose|dosage)\b/i.test(text);
}

export const DOSING_DEFERRAL = "The licensed provider will review your medical history and determine which medication and dose are appropriate for you. Dose changes and safety questions need the clinical team. I can help you get your intake started for that review.";

/** General choice uncertainty is enrollment help, not a prescription decision. */
export function isProviderChoiceRequest(body: Pick<BotPreviewRequestBody, "messages" | "lastQuestion">): boolean {
  const latest = [...body.messages].reverse().find(m => m.direction === "inbound")?.body.trim() ?? "";
  // Clinical concerns always retain their existing review route.
  if (/\b(?:safe|side effects?|symptoms?|condition|pregnan|allerg|increase|decrease|restart|switch|continue|pain|sick)\w*\b/i.test(latest)) return false;
  if (/^(?:which (?:one|medication|medicine|drug)(?: should i (?:take|choose|get)| is (?:best|better|right)(?: for me)?)|(?:can|could) (?:the )?(?:doctor|provider) (?:choose|decide)(?: for me)?)[?.! ]*$/i.test(latest)) return true;
  const medicationQuestion = /\b(?:which|what)\b.*\b(?:medication|medicine|product|dose|dosage|semaglutide|tirzepatide)\b|\b(?:semaglutide|tirzepatide)\b.*\b(?:or|prefer|interested)\b/i.test(body.lastQuestion ?? "");
  const currentUseQuestion = /\b(?:currently|taking|on a|on any)\b.*\b(?:medication|semaglutide|tirzepatide|glp[- ]?1)\b/i.test(body.lastQuestion ?? "");
  if ((medicationQuestion || currentUseQuestion) && /^(?:i (?:don't|do not) know|not sure|i'?m not sure|you (?:choose|decide)|whatever (?:you|the doctor|the provider) (?:think|thinks|recommend|recommends)|either)[?.! ]*$/i.test(latest)) return true;
  return medicationQuestion && /^yes[?.! ]*$/i.test(latest);
}

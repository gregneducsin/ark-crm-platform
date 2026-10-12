import { RESUME_CODE_PLAN_TOTALS, RESUME_CODE_TOPIC_KEY } from "./knowledge-catalog.js";

type Product = keyof typeof RESUME_CODE_PLAN_TOTALS;
const MONEY = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g;
const PERIOD = /\b(\d+|one|three|six|twelve)[\s-]*(?:months?|mos?)\b|\bmonth-to-month\b|\bfirst month\b/gi;
const WORDS: Record<string, number> = { one: 1, three: 3, six: 6, twelve: 12 };

/** Bind each explicit quote to its product, period, price role and cited offer.
 * Keep context across the main reply and nextQuestion. Ambiguous multi-plan
 * clauses must be rewritten instead of trusting an approved-number whitelist.
 */
export function planPriceError(fields: readonly string[], topics: readonly string[], promotion: number): string | null {
  const cited = (["semaglutide", "tirzepatide"] as const).filter(p => topics.includes(p + "_pricing"));
  let product: Product | undefined = cited.length === 1 ? cited[0] : undefined;
  let months: number | undefined;
  let offer: "regular" | "first" | "code" = "regular";
  const fail = "Quote the correct medication, plan length, total and monthly equivalent together. Apply only the cited promotion once to the plan total; do not substitute a different plan's price or invent installments.";
  for (const field of fields) {
    for (const clause of field.split(/(?:[;!?\n]|\.(?!\d)|,\s+(?!\d)|\b(?:and|or|while|whereas|versus)\b)/i)) {
      const named = [...clause.matchAll(/\b(semaglutide|tirzepatide)\b/gi)].map(m => m[1].toLowerCase() as Product);
      if (new Set(named).size > 1 && /\$/.test(clause)) return fail;
      if (named.length && named[0] !== product) { product = named[0]; months = undefined; }
      const periods = [...clause.replace(MONEY, "PRICE").matchAll(PERIOD)].map(m => m[1] ? WORDS[m[1].toLowerCase()] ?? Number(m[1]) : 1);
      // 'first-month offer' describes the promotion, not a one-month plan.
      const uniquePeriods = [...new Set(periods)];
      if (uniquePeriods.length > 1 && /\$/.test(clause)) return fail;
      if (uniquePeriods.length === 1) months = uniquePeriods[0];
      const codeHere = /\b(?:MG25|with (?:the )?code|after (?:the )?code)\b/i.test(clause);
      const firstHere = /\b(?:off|discount|offer|save)\b/i.test(clause) && !codeHere;
      if (codeHere) offer = "code";
      else if (firstHere && new RegExp(`\\$\\s*${promotion}\\b`).test(clause)) offer = "first";

      const amounts = [...clause.matchAll(MONEY)];
      for (let i = 0; i < amounts.length; i++) {
        const m = amounts[i], amount = Number(m[1].replace(/,/g, ""));
        const before = clause.slice(i ? amounts[i-1].index! + amounts[i-1][0].length : 0, m.index);
        const after = clause.slice(m.index! + m[0].length, i+1 < amounts.length ? amounts[i+1].index : undefined);
        const reduction = /^\s*(?:(?:one-time|new-customer|first-month)\s+){0,2}(?:off|discount|offer)\b/i.test(after) || /\b(?:save|saving|savings|discount(?: of)?)\s*$/i.test(before);
        if (reduction) {
          if (amount === promotion && topics.includes("first_month_offer")) continue;
          if (amount === 25 && topics.includes(RESUME_CODE_TOPIC_KEY) && codeHere) continue;
          // Catalog package savings are a separate role, never plan totals.
          if (product && months && /\bsav/i.test(before) && !codeHere) {
            const plans = RESUME_CODE_PLAN_TOTALS[product];
            const p = plans.find(p => p.months === months);
            if (p && amount === plans[0].regular * months - p.regular) continue;
          }
          return fail;
        }
        if (!product) continue; // Existing product validator rejects ambiguous prices.
        const plans = RESUME_CODE_PLAN_TOTALS[product];
        const candidates = months === undefined ? plans : plans.filter(p => p.months === months);
        if (!candidates.length) return fail;
        const monthly = /^\s*(?:\/\s*(?:mo(?:nth)?|month)|(?:per|a|each)\s+month)/i.test(after) || /\b(?:averag(?:e|es|ing)|monthly equivalent(?: of)?)\s*$/i.test(before);
        const total = /\b(?:total|billed|upfront|up front)\b/i.test(before + after);
        const regularHere = /\b(?:regular|without (?:the )?(?:code|discount))\b/i.test(before) || /^\s*regular\b|\bbefore discount\b/i.test(after);
        const selectedOffer = regularHere ? "regular" : offer;
        const valid = candidates.some(p => {
          const average = Math.floor(p.regular / p.months);
          if (monthly) return amount === average;
          if (amount === p.regular && selectedOffer === "regular") return true;
          if (!total && months === undefined && amount === average && selectedOffer === "regular") return true;
          if (amount === p.withCode && topics.includes(RESUME_CODE_TOPIC_KEY) && selectedOffer === "code") return true;
          if (amount === p.regular - promotion && topics.includes("first_month_offer") && selectedOffer === "first") return true;
          return false;
        });
        if (!valid) return fail;
      }
    }
  }
  return null;
}





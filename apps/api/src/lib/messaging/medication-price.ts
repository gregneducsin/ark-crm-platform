type Product = "semaglutide" | "tirzepatide";

// Includes regular prices, approved monthly equivalents, discounted totals,
// and (where offered) the catalog's savings figures. These are product-specific.
const AMOUNTS: Record<Product, ReadonlySet<number>> = {
  semaglutide: new Set([169,90,270,237,99,594,420,129,230,554]),
  tirzepatide: new Set([225,170,510,165,172,1035,315,185,470,995]),
};
const PROMOTION = 40;
const PRODUCT_RE = /\b(semaglutide|tirzepatide)\b/gi;
const MONEY_RE = /\$\s*(\d+(?:,\d{3})*(?:\.\d+)?)/g;

function products(text: string): Product[] {
  return [...new Set([...text.matchAll(PRODUCT_RE)].map(m => m[1].toLowerCase() as Product))];
}

/**
 * A topic citation is not evidence that a quoted number belongs to the drug.
 * Bind dollar claims to the product named in the clause. Carry a single known
 * product across price-list clauses; ambiguous comparisons must be rewritten.
 * Validate both visible fields together so a follow-up inherits reply context.
 */
export function medicationPriceError(fields: readonly string[], topics: readonly string[]): string | null {
  const cited = (["semaglutide", "tirzepatide"] as const).filter(p => topics.includes(p + "_pricing"));
  let context: Product | undefined = cited.length === 1 ? cited[0] : undefined;
  for (const text of fields) {
    if (/\b(?:semaglutide\s+(?:and|or|\/)\s+tirzepatide|tirzepatide\s+(?:and|or|\/)\s+semaglutide)\b/i.test(text) && /\$/.test(text)) {
      return "Quote each medication with its own price in a separate clause; a shared price for both medications is ambiguous.";
    }
    for (const clause of text.split(/(?:[;!?\n]|\.(?!\d)|,\s+(?!\d)|\b(?:and|while|whereas|versus|vs\.?)\b)/i)) {
      const named = products(clause);
      const product = named.length === 1 ? named[0] : named.length === 0 ? context : undefined;
      if (named.length) context = product;
      for (const match of clause.matchAll(MONEY_RE)) {
        const amount = Number(match[1].replace(/,/g, ""));
        // Only the discount itself is product-independent, never a plan price.
        const adjacent = clause.slice(Math.max(0, match.index! - 25), match.index! + match[0].length + 25);
        if (amount === PROMOTION && /\b(?:off|discount|offer|save)\b/i.test(adjacent)) continue;
        if (!product || !cited.includes(product) || !AMOUNTS[product].has(amount)) {
          return `The figure $${match[1]} is not an approved amount for ${product ?? "an unambiguous medication"}. Name each medication with its own catalog prices in a separate clause; cite that medication's pricing topic. Do not reuse another medication's price or invent installments.`;
        }
      }
    }
  }
  return null;
}

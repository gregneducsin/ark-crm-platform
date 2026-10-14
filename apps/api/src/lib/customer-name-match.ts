/**
 * Whether two customer records could be the same person, going by name alone.
 *
 * Used as the safety check before two records that share a phone number are
 * merged automatically: a family sharing one phone number must NOT be merged
 * just because the number matches. The placeholder "Unknown" a webhook-created
 * record gets when no name was supplied matches anything, since it carries no
 * information to contradict; otherwise first and last names must each be equal
 * once case, spacing and punctuation are ignored.
 */
export interface PersonName {
  readonly firstName: string;
  readonly lastName: string;
}

const PLACEHOLDER = "unknown";

function normalizeNamePart(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function partsCompatible(a: string, b: string): boolean {
  const x = normalizeNamePart(a);
  const y = normalizeNamePart(b);
  if (!x || !y || x === PLACEHOLDER || y === PLACEHOLDER) return true;
  return x === y;
}

export function namesCompatible(a: PersonName, b: PersonName): boolean {
  return partsCompatible(a.firstName, b.firstName) && partsCompatible(a.lastName, b.lastName);
}

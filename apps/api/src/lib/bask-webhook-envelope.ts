/**
 * Bask's own webhook dashboard wraps every custom-mapped body in a fixed
 * envelope — { "type": "...", "data": { ...the fields actually mapped... } }
 * — rather than sending the mapped fields flat at the top level. Confirmed
 * against a real Luma delivery on the abandoned-session endpoint, and
 * applied here to every Bask webhook route that can be configured to POST
 * directly from Bask instead of through Zapier.
 *
 * The envelope itself carries no information any of these routes need (the
 * URL alone already tells us which event this is), so this just reaches
 * into `data` for the fields to validate. Falls back to the body itself so
 * a caller that DOES send a flat body (e.g. the existing Zapier relay, or a
 * test) still works unchanged.
 */
export function unwrapBaskEnvelope(body: unknown): unknown {
  return body && typeof body === "object" && "data" in body ? (body as { data: unknown }).data : body;
}

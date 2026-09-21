/**
 * The new Ark number is warming up on organic support traffic only — every
 * Alexis (sales) SMS send is paused by default so the number's first
 * impression with support customers isn't diluted by sales outreach. Sophie
 * (support) sends are never gated by this. Flip SALES_SMS_ENABLED=true when
 * sales sending should resume; no other code change is needed.
 */
export function isSalesSmsPaused(): boolean {
  return process.env.SALES_SMS_ENABLED !== "true";
}

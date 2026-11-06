export const TEST_RECIPIENT = "gregneducsin@gmail.com";
export const CAMPAIGN_SENDER = "support@tryark.com";
export function normalizeCampaignEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !/[\r\n]/.test(value) ? email : null;
}
export function renderCampaign(html: string, unsubscribeUrl: string): string {
  if (!html.includes("{{UNSUBSCRIBE_URL}}")) throw new Error("Campaign requires an unsubscribe link");
  return html.replaceAll("{{UNSUBSCRIBE_URL}}", unsubscribeUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;"));
}

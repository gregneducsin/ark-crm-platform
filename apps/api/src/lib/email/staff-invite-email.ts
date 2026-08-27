/**
 * Staff account invitation — a separate, small template from templates.ts's
 * patient-facing set on purpose: those all require an unsubscribeUrl and
 * route through sendTriggerEmail's DND-gated, conversation-logging pattern,
 * neither of which applies to an internal staff account email. Sent
 * directly via getEmailProvider("system") instead.
 */

export interface RenderedStaffInviteEmail {
  readonly subject: string;
  readonly html: string;
}

const ROLE_LABEL: Record<"admin" | "manager" | "customer_service", string> = {
  admin: "Admin",
  manager: "Manager",
  customer_service: "Customer Service",
};

export function renderStaffInvitationEmail(
  firstName: string,
  role: "admin" | "manager" | "customer_service",
  inviteUrl: string,
): RenderedStaffInviteEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You've been invited to Ark Health</title>
<style>
  body, table, td { font-family: 'Helvetica Neue', Arial, sans-serif; }
  body { margin: 0; padding: 0; background-color: #eef2f5; }
  .email-wrapper { width: 100%; background-color: #eef2f5; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border: 1px solid #dce3e8; }
  .header { background-color: #1a2a38; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 30px; letter-spacing: 3px; color: #ffffff; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #a9bccb; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 26px; color: #1a2a38; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #3e4a56; margin: 0 0 20px 0; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #d9f26a; color: #1a2a38; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #dce3e8; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #7c8a96; margin: 4px 0; }
</style>
</head>
<body>
<div class="email-wrapper">
  <table class="email-container" role="presentation" cellpadding="0" cellspacing="0" width="100%">
    <tr>
      <td class="header">
        <p class="logo-text">ARK HEALTH</p>
        <p class="header-sub">Staff Dashboard</p>
      </td>
    </tr>
    <tr>
      <td class="body-content">
        <p class="greeting">Hi ${name},</p>
        <p class="paragraph">You've been invited to join the Ark Health staff dashboard as <strong>${ROLE_LABEL[role]}</strong>. Click below to set your password and get started.</p>
        <div class="cta-wrapper">
          <a href="${inviteUrl}" class="cta-button">Accept Invitation</a>
        </div>
        <p class="paragraph">This link expires in 24 hours. If you weren't expecting this invitation, you can safely ignore this email.</p>
      </td>
    </tr>
    <tr>
      <td><hr class="divider" style="margin-left:40px; margin-right:40px;"></td>
    </tr>
    <tr>
      <td class="footer">
        <p class="footer-text">Ark Health</p>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;
  return { subject: "You've been invited to Ark Health", html };
}

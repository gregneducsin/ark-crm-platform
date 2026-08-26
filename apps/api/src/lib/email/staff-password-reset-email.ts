/**
 * Admin-triggered staff password reset — same reasoning and layout as
 * staff-invite-email.ts (a separate small template from templates.ts's
 * patient-facing set, sent directly via getEmailProvider("system"), no
 * unsubscribeUrl or DND gating since this isn't a patient-facing message).
 */

export interface RenderedStaffPasswordResetEmail {
  readonly subject: string;
  readonly html: string;
}

export function renderStaffPasswordResetEmail(firstName: string, resetUrl: string): RenderedStaffPasswordResetEmail {
  const name = firstName.trim() || "there";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Reset your Ark Health password</title>
<style>
  body, table, td { font-family: 'Georgia', 'Times New Roman', serif; }
  body { margin: 0; padding: 0; background-color: #f5f1ea; }
  .email-wrapper { width: 100%; background-color: #f5f1ea; padding: 40px 0; }
  .email-container { max-width: 600px; margin: 0 auto; background-color: #fffdf9; border: 1px solid #e8dfd0; }
  .header { background-color: #2b2420; padding: 36px 40px; text-align: center; }
  .logo-text { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; letter-spacing: 3px; color: #d4af6a; margin: 0; font-weight: 500; }
  .header-sub { font-family: Arial, sans-serif; font-size: 11px; letter-spacing: 2px; color: #cbbfa8; text-transform: uppercase; margin-top: 6px; }
  .body-content { padding: 44px 40px 20px 40px; }
  .greeting { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; color: #2b2420; margin: 0 0 22px 0; font-weight: 500; }
  .paragraph { font-family: Arial, Helvetica, sans-serif; font-size: 15px; line-height: 26px; color: #4a4038; margin: 0 0 20px 0; }
  .cta-wrapper { text-align: center; margin: 32px 0; }
  .cta-button { display: inline-block; background-color: #b8935a; color: #fffdf9; font-family: Arial, sans-serif; font-size: 15px; font-weight: bold; letter-spacing: 1px; text-decoration: none; padding: 16px 38px; border-radius: 3px; text-transform: uppercase; }
  .divider { border: none; border-top: 1px solid #e8dfd0; margin: 30px 0; }
  .footer { padding: 28px 40px 40px 40px; text-align: center; }
  .footer-text { font-family: Arial, sans-serif; font-size: 12px; line-height: 20px; color: #948a7c; margin: 4px 0; }
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
        <p class="paragraph">An admin reset your password on the Ark Health staff dashboard. Click below to choose a new one.</p>
        <div class="cta-wrapper">
          <a href="${resetUrl}" class="cta-button">Reset Password</a>
        </div>
        <p class="paragraph">This link expires in 1 hour. If you weren't expecting this, contact an admin.</p>
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
  return { subject: "Reset your Ark Health password", html };
}

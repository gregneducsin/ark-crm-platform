# SMS reliability rollout

## Before deployment

- Keep Ark's current `SALES_SMS_ENABLED` setting. Sales remains paused unless it is exactly `true`; support and onboarding retain their existing roles.
- In Ark's iBluSend workspace, subscribe to `message.sent`, `message.delivered`, `message.read`, and `message.failed` at the Ark API's existing `/api/webhooks/iblusend-message` endpoint. Keep `message.received` on the original inbound subscription.
- For a separate delivery subscription, place its signing secret in `IBLUSEND_DELIVERY_WEBHOOK_SECRET` on the **Ark API service**. Keep the original inbound signing secret in `IBLUSEND_WEBHOOK_SECRET`. Do not copy Luma's secrets or destination URL.
- If one existing subscription carries both inbound and delivery events, keep its original secret and leave the separate delivery secret unset. When a separate delivery secret is set, delivery events must be signed with that key.
- Apply additive migration `0038_texting_reliability` through the existing migration entrypoint before starting the new API. No historical message timestamps are invented or backfilled.

## Verify after deployment

Use a staff-owned test number, with permission to send test messages. Confirm that signed receipts arrive successfully and the dashboard changes from queued to sent/delivered using provider timestamps. Compare the original inbound webhook and the delivery subscription for signature failures or pauses.

Send two rapid inbound texts, including a first-time sender scenario. The saved inbound history should include both texts; a draft overtaken by the second text should be discarded. The worker processes the latest pending input together after any earlier outbound send is confirmed. This is not a fixed batching delay: a reply already submitted before the second text arrives cannot be recalled.

Check that STOP prevents further SMS even before account creation, account name/email matches require human review, repeated follow-up questions are suppressed, and scheduled sales nudges defer for staff holds or pending inbound/delivery work. Scheduled outreach is limited to 9am–8pm Eastern. Confirm support still works while sales is paused.

## Delivery uncertainty

An API acceptance is queued, not proof that a text was sent. The worker waits for receipts; an unresolved queued send becomes unknown after five minutes and requires staff review. It does not blindly resend. Missing receipts will therefore pause automation rather than allow replies to overtake messages still queued at the provider.

Historical messages with no provider send timestamp continue to use their existing recorded time. Staff should compare provider evidence before retrying an unknown outcome. This change does not recall texts already submitted or rewrite old conversation history.

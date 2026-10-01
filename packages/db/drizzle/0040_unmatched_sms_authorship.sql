ALTER TABLE unmatched_sms_messages ADD COLUMN sent_by text;
--> statement-breakpoint
ALTER TABLE unmatched_sms_messages ADD COLUMN sent_by_staff_email text;
--> statement-breakpoint
-- A copied onboarding message with no recorded author must not inherit the AI default.
UPDATE conversation_messages AS cm SET sent_by = NULL
WHERE cm.sent_by = 'ai' AND cm.sent_by_staff_email IS NULL
AND EXISTS (SELECT 1 FROM unmatched_sms_messages AS um WHERE um.id = cm.id AND um.direction = 'outbound' AND um.sent_by IS NULL);

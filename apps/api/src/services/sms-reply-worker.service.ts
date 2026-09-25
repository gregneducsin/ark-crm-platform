import { eq } from "drizzle-orm";
import { db, smsReplyWorkTable } from "@luma/db";
import { resumeAlexisSms } from "./alexis-dispatch.service.js";
import { resumeSophieSms } from "./sophie-dispatch.service.js";
import { sweepSmsDeliveryTimeouts } from "./sms-delivery.service.js";
import { logger } from "../lib/logger.js";
import { sweepPendingUnmatchedSms } from "./unmatched-inbound-sms.service.js";

let running = false;
export async function sweepPendingSmsReplies() {
  if (running) return;
  running = true;
  try {
    await sweepSmsDeliveryTimeouts();
    await sweepPendingUnmatchedSms();
    const work = await db.select().from(smsReplyWorkTable).where(eq(smsReplyWorkTable.heldForStaff, false))
      .orderBy(smsReplyWorkTable.updatedAt).limit(50);
    for (const item of work) {
      try {
        if (item.persona === "sales") await resumeAlexisSms(item.personId);
        else await resumeSophieSms(item.personId);
      } catch {
        logger.error({ personId: item.personId, persona: item.persona }, "Pending SMS reply failed; retained for the next sweep");
      }
    }
  } finally { running = false; }
}

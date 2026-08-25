import { useCancelUpcomingTrigger, useUpcomingTrigger } from "../hooks/useScheduledTriggers";

/** "in 3 days", "in 2h", "any moment now" (already due but not yet swept) — not a countdown, just enough precision to be useful at a glance. */
function formatDueIn(dueAtIso: string): string {
  const diffMs = new Date(dueAtIso).getTime() - Date.now();
  if (diffMs <= 0) return "any moment now";
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Small heads-up line on a conversation's detail panel: is there an
 * automated follow-up already scheduled for this person? Answers exactly
 * the "is something coming up for this customer" question staff otherwise
 * had no way to check short of asking an engineer to query the database.
 * Renders nothing while loading or when nothing's scheduled — this is meant
 * to be a quiet, easy-to-miss-if-irrelevant line, not an alert.
 */
export function UpcomingTriggerBanner({ personId }: { personId: string | null }) {
  const { data } = useUpcomingTrigger(personId);
  const cancelTrigger = useCancelUpcomingTrigger(personId);
  const trigger = data?.trigger;
  if (!trigger) return null;

  // "processing" is the sweep's transient claim right before it actually
  // sends — already too late to call off, so no Cancel affordance then.
  const canCancel = trigger.status === "pending";

  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-gray-400">
      <span aria-hidden="true">📅</span>
      Next scheduled: {trigger.label} — {trigger.status === "processing" ? "sending now" : formatDueIn(trigger.dueAt)}
      {canCancel && (
        <button
          type="button"
          className="text-blue-500 hover:underline disabled:text-gray-300"
          disabled={cancelTrigger.isPending}
          onClick={() => cancelTrigger.mutate(trigger.kind)}
        >
          {cancelTrigger.isPending ? "Cancelling…" : "Cancel"}
        </button>
      )}
    </p>
  );
}

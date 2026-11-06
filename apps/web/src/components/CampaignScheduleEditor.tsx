import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
export interface CampaignSchedule {
  days: number[];
  start: string;
  end: string;
  timezone: string;
}
const days = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
export function CampaignScheduleEditor({
  id,
  schedule,
  editable,
  onDirty,
}: {
  id: string;
  schedule: CampaignSchedule | null;
  editable: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState(Boolean(schedule));
  const [value, setValue] = useState<CampaignSchedule>(
    schedule ?? {
      days: [1, 2, 3, 4, 5],
      start: "09:00",
      end: "17:00",
      timezone: "America/New_York",
    },
  );
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = (patch: Partial<CampaignSchedule>) => {
    setValue({ ...value, ...patch });
    setDirty(true);
    onDirty(true);
  };
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/app/email-campaigns/${id}/schedule`, {
        schedule: enabled ? value : null,
      });
      setDirty(false);
      onDirty(false);
      await qc.invalidateQueries({ queryKey: ["email-campaigns"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save schedule");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="font-semibold">Sending schedule</h3>
      <p className="text-sm">
        Saved:{" "}
        {schedule
          ? `${schedule.days.map((d) => days[d].slice(0, 3)).join(", ")} · ${schedule.start}–${schedule.end} · ${schedule.timezone}`
          : "Every day, any time"}
      </p>
      {editable ? (
        <>
          <label className="flex gap-2">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
                onDirty(true);
              }}
            />
            Send only on selected days and hours
          </label>
          {enabled && (
            <fieldset disabled={busy} className="space-y-3">
              <legend className="sr-only">Allowed sending window</legend>
              <div className="flex flex-wrap gap-3">
                {days.map((d, i) => (
                  <label key={d} className="flex gap-1">
                    <input
                      type="checkbox"
                      checked={value.days.includes(i)}
                      onChange={(e) =>
                        change({
                          days: e.target.checked
                            ? [...value.days, i].sort()
                            : value.days.filter((n) => n !== i),
                        })
                      }
                    />
                    {d}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap gap-4">
                <label>
                  Start time{" "}
                  <input
                    className="rounded border p-2"
                    type="time"
                    value={value.start}
                    onChange={(e) => change({ start: e.target.value })}
                  />
                </label>
                <label>
                  End time{" "}
                  <input
                    className="rounded border p-2"
                    type="time"
                    value={value.end}
                    onChange={(e) => change({ end: e.target.value })}
                  />
                </label>
              </div>
              <label className="block">
                Timezone{" "}
                <select
                  className="rounded border p-2"
                  value={value.timezone}
                  onChange={(e) => change({ timezone: e.target.value })}
                >
                  {[
                    "America/New_York",
                    "America/Chicago",
                    "America/Denver",
                    "America/Phoenix",
                    "America/Los_Angeles",
                    "America/Anchorage",
                    "Pacific/Honolulu",
                    "UTC",
                  ].map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </select>
              </label>
              <p className="text-sm">
                The end time must be later on the same day. Daylight-saving
                changes are automatic. Emails wait outside this window and
                resume at the normal pace; no catch-up burst.
              </p>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="text-red-700">
              {error}
            </p>
          )}
          <button
            disabled={!dirty || busy}
            className="rounded-lg bg-ark-blue-600 px-4 py-2 text-white disabled:opacity-40"
            onClick={() => void save()}
          >
            Save schedule
          </button>
          <p className="text-sm">
            Saving does not start the campaign. Test emails can be sent outside
            the schedule.
          </p>
        </>
      ) : (
        <p className="text-sm">Pause the campaign to edit the schedule.</p>
      )}
    </div>
  );
}

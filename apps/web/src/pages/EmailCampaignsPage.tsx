import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/apiClient";
import {
  CampaignScheduleEditor,
  type CampaignSchedule,
} from "../components/CampaignScheduleEditor";
interface Campaign {
  id: string;
  name: string;
  subject: string;
  html: string;
  status: string;
  per_hour: number;
  schedule: CampaignSchedule | null;
  test_status: string;
  test_sent_at: string | null;
  counts: Record<string, number> | null;
}
export function EmailCampaignsPage() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [approved, setApproved] = useState(false);
  const [rate, setRate] = useState(20);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const {
    data,
    isLoading,
    error: loadError,
  } = useQuery({
    queryKey: ["email-campaigns"],
    queryFn: () =>
      api.get<{ campaigns: Campaign[]; eligible: number }>(
        "/api/app/email-campaigns",
      ),
    refetchInterval: 15000,
  });
  async function run(path: string, body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api.post<Campaign>(
        "/api/app/email-campaigns" + path,
        body,
      );
      if (path.endsWith("/test"))
        setNotice(
          result.test_status === "sent"
            ? "Test accepted by the email provider. Check gregneducsin@gmail.com, including spam."
            : "Test delivery is uncertain. Check the mailbox and provider before retrying.",
        );
      setApproved(false);
      await qc.invalidateQueries({ queryKey: ["email-campaigns"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  const button =
    "rounded-lg bg-ark-blue-600 px-4 py-2 text-white disabled:opacity-40";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold">Email Campaigns</h1>
      <p>
        Send from support@tryark.com. Each campaign sends one email per unique
        eligible address, gradually. Creating a draft or sending a test does not
        enroll leads.
      </p>
      <p className="text-sm">
        Audience: all saved leads and customers with a valid email, excluding
        email opt-outs, AI pauses, test purchases and recorded email failures.
        Suppressions apply across duplicate email addresses and are checked
        again before sending. Unmatched inbox contacts are not enrolled.
        Contacts flagged for review are included; their review flags stay in
        place.
      </p>
      <p className="font-medium">
        Eligible addresses now: {data?.eligible ?? "Loading…"}
      </p>
      <p className="text-sm">
        “Sent” means provider acceptance, not confirmed inbox delivery.
        Bounce/complaint feeds and click/purchase attribution are not included
        in this version.
      </p>
      {(error || loadError) && (
        <p role="alert" className="text-red-700">
          {error || String(loadError)}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        className={button}
        disabled={busy || isLoading || Boolean(data?.campaigns.length)}
        onClick={() => void run("/")}
      >
        Create peptide campaign draft
      </button>
      {data?.campaigns.map((c) => (
        <section
          key={c.id}
          className="space-y-4 rounded-xl border bg-white p-5"
        >
          <h2 className="text-xl font-semibold">
            {c.name} — {c.status}
          </h2>
          <p>Subject: {c.subject}</p>
          <p>
            Test: {c.test_status}
            {c.test_sent_at
              ? ` · ${new Date(c.test_sent_at).toLocaleString()}`
              : ""}
          </p>
          <div className="flex flex-wrap gap-4">
            {["pending", "sending", "sent", "skipped", "failed", "unknown"].map(
              (s) => (
                <span key={s}>
                  {s}: {c.counts?.[s] ?? 0}
                </span>
              ),
            )}
          </div>
          <details>
            <summary className="cursor-pointer">Preview approved email</summary>
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={c.html.replaceAll("{{UNSUBSCRIBE_URL}}", "#")}
              className="h-[650px] w-full border"
            />
          </details>
          <p className="text-sm">
            The test uses a preview unsubscribe mailto link. Campaign recipients
            receive their real unsubscribe link. The approved template
            advertises “starting at $175.”
          </p>
          <button
            className={button}
            disabled={busy || c.test_status !== "not_sent"}
            onClick={() => void run(`/${c.id}/test`)}
          >
            Send one test to gregneducsin@gmail.com
          </button>
          {(c.status === "draft" || c.status === "paused") && (
            <div className="space-y-3">
              <label className="block">
                Emails per hour (1–60)
                <input
                  className="ml-3 rounded border p-2"
                  type="number"
                  min="1"
                  max="60"
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                />
              </label>
              <label className="flex gap-2">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(e) => setApproved(e.target.checked)}
                />
                I reviewed the test, confirm the $175 offer and approve this
                audience for the campaign.
              </label>
              <button
                className={button}
                disabled={
                  busy || scheduleDirty || !approved || c.test_status !== "sent"
                }
                onClick={() =>
                  void run(`/${c.id}/start`, { approved, perHour: rate })
                }
              >
                {c.status === "paused"
                  ? "Resume remaining recipients"
                  : "Start gradual sending"}
              </button>
            </div>
          )}
          <CampaignScheduleEditor
            key={`${c.id}-${JSON.stringify(c.schedule)}`}
            id={c.id}
            schedule={c.schedule}
            editable={c.status === "draft" || c.status === "paused"}
            onDirty={setScheduleDirty}
          />
          {c.status === "running" && (
            <button
              className={button}
              disabled={busy}
              onClick={() => void run(`/${c.id}/pause`)}
            >
              Pause campaign
            </button>
          )}
          <p className="text-sm">
            Failed or uncertain sends are not automatically retried. Pausing
            waits for any in-flight attempt to finish, then stops remaining
            sends.
          </p>
        </section>
      ))}
    </div>
  );
}

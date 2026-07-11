"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, CalendarClock, Clock } from "lucide-react";
import type {
  CronPreviewResponse,
  ReasoningEffort,
  ScheduleSummary,
} from "@/lib/types";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  MODELS,
  REASONING_EFFORTS,
} from "@/lib/types";
import {
  SCHEDULE_PRESETS,
  WEEKDAYS,
  buildCron,
  detectPreset,
} from "@/lib/schedule/presets";
import type { PresetId } from "@/lib/schedule/presets";
import { useScheduleStore } from "@/store/schedules";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";

export interface ScheduleFormProps {
  open: boolean;
  /** When set, the form edits this schedule; otherwise it creates a new one. */
  schedule?: ScheduleSummary | null;
  onClose: () => void;
}

/** The viewer's local IANA time zone, or "UTC" if it can't be resolved. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** All IANA zones the runtime knows, with a safe fallback for older engines. */
function getTimeZones(): string[] {
  try {
    const fn = (Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }).supportedValuesOf;
    if (typeof fn === "function") {
      const zones = fn("timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    /* not supported — fall through */
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Australia/Sydney"];
}

/** Format an ISO instant in a specific time zone, with an explicit tz label. */
function formatInZone(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

const supportedEfforts = REASONING_EFFORTS.filter((e) => e.supported);

export function ScheduleForm({ open, schedule, onClose }: ScheduleFormProps) {
  const create = useScheduleStore((s) => s.create);
  const update = useScheduleStore((s) => s.update);
  const preview = useScheduleStore((s) => s.preview);

  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_EFFORT);
  const [timezone, setTimezone] = useState("UTC");

  const [preset, setPreset] = useState<PresetId>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [customCron, setCustomCron] = useState("0 9 * * *");

  const [previewResult, setPreviewResult] = useState<CronPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const zones = useMemo(getTimeZones, []);
  const viewerTz = useMemo(localTimeZone, []);

  const isEdit = !!schedule;

  // Reset field state whenever the modal opens (create) or targets a schedule.
  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setPreviewResult(null);
    if (schedule) {
      setTitle(schedule.title);
      setPrompt(schedule.prompt);
      setModel(schedule.model || DEFAULT_MODEL);
      setEffort(schedule.effort);
      setTimezone(schedule.timezone || "UTC");
      const det = detectPreset(schedule.cron);
      setPreset(det.preset);
      setTime(det.time ?? "09:00");
      setWeekday(det.weekday ?? 1);
      setDay(det.day ?? 1);
      setCustomCron(schedule.cron);
    } else {
      setTitle("");
      setPrompt("");
      setModel(DEFAULT_MODEL);
      setEffort(DEFAULT_EFFORT);
      setTimezone(localTimeZone());
      setPreset("daily");
      setTime("09:00");
      setWeekday(1);
      setDay(1);
      setCustomCron("0 9 * * *");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, schedule]);

  const activePreset = SCHEDULE_PRESETS.find((p) => p.id === preset);

  // The cron expression the current builder state resolves to.
  const effectiveCron =
    preset === "custom"
      ? customCron.trim()
      : buildCron(preset, { time, weekday, day });

  // Debounced live preview as cron / timezone change.
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (!open) return;
    // Invalidate the previous preview immediately so `cronValid`/`canSubmit` go
    // false the instant the cron changes — otherwise the submit button stays
    // enabled off the stale (still-valid) result during the debounce + fetch
    // window, letting an invalid cron be submitted before the server rejects it.
    setPreviewResult(null);
    if (!effectiveCron) {
      setPreviewLoading(false);
      setPreviewResult({
        valid: false,
        description: "",
        nextRuns: [],
        error: "Enter a cron expression",
      });
      return;
    }
    setPreviewLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      const result = await previewRef.current(effectiveCron, timezone);
      if (cancelled) return;
      setPreviewResult(result);
      setPreviewLoading(false);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, effectiveCron, timezone]);

  const cronValid = previewResult?.valid === true;
  const canSubmit =
    title.trim().length > 0 &&
    prompt.trim().length > 0 &&
    cronValid &&
    !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setLocalError(null);

    const base = {
      title: title.trim(),
      prompt: prompt.trim(),
      cron: effectiveCron,
      timezone,
      model,
      effort,
    };

    const result = schedule
      ? await update(schedule.id, base)
      : await create({ ...base, enabled: true });

    setSubmitting(false);
    if (result) {
      onClose();
    } else {
      setLocalError(
        useScheduleStore.getState().error || "Failed to save scheduled task",
      );
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit scheduled task" : "New scheduled task"}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Morning briefing"
            className={inputClass}
          />
        </Field>

        <Field label="Prompt">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            placeholder="What should the assistant do each time this runs?"
            className={cn(inputClass, "resize-y")}
          />
          <span className="text-xs text-text-secondary">
            Sent as the first user message in a brand-new conversation on every run.
          </span>
        </Field>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Model">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={inputClass}
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reasoning effort">
            <select
              value={effort}
              onChange={(e) => setEffort(e.target.value as ReasoningEffort)}
              className={inputClass}
            >
              {supportedEfforts.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* Schedule builder */}
        <div className="rounded-xl border border-border bg-sidebar/40 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <CalendarClock size={15} className="text-text-secondary" /> Schedule
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Repeat">
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value as PresetId)}
                className={inputClass}
              >
                {SCHEDULE_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>

            {activePreset?.needsTime && (
              <Field label="Time">
                <input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className={inputClass}
                />
              </Field>
            )}

            {activePreset?.needsWeekday && (
              <Field label="Day of week">
                <select
                  value={weekday}
                  onChange={(e) => setWeekday(Number(e.target.value))}
                  className={inputClass}
                >
                  {WEEKDAYS.map((w) => (
                    <option key={w.value} value={w.value}>
                      {w.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {activePreset?.needsDayOfMonth && (
              <Field label="Day of month">
                <input
                  type="number"
                  min={1}
                  max={28}
                  value={day}
                  onChange={(e) =>
                    setDay(Math.min(28, Math.max(1, Number(e.target.value) || 1)))
                  }
                  className={inputClass}
                />
              </Field>
            )}
          </div>

          {preset === "custom" && (
            <div className="mt-3">
              <Field label="Cron expression">
                <input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 9 * * *"
                  spellCheck={false}
                  className={cn(inputClass, "font-mono")}
                />
                <span className="text-xs text-text-secondary">
                  5 fields: minute hour day-of-month month day-of-week.
                </span>
              </Field>
            </div>
          )}

          <div className="mt-3">
            <Field label="Time zone">
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className={inputClass}
              >
                {/* Ensure the schedule's stored zone is always selectable. */}
                {!zones.includes(timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* Live preview */}
          <PreviewPanel
            loading={previewLoading}
            result={previewResult}
            scheduleTz={timezone}
            viewerTz={viewerTz}
          />
        </div>

        {localError && (
          <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            <AlertCircle size={15} className="shrink-0" />
            <span className="min-w-0 flex-1">{localError}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            loading={submitting}
          >
            {isEdit ? "Save changes" : "Create task"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function PreviewPanel({
  loading,
  result,
  scheduleTz,
  viewerTz,
}: {
  loading: boolean;
  result: CronPreviewResponse | null;
  scheduleTz: string;
  viewerTz: string;
}) {
  const showViewer = viewerTz && viewerTz !== scheduleTz;

  return (
    <div className="mt-4 rounded-lg border border-border/60 bg-main/50 px-3.5 py-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
        <Clock size={13} /> Preview
        {loading && <Spinner size={12} className="text-text-secondary" />}
      </div>

      {result && !result.valid ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {result.error || result.description || "Invalid cron expression"}
        </p>
      ) : result && result.valid ? (
        <>
          <p className="mt-2 text-sm text-text-primary">{result.description}</p>
          {result.nextRuns.length > 0 && (
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-text-secondary">
                Next {result.nextRuns.length} run
                {result.nextRuns.length === 1 ? "" : "s"}
              </p>
              <ul className="flex flex-col gap-2">
                {result.nextRuns.map((iso) => (
                  <li key={iso} className="text-sm text-text-primary">
                    <span className="tabular-nums">
                      {formatInZone(iso, scheduleTz)}
                    </span>
                    {showViewer && (
                      <span className="block text-xs text-text-secondary tabular-nums">
                        {formatInZone(iso, viewerTz)} (your time)
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-text-secondary">
          {loading ? "Checking schedule…" : "Set a schedule to preview run times."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-lg border border-border bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

export default ScheduleForm;

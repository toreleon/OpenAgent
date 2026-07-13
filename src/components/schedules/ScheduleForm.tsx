"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { AlertCircle, ChevronDown, Clock, Pause, Play, Trash2, X } from "lucide-react";
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
  DAY_CHIPS,
  FREQUENCIES,
  buildScheduleCron,
  describeCronFriendly,
  detectFrequency,
  type Frequency,
} from "@/lib/schedule/friendly";
import { useScheduleStore } from "@/store/schedules";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { ScheduleRunList } from "./ScheduleRunList";

/** Optional prefilled fields for a NEW task (e.g. from an empty-state example chip). */
export interface ScheduleTemplate {
  title?: string;
  prompt?: string;
}

export interface ScheduleFormProps {
  open: boolean;
  /** When set, the panel edits this task; otherwise it creates a new one. */
  schedule?: ScheduleSummary | null;
  /** Prefill for create mode (ignored when editing). */
  template?: ScheduleTemplate | null;
  onClose: () => void;
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function getTimeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (typeof fn === "function") {
      const zones = fn("timeZone");
      if (Array.isArray(zones) && zones.length) return zones;
    }
  } catch {
    /* older engine */
  }
  return ["UTC", "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Australia/Sydney"];
}

const supportedEfforts = REASONING_EFFORTS.filter((e) => e.supported);
const inputClass =
  "w-full rounded-lg border border-border bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none";

export function ScheduleForm({ open, schedule, template, onClose }: ScheduleFormProps) {
  const create = useScheduleStore((s) => s.create);
  const update = useScheduleStore((s) => s.update);
  const remove = useScheduleStore((s) => s.remove);
  const preview = useScheduleStore((s) => s.preview);

  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [frequency, setFrequency] = useState<Frequency>("daily");
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1]);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [customCron, setCustomCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [tzOpen, setTzOpen] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<ReasoningEffort>(DEFAULT_EFFORT);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [previewResult, setPreviewResult] = useState<CronPreviewResponse | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const zones = useMemo(getTimeZones, []);
  const isEdit = !!schedule;

  // Seed state whenever the panel opens (create) or targets a task.
  useEffect(() => {
    if (!open) return;
    setLocalError(null);
    setPreviewResult(null);
    setTzOpen(false);
    setAdvancedOpen(false);
    if (schedule) {
      setName(schedule.title);
      setInstructions(schedule.prompt);
      setModel(schedule.model || DEFAULT_MODEL);
      setEffort(schedule.effort);
      setTimezone(schedule.timezone || "UTC");
      const det = detectFrequency(schedule.cron);
      setFrequency(det.frequency);
      setTime(det.time);
      setDays(det.days);
      setDayOfMonth(det.dayOfMonth);
      setCustomCron(schedule.cron);
    } else {
      setName(template?.title ?? "");
      setInstructions(template?.prompt ?? "");
      setModel(DEFAULT_MODEL);
      setEffort(DEFAULT_EFFORT);
      setTimezone(localTimeZone());
      setFrequency("daily");
      setTime("09:00");
      setDays([1]);
      setDayOfMonth(1);
      setCustomCron("0 9 * * *");
    }
  }, [open, schedule, template]);

  const effectiveCron =
    frequency === "custom"
      ? customCron.trim()
      : buildScheduleCron(frequency, { time, days, dayOfMonth });

  const friendly = describeCronFriendly(effectiveCron);

  // Debounced live preview (validates cron server-side + upcoming run times).
  const previewRef = useRef(preview);
  previewRef.current = preview;
  useEffect(() => {
    if (!open) return;
    setPreviewResult(null);
    if (!effectiveCron) {
      setPreviewResult({ valid: false, description: "", nextRuns: [], error: "Set a schedule" });
      return;
    }
    setPreviewLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      const result = await previewRef.current(effectiveCron, timezone);
      if (cancelled) return;
      setPreviewResult(result);
      setPreviewLoading(false);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, effectiveCron, timezone]);

  const cronValid = previewResult?.valid === true;
  const canSubmit =
    name.trim().length > 0 && instructions.trim().length > 0 && cronValid && !submitting;

  function toggleDay(d: number) {
    setDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b),
    );
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setLocalError(null);
    const base = {
      title: name.trim(),
      prompt: instructions.trim(),
      cron: effectiveCron,
      timezone,
      model,
      effort,
    };
    const result = schedule
      ? await update(schedule.id, base)
      : await create({ ...base, enabled: true });
    setSubmitting(false);
    if (result) onClose();
    else setLocalError(useScheduleStore.getState().error || "Failed to save task");
  }

  async function handlePauseResume() {
    if (!schedule) return;
    await update(schedule.id, { enabled: !schedule.enabled });
    onClose();
  }

  async function handleDelete() {
    if (!schedule) return;
    if (!window.confirm(`Delete “${schedule.title}”? This can’t be undone.`)) return;
    await remove(schedule.id);
    onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex justify-end bg-black/40 animate-fade-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-full w-full max-w-[460px] flex-col border-l border-border bg-main shadow-2xl animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-4">
          <h2 className="text-base font-semibold text-text-primary">
            {isEdit ? "Edit task" : "New task"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Daily AI news briefing"
                className={inputClass}
              />
            </Field>

            <Field label="Instructions">
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={4}
                placeholder="What should the assistant do each time this runs?"
                className={cn(inputClass, "resize-y")}
              />
              <span className="text-xs text-text-secondary">
                Runs as the first message in a brand-new chat every time.
              </span>
            </Field>

            {/* When */}
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-sidebar/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Clock size={15} className="text-text-secondary" /> When
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Frequency">
                  <select
                    value={frequency}
                    onChange={(e) => setFrequency(e.target.value as Frequency)}
                    className={inputClass}
                  >
                    {FREQUENCIES.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </Field>
                {frequency !== "custom" && (
                  <Field label="Time">
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => setTime(e.target.value)}
                      className={inputClass}
                    />
                  </Field>
                )}
              </div>

              {frequency === "weekly" && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-text-secondary">On these days</span>
                  <div className="flex gap-1.5">
                    {DAY_CHIPS.map((d, i) => {
                      const on = days.includes(d.value);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => toggleDay(d.value)}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors",
                            on
                              ? "bg-text-primary text-main"
                              : "border border-border text-text-secondary hover:bg-hover",
                          )}
                        >
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {frequency === "monthly" && (
                <Field label="Day of month">
                  <select
                    value={dayOfMonth}
                    onChange={(e) => setDayOfMonth(Number(e.target.value))}
                    className={inputClass}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              {frequency === "custom" && (
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
              )}

              {/* Timezone echo (show the resolved zone read-only). */}
              <div className="text-xs text-text-secondary">
                Runs in <span className="text-text-primary">{timezone}</span>
                {" · "}
                <button
                  type="button"
                  onClick={() => setTzOpen((o) => !o)}
                  className="underline underline-offset-2 hover:text-text-primary"
                >
                  change
                </button>
              </div>
              {tzOpen && (
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={inputClass}
                >
                  {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
                  {zones.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </select>
              )}

              {/* Live schedule preview */}
              <SchedulePreview
                loading={previewLoading}
                friendly={friendly}
                result={previewResult}
                timezone={timezone}
              />
            </div>

            {/* Advanced (our addition; hidden by default) */}
            <div className="rounded-xl border border-border">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text-primary"
              >
                Advanced
                <ChevronDown
                  size={16}
                  className={cn("text-text-secondary transition-transform", advancedOpen && "rotate-180")}
                />
              </button>
              {advancedOpen && (
                <div className="grid grid-cols-2 gap-3 border-t border-border/60 px-4 py-3">
                  <Field label="Model">
                    <select value={model} onChange={(e) => setModel(e.target.value)} className={inputClass}>
                      {MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Reasoning">
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
              )}
            </div>

            {isEdit && (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-text-secondary">Recent runs</span>
                <ScheduleRunList scheduleId={schedule!.id} />
              </div>
            )}

            {localError && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-danger">
                <AlertCircle size={15} className="shrink-0" />
                <span className="min-w-0 flex-1">{localError}</span>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-4">
            <div className="flex items-center gap-2">
              {isEdit && (
                <>
                  <Button type="button" variant="ghost" size="sm" onClick={handlePauseResume}>
                    {schedule!.enabled ? <Pause size={15} /> : <Play size={15} />}
                    {schedule!.enabled ? "Pause" : "Resume"}
                  </Button>
                  <button
                    type="button"
                    onClick={handleDelete}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/10"
                  >
                    <Trash2 size={15} /> Delete
                  </button>
                </>
              )}
            </div>
            <Button type="submit" size="sm" disabled={!canSubmit} loading={submitting}>
              {isEdit ? "Save" : "Create task"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SchedulePreview({
  loading,
  friendly,
  result,
  timezone,
}: {
  loading: boolean;
  friendly: string | null;
  result: CronPreviewResponse | null;
  timezone: string;
}) {
  const invalid = result && !result.valid;
  const label = friendly ?? result?.description ?? "";
  return (
    <div className="rounded-lg border border-border/60 bg-main/50 px-3.5 py-3">
      {invalid ? (
        <p className="flex items-center gap-1.5 text-sm text-red-400">
          <AlertCircle size={14} className="shrink-0" />
          {result?.error || "Invalid schedule"}
        </p>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm text-text-primary">
            {loading && <Spinner size={12} className="text-text-secondary" />}
            {label || "Set a schedule to preview run times."}
          </p>
          {result?.valid && result.nextRuns.length > 0 && (
            <p className="mt-1.5 text-xs text-text-secondary">
              Next:{" "}
              {(() => {
                try {
                  return new Intl.DateTimeFormat(undefined, {
                    timeZone: timezone,
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(new Date(result.nextRuns[0]));
                } catch {
                  return result.nextRuns[0];
                }
              })()}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

export default ScheduleForm;

"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  MODELS,
  REASONING_EFFORTS,
  DEFAULT_EFFORT,
} from "@/lib/types";
import type { ReasoningEffort } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { cn } from "@/components/ui/cn";

export interface ModelEffortPickerProps {
  /** Current model id. */
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Where the menu opens relative to the trigger. */
  side?: "top" | "bottom";
  align?: "start" | "end";
}

/**
 * Claude-Desktop-style model + effort control. A single trigger on the right of
 * the composer reads "<model> · <effort>" (e.g. "GPT-5.4 mini · Standard"), and
 * opens ONE popover with a Model section over an Effort section — mirroring
 * claude.ai, where model + effort live in a single right-side menu rather than
 * two separate pills. Model selection flows through `onChange`; effort binds
 * directly to the chat store (no prop threading), matching the old pickers.
 */
export function ModelEffortPicker({
  value,
  onChange,
  disabled,
  side = "top",
  align = "end",
}: ModelEffortPickerProps) {
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);

  const model = MODELS.find((m) => m.id === value) ?? MODELS[0];
  const currentEffort =
    REASONING_EFFORTS.find((e) => e.id === effort) ??
    REASONING_EFFORTS.find((e) => e.id === DEFAULT_EFFORT) ??
    REASONING_EFFORTS[0];

  return (
    <Dropdown
      side={side}
      align={align}
      disabled={disabled}
      menuClassName="min-w-[18rem]"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className="inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="truncate text-text-primary">{model.label}</span>
          <span aria-hidden className="text-text-secondary/50">
            ·
          </span>
          <span className="truncate">{currentEffort.label}</span>
          <ChevronDown size={15} className="shrink-0 opacity-70" />
        </button>
      }
    >
      {(close) => (
        <div className="flex flex-col">
          {/* Model section */}
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Model
          </div>
          {MODELS.map((m) => (
            <DropdownItem
              key={m.id}
              active={m.id === value}
              onClick={() => {
                onChange(m.id);
                close();
              }}
            >
              <div className="flex w-full items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="font-medium text-text-primary">{m.label}</span>
                  <span className="text-xs text-text-secondary">
                    {m.description}
                  </span>
                </div>
                {m.id === value && (
                  <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                )}
              </div>
            </DropdownItem>
          ))}

          <div className="my-1 h-px bg-border" />

          {/* Effort section */}
          <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Effort
          </div>
          {REASONING_EFFORTS.map((e) => {
            const isActive = e.id === effort;
            const selectable = e.supported;
            return (
              <DropdownItem
                key={e.id}
                active={isActive}
                onClick={() => {
                  if (!selectable) return;
                  setEffort(e.id as ReasoningEffort);
                  close();
                }}
                className={cn(
                  !selectable && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
              >
                <div className="flex w-full items-start justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="flex items-center gap-1.5 font-medium text-text-primary">
                      {e.label}
                      {!selectable && (
                        <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-text-secondary">
                          N/A
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {e.description}
                    </span>
                  </div>
                  {isActive && (
                    <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                  )}
                </div>
              </DropdownItem>
            );
          })}
        </div>
      )}
    </Dropdown>
  );
}

export default ModelEffortPicker;

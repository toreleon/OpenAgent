"use client";

import { Brain, Check, ChevronDown } from "lucide-react";
import { REASONING_EFFORTS, DEFAULT_EFFORT } from "@/lib/types";
import type { ReasoningEffort } from "@/lib/types";
import { useChatStore } from "@/store/chat";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { cn } from "@/components/ui/cn";

export interface ReasoningEffortPickerProps {
  disabled?: boolean;
  /** Where the menu opens relative to the trigger. */
  side?: "top" | "bottom";
  align?: "start" | "end";
}

/**
 * Reasoning-effort selector. Bound directly to the chat store
 * (`effort` / `setEffort`) so it can sit anywhere in the composer without prop
 * threading. Mirrors ModelPicker's look and feel.
 */
export function ReasoningEffortPicker({
  disabled,
  side = "top",
  align = "start",
}: ReasoningEffortPickerProps) {
  const effort = useChatStore((s) => s.effort);
  const setEffort = useChatStore((s) => s.setEffort);

  const current =
    REASONING_EFFORTS.find((e) => e.id === effort) ??
    REASONING_EFFORTS.find((e) => e.id === DEFAULT_EFFORT) ??
    REASONING_EFFORTS[0];

  return (
    <Dropdown
      side={side}
      align={align}
      menuClassName="min-w-[17rem]"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Brain size={15} className="opacity-80" />
          {current.label}
          <ChevronDown size={15} className="opacity-70" />
        </button>
      }
    >
      {(close) =>
        REASONING_EFFORTS.map((e) => {
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
                  <Check size={16} className="mt-0.5 shrink-0 text-text-primary" />
                )}
              </div>
            </DropdownItem>
          );
        })
      }
    </Dropdown>
  );
}

export default ReasoningEffortPicker;

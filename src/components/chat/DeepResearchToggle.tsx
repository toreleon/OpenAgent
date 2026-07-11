"use client";

import { Telescope } from "lucide-react";
import { useChatStore } from "@/store/chat";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/components/ui/cn";

export interface DeepResearchToggleProps {
  disabled?: boolean;
}

/**
 * ChatGPT-style Deep Research toggle. A pill button bound directly to the chat
 * store (`deepResearch` / `setDeepResearch`) so it can sit in the composer
 * footer without prop threading. Mirrors the ReasoningEffortPicker trigger, but
 * flips to a filled accent (pressed) state when research mode is on.
 */
export function DeepResearchToggle({ disabled }: DeepResearchToggleProps) {
  const deepResearch = useChatStore((s) => s.deepResearch);
  const setDeepResearch = useChatStore((s) => s.setDeepResearch);

  return (
    <Tooltip
      label={
        deepResearch
          ? "Deep research is on"
          : "Research across many sources for a cited report"
      }
    >
      <button
        type="button"
        disabled={disabled}
        aria-pressed={deepResearch}
        onClick={() => setDeepResearch(!deepResearch)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
          deepResearch
            ? "bg-accent text-white hover:bg-accent-hover"
            : "text-text-secondary hover:bg-hover hover:text-text-primary",
        )}
      >
        <Telescope size={15} className={cn(!deepResearch && "opacity-80")} />
        Deep research
      </button>
    </Tooltip>
  );
}

export default DeepResearchToggle;

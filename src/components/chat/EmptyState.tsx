"use client";

import { Lightbulb, Code2, PenLine, GraduationCap } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Suggestion {
  icon: LucideIcon;
  title: string;
  prompt: string;
}

const SUGGESTIONS: Suggestion[] = [
  {
    icon: PenLine,
    title: "Write a thank-you note",
    prompt: "Write a warm thank-you note to a colleague who helped me ship a project.",
  },
  {
    icon: Code2,
    title: "Explain this code",
    prompt: "Explain what a debounce function does and show a TypeScript implementation.",
  },
  {
    icon: Lightbulb,
    title: "Brainstorm ideas",
    prompt: "Brainstorm 5 creative names for a productivity app for students.",
  },
  {
    icon: GraduationCap,
    title: "Teach me something",
    prompt: "Explain how HTTPS works as if I were a curious beginner.",
  },
];

export interface EmptyStateProps {
  onPick: (prompt: string) => void;
}

/** Centered greeting + suggestion cards shown when there are no messages. */
export function EmptyState({ onPick }: EmptyStateProps) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center px-4">
      <div className="w-full max-w-chat animate-fade-in-up">
        <h1 className="mb-8 text-center text-3xl font-semibold text-text-primary">
          What can I help with?
        </h1>
        <div className="stagger-children grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.title}
                type="button"
                onClick={() => onPick(s.prompt)}
                className="motion-press group flex items-start gap-3 rounded-2xl border border-border bg-transparent p-4 text-left transition-colors hover:bg-hover"
              >
                <Icon
                  size={18}
                  className="mt-0.5 shrink-0 text-text-secondary group-hover:text-text-primary"
                />
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-text-primary">
                    {s.title}
                  </span>
                  <span className="line-clamp-2 text-xs text-text-secondary">
                    {s.prompt}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default EmptyState;

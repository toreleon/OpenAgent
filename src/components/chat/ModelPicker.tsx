"use client";

import { Check, ChevronDown } from "lucide-react";
import { MODELS } from "@/lib/types";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";

export interface ModelPickerProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /** Where the menu opens relative to the trigger. */
  side?: "top" | "bottom";
  align?: "start" | "end";
}

/** Model selector dropdown sourced from MODELS. */
export function ModelPicker({
  value,
  onChange,
  disabled,
  side = "bottom",
  align = "start",
}: ModelPickerProps) {
  const current = MODELS.find((m) => m.id === value) ?? MODELS[0];

  return (
    <Dropdown
      side={side}
      align={align}
      disabled={disabled}
      menuClassName="min-w-[16rem]"
      trigger={
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {current.label}
          <ChevronDown size={15} className="opacity-70" />
        </button>
      }
    >
      {(close) =>
        MODELS.map((m) => (
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
                <span className="text-xs text-text-secondary">{m.description}</span>
              </div>
              {m.id === value && (
                <Check size={16} className="mt-0.5 shrink-0 text-text-primary" />
              )}
            </div>
          </DropdownItem>
        ))
      }
    </Dropdown>
  );
}

export default ModelPicker;

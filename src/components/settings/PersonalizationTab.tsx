"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { EMPTY_CUSTOM_INSTRUCTIONS } from "@/lib/types";
import { useUserStore } from "@/store/user";
import { useSettingsStore } from "@/store/settings";
import { Button } from "@/components/ui/Button";
import {
  SettingsPanel,
  SettingRow,
  SectionHeader,
  Toggle,
  RowButton,
} from "./primitives";

/** Trait chips that append to the "traits" field (quick-picks). */
const TRAIT_SUGGESTIONS = [
  "Chatty",
  "Witty",
  "Straight shooting",
  "Encouraging",
  "Gen Z",
  "Skeptical",
  "Formal",
];

/**
 * Personalization tab: global custom instructions (wired to the user profile)
 * plus memory preferences (local-only prefs).
 */
export function PersonalizationTab() {
  const profile = useUserStore((s) => s.profile);
  const saving = useUserStore((s) => s.saving);
  const save = useUserStore((s) => s.save);
  const prefs = useSettingsStore((s) => s.prefs);
  const setPref = useSettingsStore((s) => s.setPref);

  const current = profile?.customInstructions ?? EMPTY_CUSTOM_INSTRUCTIONS;

  // Local editable copy of the custom instructions, reseeded whenever the
  // signed-in profile changes (reload / account switch).
  const [nickname, setNickname] = useState(current.nickname);
  const [occupation, setOccupation] = useState(current.occupation);
  const [traits, setTraits] = useState(current.traits);
  const [about, setAbout] = useState(current.about);
  const [enabled, setEnabled] = useState(current.enabled);

  useEffect(() => {
    const ci = profile?.customInstructions ?? EMPTY_CUSTOM_INSTRUCTIONS;
    setNickname(ci.nickname);
    setOccupation(ci.occupation);
    setTraits(ci.traits);
    setAbout(ci.about);
    setEnabled(ci.enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.id]);

  // "Manage memories" is intentionally inert — reveal an honest empty state.
  const [showedMemories, setShowedMemories] = useState(false);

  const dirty =
    nickname !== current.nickname ||
    occupation !== current.occupation ||
    traits !== current.traits ||
    about !== current.about ||
    enabled !== current.enabled;

  /** Append a suggestion chip to the traits field with sensible separators. */
  function appendTrait(trait: string) {
    setTraits((prev) => {
      const trimmed = prev.trimEnd();
      if (!trimmed) return trait;
      const sep = /[,\n]$/.test(trimmed) ? " " : ", ";
      return trimmed + sep + trait;
    });
  }

  async function handleSave() {
    await save({
      customInstructions: { nickname, occupation, traits, about, enabled },
    });
  }

  return (
    <SettingsPanel title="Personalization">
      <SectionHeader>Custom instructions</SectionHeader>

      <div className="flex flex-col gap-4 pt-1">
        <Field label="What should OpenAgent call you?">
          <input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="Nickname"
            className={inputClass}
          />
        </Field>

        <Field label="What do you do?">
          <input
            value={occupation}
            onChange={(e) => setOccupation(e.target.value)}
            placeholder="Your work, studies, etc."
            className={inputClass}
          />
        </Field>

        <Field label="What traits should OpenAgent have?">
          <textarea
            value={traits}
            onChange={(e) => setTraits(e.target.value)}
            rows={3}
            placeholder="Describe the ideal assistant..."
            className={inputClass}
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TRAIT_SUGGESTIONS.map((trait) => (
              <button
                key={trait}
                type="button"
                onClick={() => appendTrait(trait)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-hover"
              >
                {trait}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Anything else OpenAgent should know?">
          <textarea
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            rows={4}
            placeholder="Interests, values, preferences..."
            className={inputClass}
          />
        </Field>
      </div>

      <SettingRow
        label="Enable for new chats"
        control={
          <Toggle
            checked={enabled}
            onChange={setEnabled}
            label="Enable custom instructions for new chats"
          />
        }
      />

      <div className="mt-4 flex justify-end">
        <Button size="sm" onClick={handleSave} disabled={!dirty} loading={saving}>
          Save
        </Button>
      </div>

      <SectionHeader>Memory</SectionHeader>

      <SettingRow
        label="Reference saved memories"
        description="Let OpenAgent save and use memories."
        control={
          <Toggle
            checked={prefs.memorySaved}
            onChange={(next) => setPref("memorySaved", next)}
            label="Reference saved memories"
          />
        }
      />
      <SettingRow
        label="Reference chat history"
        description="Let OpenAgent reference recent conversations."
        control={
          <Toggle
            checked={prefs.memoryHistory}
            onChange={(next) => setPref("memoryHistory", next)}
            label="Reference chat history"
          />
        }
      />
      <SettingRow
        label="Manage memories"
        description={
          showedMemories
            ? "No memories yet."
            : "View and clear the memories OpenAgent has saved."
        }
        control={
          <RowButton onClick={() => setShowedMemories(true)}>Manage</RowButton>
        }
      />
    </SettingsPanel>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none";

/** A stacked question label above its input/textarea. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

export default PersonalizationTab;

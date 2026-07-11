"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  Github,
  Info,
  MoreHorizontal,
  Package,
  Plug,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { InstallPluginRequest, PluginDTO, PluginSourceType } from "@/lib/types";
import { usePluginStore } from "@/store/plugins";
import { Button } from "@/components/ui/Button";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { Toggle } from "./primitives";

/** Plugins tab — install Claude plugins (git repo / local folder) and manage
 *  their skills (progressive-disclosure playbooks the assistant can load). */
export function PluginsTab() {
  const plugins = usePluginStore((s) => s.plugins);
  const loading = usePluginStore((s) => s.loading);
  const error = usePluginStore((s) => s.error);
  const warnings = usePluginStore((s) => s.warnings);
  const load = usePluginStore((s) => s.load);
  const clearWarnings = usePluginStore((s) => s.clearWarnings);

  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary">Plugins</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Install Claude plugins to give the assistant new <em>skills</em> —
            expert playbooks it loads on demand for specific tasks.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} /> Install
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <Info size={15} className="shrink-0" /> Installed with notes
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-6 text-xs text-amber-200/90">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={clearWarnings}
            className="mt-1.5 text-xs font-medium text-amber-300 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {adding && <InstallPluginForm onDone={() => setAdding(false)} />}

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {loading && plugins.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-text-secondary">
            <Spinner size={20} />
          </div>
        ) : plugins.length === 0 && !adding ? (
          <p className="py-10 text-center text-sm text-text-secondary">
            No plugins yet. Install one from a git repo or a local folder.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {plugins.map((p) => (
              <PluginRow key={p.id} plugin={p} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PluginRow({ plugin }: { plugin: PluginDTO }) {
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const setSkillEnabled = usePluginStore((s) => s.setSkillEnabled);
  const remove = usePluginStore((s) => s.remove);

  const [expanded, setExpanded] = useState(false);
  const hasSkills = plugin.skills.length > 0;
  const enabledSkillCount = plugin.skills.filter((s) => s.enabled).length;

  return (
    <li className="rounded-xl border border-border bg-sidebar/40">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button
          type="button"
          aria-label={expanded ? "Collapse skills" : "Expand skills"}
          onClick={() => setExpanded((e) => !e)}
          disabled={!hasSkills}
          className={cn(
            "shrink-0 text-text-secondary transition-colors hover:text-text-primary",
            !hasSkills && "opacity-30",
          )}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <Package size={16} className="shrink-0 text-text-secondary" />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {plugin.name}
            </span>
            {hasSkills && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
                <Sparkles size={11} />
                {enabledSkillCount}/{plugin.skills.length} skill
                {plugin.skills.length === 1 ? "" : "s"}
              </span>
            )}
            {plugin.mcpServerCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-border/50 px-2 py-0.5 text-xs font-medium text-text-secondary">
                <Plug size={11} />
                {plugin.mcpServerCount} MCP
              </span>
            )}
          </div>
          <p
            className="truncate text-xs text-text-secondary"
            title={plugin.description || plugin.sourceUrl}
          >
            {plugin.description ||
              (plugin.marketplace
                ? `From ${plugin.marketplace}`
                : plugin.sourceUrl)}
          </p>
        </div>

        <Toggle
          checked={plugin.enabled}
          onChange={(next) => void setEnabled(plugin.id, next)}
          label={`Enable ${plugin.name}`}
        />

        <Dropdown
          align="end"
          menuClassName="min-w-[11rem]"
          trigger={
            <span className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-border/50 hover:text-text-primary">
              <MoreHorizontal size={16} />
            </span>
          }
        >
          {(close) => (
            <DropdownItem
              danger
              onClick={() => {
                void remove(plugin.id);
                close();
              }}
            >
              <Trash2 size={15} /> Uninstall
            </DropdownItem>
          )}
        </Dropdown>
      </div>

      {plugin.lastError && (
        <div className="mx-3.5 mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-1.5 text-xs text-amber-200/90">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{plugin.lastError}</span>
        </div>
      )}

      {expanded && hasSkills && (
        <div className="border-t border-border/60 px-3.5 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
            Skills ({plugin.skills.length})
          </p>
          <ul className="flex flex-col gap-2.5">
            {plugin.skills.map((s) => (
              <li key={s.name} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium text-text-primary">
                    {s.name}
                  </span>
                  <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">
                    {s.description}
                  </p>
                </div>
                <div className="shrink-0 pt-0.5">
                  <Toggle
                    checked={s.enabled && plugin.enabled}
                    onChange={(next) =>
                      void setSkillEnabled(plugin.id, s.name, next)
                    }
                    label={`Enable skill ${s.name}`}
                  />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function InstallPluginForm({ onDone }: { onDone: () => void }) {
  const install = usePluginStore((s) => s.install);
  const installing = usePluginStore((s) => s.installing);

  const [sourceType, setSourceType] = useState<PluginSourceType>("git");
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canSubmit = source.trim().length > 0 && trusted && !installing;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setLocalError(null);
    const req: InstallPluginRequest = {
      sourceType,
      source: source.trim(),
      ref: sourceType === "git" && ref.trim() ? ref.trim() : undefined,
      trusted,
    };
    const result = await install(req);
    if (result) onDone();
    else setLocalError(usePluginStore.getState().error || "Failed to install plugin");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-xl border border-border bg-sidebar/40 p-4 animate-fade-in"
    >
      <h3 className="text-sm font-semibold text-text-primary">Install plugin</h3>

      <div className="mt-3 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <SourceButton
            active={sourceType === "git"}
            onClick={() => setSourceType("git")}
            icon={<Github size={15} />}
            label="Git repo"
          />
          <SourceButton
            active={sourceType === "local"}
            onClick={() => setSourceType("local")}
            icon={<FolderGit2 size={15} />}
            label="Local folder"
          />
        </div>

        <Field label={sourceType === "git" ? "Repository URL" : "Folder path"}>
          <input
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder={
              sourceType === "git"
                ? "https://github.com/owner/plugin-or-marketplace"
                : "/Users/you/my-plugin"
            }
            className={inputClass}
            autoFocus
          />
        </Field>

        {sourceType === "git" && (
          <Field label="Branch, tag, or commit (optional)">
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="main"
              className={inputClass}
            />
          </Field>
        )}

        <p className="text-xs text-text-secondary">
          Point at a plugin repo, a marketplace, or any folder with a{" "}
          <code className="rounded bg-main px-1 py-0.5">skills/</code> directory
          or a <code className="rounded bg-main px-1 py-0.5">SKILL.md</code>.
        </p>

        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 bg-main/40 p-3">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(e) => setTrusted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          />
          <span className="text-xs text-text-secondary">
            I trust this plugin. Its skill instructions run inside the
            assistant&apos;s prompt — only install plugins from sources you trust.
          </span>
        </label>

        {localError && <p className="text-xs text-red-400">{localError}</p>}

        {installing && (
          <p className="flex items-center gap-2 text-xs text-text-secondary">
            <Spinner size={13} /> Fetching and scanning the plugin…
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={installing}>
            Install
          </Button>
        </div>
      </div>
    </form>
  );
}

function SourceButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "border-accent/60 bg-accent/10 text-text-primary"
          : "border-border bg-main/40 text-text-secondary hover:text-text-primary",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

const inputClass =
  "w-full rounded-lg border border-border bg-main px-3 py-2 text-sm text-text-primary placeholder:text-text-secondary focus:border-text-secondary focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-text-secondary">{label}</span>
      {children}
    </label>
  );
}

export default PluginsTab;

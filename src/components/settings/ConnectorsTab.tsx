"use client";

import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  LogIn,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type {
  CreateMcpConnectorRequest,
  McpAuthStatus,
  McpConnector,
} from "@/lib/types";
import { initMcpOAuthListener, useMcpStore } from "@/store/mcp";
import { Button } from "@/components/ui/Button";
import { Dropdown, DropdownItem } from "@/components/ui/Dropdown";
import { Tooltip } from "@/components/ui/Tooltip";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { Toggle } from "./primitives";

/** Connectors (remote MCP servers) tab. */
export function ConnectorsTab() {
  const connectors = useMcpStore((s) => s.connectors);
  const loading = useMcpStore((s) => s.loading);
  const error = useMcpStore((s) => s.error);
  const load = useMcpStore((s) => s.load);

  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void load();
    const unsubscribe = initMcpOAuthListener(() => {
      void load();
    });
    return unsubscribe;
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-text-primary">Connectors</h2>
          <p className="mt-1 text-sm text-text-secondary">
            Connect remote MCP servers by URL to give the assistant new tools.
          </p>
        </div>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add
          </Button>
        )}
      </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-danger">
          <AlertCircle size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
        </div>
      )}

      {adding && <AddConnectorForm onDone={() => setAdding(false)} />}

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
        {loading && connectors.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-text-secondary">
            <Spinner size={20} />
          </div>
        ) : connectors.length === 0 && !adding ? (
          <p className="py-10 text-center text-sm text-text-secondary">
            No connectors yet. Add one to get started.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connectors.map((c) => (
              <ConnectorRow key={c.id} connector={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusBadge({
  connector,
  onSignIn,
}: {
  connector: McpConnector;
  onSignIn: () => void;
}) {
  const status: McpAuthStatus = connector.authStatus;
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-green-500/15 px-2.5 py-0.5 text-xs font-medium text-green-400">
        <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
        Connected
      </span>
    );
  }
  if (status === "error") {
    return (
      <Tooltip label={connector.lastError || "Connection error"}>
        <span className="inline-flex cursor-default items-center gap-1.5 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-400">
          <AlertCircle size={12} />
          Error
        </span>
      </Tooltip>
    );
  }
  if (status === "pending") {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-400">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
          Needs sign-in
        </span>
        <button
          type="button"
          onClick={onSignIn}
          className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
        >
          <LogIn size={12} /> Sign in
        </button>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-border/50 px-2.5 py-0.5 text-xs font-medium text-text-secondary">
      <span className="h-1.5 w-1.5 rounded-full bg-text-secondary" />
      Not connected
    </span>
  );
}

function ConnectorRow({ connector }: { connector: McpConnector }) {
  const update = useMcpStore((s) => s.update);
  const remove = useMcpStore((s) => s.remove);
  const reconnect = useMcpStore((s) => s.reconnect);

  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const needsSignIn = connector.authStatus === "pending";
  const hasTools = connector.tools.length > 0;

  return (
    <li className="rounded-xl border border-border bg-sidebar/40">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <button
          type="button"
          aria-label={expanded ? "Collapse tools" : "Expand tools"}
          onClick={() => setExpanded((e) => !e)}
          disabled={!hasTools}
          className={cn(
            "shrink-0 text-text-secondary transition-colors hover:text-text-primary",
            !hasTools && "opacity-30",
          )}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {connector.name}
            </span>
            <StatusBadge
              connector={connector}
              onSignIn={() => void reconnect(connector.id)}
            />
          </div>
          <p className="truncate text-xs text-text-secondary" title={connector.url}>
            {connector.url}
          </p>
        </div>

        <Toggle
          checked={connector.enabled}
          onChange={(next) => void update(connector.id, { enabled: next })}
          label={`Enable ${connector.name}`}
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
            <>
              <DropdownItem
                onClick={() => {
                  void reconnect(connector.id);
                  close();
                }}
              >
                {needsSignIn ? <LogIn size={15} /> : <RefreshCw size={15} />}
                {needsSignIn ? "Sign in" : "Reconnect"}
              </DropdownItem>
              <DropdownItem
                onClick={() => {
                  setEditing(true);
                  close();
                }}
              >
                <Pencil size={15} /> Edit
              </DropdownItem>
              <DropdownItem
                danger
                onClick={() => {
                  void remove(connector.id);
                  close();
                }}
              >
                <Trash2 size={15} /> Delete
              </DropdownItem>
            </>
          )}
        </Dropdown>
      </div>

      {editing && (
        <EditConnectorForm connector={connector} onDone={() => setEditing(false)} />
      )}

      {expanded && hasTools && (
        <div className="border-t border-border/60 px-3.5 py-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-secondary">
            Tools ({connector.tools.length})
          </p>
          <ul className="flex flex-col gap-1.5">
            {connector.tools.map((t) => (
              <li key={t.name} className="text-sm">
                <span className="font-medium text-text-primary">{t.name}</span>
                {t.description && (
                  <span className="ml-2 text-text-secondary">{t.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function AddConnectorForm({ onDone }: { onDone: () => void }) {
  const add = useMcpStore((s) => s.add);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const canSubmit =
    name.trim().length > 0 && url.trim().length > 0 && trusted && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setLocalError(null);
    const req: CreateMcpConnectorRequest = {
      name: name.trim(),
      url: url.trim(),
      description: description.trim() || undefined,
      trusted,
    };
    const result = await add(req);
    setSubmitting(false);
    if (result) onDone();
    else setLocalError(useMcpStore.getState().error || "Failed to add connector");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-4 rounded-xl border border-border bg-sidebar/40 p-4 animate-fade-in"
    >
      <h3 className="text-sm font-semibold text-text-primary">Add connector</h3>
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My MCP server"
            className={inputClass}
          />
        </Field>
        <Field label="URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/mcp"
            className={inputClass}
          />
        </Field>
        <Field label="Description (optional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this connector does"
            className={inputClass}
          />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 bg-main/40 p-3">
          <input
            type="checkbox"
            checked={trusted}
            onChange={(e) => setTrusted(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
          />
          <span className="text-xs text-text-secondary">
            I trust this connector. Only add connectors from people or
            organizations you trust.
          </span>
        </label>
        {localError && <p className="text-xs text-red-400">{localError}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={submitting}>
            Add connector
          </Button>
        </div>
      </div>
    </form>
  );
}

function EditConnectorForm({
  connector,
  onDone,
}: {
  connector: McpConnector;
  onDone: () => void;
}) {
  const update = useMcpStore((s) => s.update);
  const [name, setName] = useState(connector.name);
  const [description, setDescription] = useState(connector.description ?? "");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = name.trim().length > 0 && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    await update(connector.id, {
      name: name.trim(),
      description: description.trim() || undefined,
    });
    setSubmitting(false);
    onDone();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-border/60 px-3.5 py-3 animate-fade-in"
    >
      <div className="flex flex-col gap-3">
        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Description (optional)">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={inputClass}
          />
        </Field>
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSubmit} loading={submitting}>
            Save
          </Button>
        </div>
      </div>
    </form>
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

export default ConnectorsTab;

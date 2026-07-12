"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Cpu, Database, KeyRound, Plus, Power, Trash2, Webhook } from "lucide-react";

interface BackendConfig {
  enabled: boolean;
  dataQuotaBytes: number;
  usage: { bytes: number; rows: number };
}
interface KVRow { collection: string; key: string; scope: string; value: string; updatedAt: string }
interface DocRow { id: string; collection: string; data: string; createdAt: string }
interface AccountRow { id: string; username: string; createdAt: string }
interface Endpoint {
  name: string;
  method: string;
  urlTemplate: string;
  approvedHost: string | null;
  secretRefs: string[];
  armed: boolean;
  dailyBudget: number;
}
interface DataBundle { kv: KVRow[]; documents: DocRow[]; accounts: AccountRow[] }
interface FnRow { name: string; code: string; hash: string; armed: boolean; upToDate: boolean; updatedAt: string }
interface FnBundle { flagEnabled: boolean; globalKill: boolean; functions: FnRow[] }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1_048_576).toFixed(1)} MB`);

/** Guess a host + secret placeholders from an endpoint's urlTemplate. */
function inferArm(urlTemplate: string): { host: string; secrets: string[] } {
  const secrets = Array.from(urlTemplate.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)).map((m) => m[1]);
  let host = "";
  try {
    host = new URL(urlTemplate.replace(/\{\{[^}]+\}\}/g, "x").replace(/\{[^}]+\}/g, "x")).host;
  } catch {
    host = "";
  }
  return { host, secrets };
}

export function SiteBackendPanel({ siteId }: { siteId: string }) {
  const [config, setConfig] = useState<BackendConfig | null>(null);
  const [secrets, setSecrets] = useState<string[]>([]);
  const [secretsEnabled, setSecretsEnabled] = useState(true);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [data, setData] = useState<DataBundle | null>(null);
  const [fns, setFns] = useState<FnBundle | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState({ name: "", value: "" });

  const loadConfig = useCallback(() => api<BackendConfig>(`/api/sites/${siteId}/backend`).then(setConfig), [siteId]);
  const loadDetails = useCallback(async () => {
    const [s, e, d, f] = await Promise.all([
      api<{ enabled: boolean; names: string[] }>(`/api/sites/${siteId}/secrets`),
      api<{ endpoints: Endpoint[] }>(`/api/sites/${siteId}/endpoints`),
      api<DataBundle>(`/api/sites/${siteId}/data`),
      api<FnBundle>(`/api/sites/${siteId}/functions`),
    ]);
    setSecrets(s.names);
    setSecretsEnabled(s.enabled);
    setEndpoints(e.endpoints);
    setData(d);
    setFns(f);
  }, [siteId]);

  useEffect(() => {
    void loadConfig().catch((c: unknown) => setError(c instanceof Error ? c.message : "Error"));
  }, [loadConfig]);
  useEffect(() => {
    if (config?.enabled) void loadDetails().catch((c: unknown) => setError(c instanceof Error ? c.message : "Error"));
  }, [config?.enabled, loadDetails]);

  const run = useCallback(
    async (label: string, fn: () => Promise<unknown>, reload: () => Promise<unknown>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
        await reload();
      } catch (c) {
        setError(c instanceof Error ? c.message : "Request failed");
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const toggle = () =>
    run(
      "toggle",
      () =>
        api(`/api/sites/${siteId}/backend`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !config?.enabled }),
        }).then((c) => setConfig(c as BackendConfig)),
      async () => {},
    );

  if (!config) {
    return (
      <section className="mt-8">
        <h2 className="text-sm font-semibold text-text-primary">Backend</h2>
        <p className="mt-2 text-xs text-text-secondary">{error ?? "Loading…"}</p>
      </section>
    );
  }

  const usedPct = config.dataQuotaBytes > 0 ? Math.min(100, (config.usage.bytes / config.dataQuotaBytes) * 100) : 0;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold text-text-primary">Backend</h2>
        <span className="text-xs text-text-secondary">Turn a static site into a mini-app with server data, logins, and APIs.</span>
        <button
          onClick={toggle}
          disabled={busy !== null}
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
            config.enabled ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-500" : "border-border text-text-secondary hover:bg-hover"
          }`}
        >
          <Power size={15} /> {config.enabled ? "Enabled" : "Disabled"}
        </button>
      </div>

      {error && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}

      {config.enabled && (
        <>
          {/* Usage */}
          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-text-secondary">
              <span>Data usage</span>
              <span>{fmtBytes(config.usage.bytes)} / {fmtBytes(config.dataQuotaBytes)} · {config.usage.rows} rows</span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hover">
              <div className="h-full rounded-full bg-accent" style={{ width: `${usedPct}%` }} />
            </div>
          </div>

          {/* Secrets */}
          <div className="mt-6">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><KeyRound size={13} /> Secrets</h3>
            {!secretsEnabled && (
              <p className="mt-1 text-xs text-amber-500">Set SITES_SECRETS_KEK to enable the secret vault.</p>
            )}
            <div className="mt-2 space-y-1.5">
              {secrets.map((name) => (
                <div key={name} className="flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs">
                  <code className="text-text-primary">{name}</code>
                  <span className="text-text-secondary">••••••</span>
                  <button
                    onClick={() => run(`del-secret-${name}`, () => api(`/api/sites/${siteId}/secrets?name=${encodeURIComponent(name)}`, { method: "DELETE" }), loadDetails)}
                    disabled={busy !== null}
                    className="ml-auto text-text-secondary hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
              {secrets.length === 0 && <p className="text-xs text-text-secondary">No secrets yet.</p>}
            </div>
            {secretsEnabled && (
              <div className="mt-2 flex items-center gap-2">
                <input
                  value={newSecret.name}
                  onChange={(e) => setNewSecret((s) => ({ ...s, name: e.target.value }))}
                  placeholder="NAME"
                  className="w-32 rounded-lg border border-border bg-main px-2 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
                />
                <input
                  value={newSecret.value}
                  onChange={(e) => setNewSecret((s) => ({ ...s, value: e.target.value }))}
                  placeholder="value (write-only)"
                  type="password"
                  className="flex-1 rounded-lg border border-border bg-main px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
                />
                <button
                  onClick={() =>
                    run(
                      "add-secret",
                      async () => {
                        await api(`/api/sites/${siteId}/secrets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(newSecret) });
                        setNewSecret({ name: "", value: "" });
                      },
                      loadDetails,
                    )
                  }
                  disabled={busy !== null || !newSecret.name || !newSecret.value}
                  className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <Plus size={13} /> Add
                </button>
              </div>
            )}
          </div>

          {/* Endpoints */}
          <div className="mt-6">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><Webhook size={13} /> API endpoints</h3>
            <div className="mt-2 space-y-2">
              {endpoints.map((ep) => (
                <EndpointRow key={ep.name} ep={ep} siteId={siteId} secrets={secrets} busy={busy} run={run} reload={loadDetails} />
              ))}
              {endpoints.length === 0 && <p className="text-xs text-text-secondary">No endpoints proposed. Ask the assistant to add one to your site.</p>}
            </div>
          </div>

          {/* Server functions (Phase 4) */}
          {fns && (fns.functions.length > 0 || fns.flagEnabled) && (
            <div className="mt-6">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><Cpu size={13} /> Server functions</h3>
              {!fns.flagEnabled && (
                <p className="mt-1 text-xs text-amber-500">Server functions are disabled by the operator (set SITES_FUNCTIONS_ENABLED). Proposed functions won&apos;t run.</p>
              )}
              {fns.globalKill && (
                <p className="mt-1 text-xs text-amber-500">Functions are disabled live by the operator.</p>
              )}
              <div className="mt-2 space-y-2">
                {fns.functions.map((fn) => (
                  <FunctionRow key={fn.name} fn={fn} siteId={siteId} flagEnabled={fns.flagEnabled} busy={busy} run={run} reload={loadDetails} />
                ))}
                {fns.functions.length === 0 && <p className="text-xs text-text-secondary">No functions proposed.</p>}
              </div>
            </div>
          )}

          {/* Data */}
          <div className="mt-6">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-text-primary"><Database size={13} /> Data</h3>
            {data && (
              <div className="mt-2 space-y-3 text-xs">
                <DataList
                  title={`Key/value (${data.kv.length})`}
                  rows={data.kv.map((r) => ({
                    id: `${r.collection}/${r.key}/${r.scope}`,
                    label: `${r.collection}/${r.key}${r.scope !== "shared" ? " · private" : ""}`,
                    value: r.value,
                    del: () => run(`del-kv`, () => api(`/api/sites/${siteId}/data?type=kv&collection=${encodeURIComponent(r.collection)}&key=${encodeURIComponent(r.key)}&scope=${encodeURIComponent(r.scope)}`, { method: "DELETE" }), loadDetails),
                  }))}
                  busy={busy}
                />
                <DataList
                  title={`Documents (${data.documents.length})`}
                  rows={data.documents.map((d) => ({
                    id: d.id,
                    label: d.collection,
                    value: d.data,
                    del: () => run(`del-doc`, () => api(`/api/sites/${siteId}/data?type=doc&id=${encodeURIComponent(d.id)}`, { method: "DELETE" }), loadDetails),
                  }))}
                  busy={busy}
                />
                {data.accounts.length > 0 && (
                  <div>
                    <p className="font-medium text-text-secondary">Accounts ({data.accounts.length})</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {data.accounts.map((a) => (
                        <span key={a.id} className="rounded-full border border-border px-2 py-0.5 text-text-primary">{a.username}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function DataList({ title, rows, busy }: { title: string; rows: { id: string; label: string; value: string; del: () => void }[]; busy: string | null }) {
  return (
    <div>
      <p className="font-medium text-text-secondary">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-1 text-text-secondary/70">Empty.</p>
      ) : (
        <ul className="mt-1 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {rows.slice(0, 50).map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <code className="shrink-0 text-text-secondary">{r.label}</code>
              <span className="flex-1 truncate font-mono text-[11px] text-text-primary">{r.value}</span>
              <button onClick={r.del} disabled={busy !== null} className="text-text-secondary hover:text-danger disabled:opacity-50">
                <Trash2 size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EndpointRow({
  ep, siteId, secrets, busy, run, reload,
}: {
  ep: Endpoint;
  siteId: string;
  secrets: string[];
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>, reload: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<unknown>;
}) {
  const inferred = inferArm(ep.urlTemplate);
  const [host, setHost] = useState(ep.approvedHost || inferred.host);
  const [refs, setRefs] = useState<string[]>(ep.secretRefs.length ? ep.secretRefs : inferred.secrets);
  const [budget, setBudget] = useState(ep.dailyBudget || 1000);

  return (
    <div className={`rounded-lg border px-3 py-2 ${ep.armed ? "border-emerald-500/30 bg-emerald-500/5" : "border-border"}`}>
      <div className="flex items-center gap-2 text-xs">
        <code className="font-semibold text-text-primary">{ep.name}</code>
        <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-text-secondary">{ep.method}</span>
        {ep.armed ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500"><Check size={11} /> armed → {ep.approvedHost}</span>
        ) : (
          <span className="text-[11px] text-amber-500">needs approval</span>
        )}
      </div>
      <code className="mt-1 block truncate font-mono text-[10px] text-text-secondary">{ep.urlTemplate}</code>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="approved host"
          className="w-44 rounded border border-border bg-main px-2 py-1 font-mono text-[11px] text-text-primary outline-none focus:border-accent"
        />
        {secrets.length > 0 && (
          <span className="flex flex-wrap gap-1">
            {secrets.map((s) => {
              const on = refs.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => setRefs((prev) => (on ? prev.filter((x) => x !== s) : [...prev, s]))}
                  className={`rounded-full px-2 py-0.5 text-[10px] ${on ? "bg-accent text-white" : "border border-border text-text-secondary"}`}
                >
                  {s}
                </button>
              );
            })}
          </span>
        )}
        <input
          type="number"
          value={budget}
          onChange={(e) => setBudget(Number(e.target.value))}
          title="daily call budget"
          className="w-20 rounded border border-border bg-main px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
        />
        <button
          onClick={() =>
            run(
              `arm-${ep.name}`,
              () =>
                api(`/api/sites/${siteId}/endpoints`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name: ep.name, approvedHost: host, secretRefs: refs, dailyBudget: budget }),
                }),
              reload,
            )
          }
          disabled={busy !== null || !host}
          className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {ep.armed ? "Re-arm" : "Arm"}
        </button>
      </div>
    </div>
  );
}

function FunctionRow({
  fn, siteId, flagEnabled, busy, run, reload,
}: {
  fn: FnRow;
  siteId: string;
  flagEnabled: boolean;
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>, reload: () => Promise<unknown>) => Promise<void>;
  reload: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const runnable = fn.armed && fn.upToDate;
  return (
    <div className={`rounded-lg border px-3 py-2 ${runnable ? "border-emerald-500/30 bg-emerald-500/5" : "border-border"}`}>
      <div className="flex items-center gap-2 text-xs">
        <code className="font-semibold text-text-primary">{fn.name}</code>
        {runnable ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-500"><Check size={11} /> armed</span>
        ) : fn.armed && !fn.upToDate ? (
          <span className="text-[11px] text-amber-500">code changed — re-arm to run</span>
        ) : (
          <span className="text-[11px] text-amber-500">disarmed — review &amp; arm to run</span>
        )}
        <button onClick={() => setOpen((v) => !v)} className="ml-auto text-text-secondary hover:text-text-primary">
          {open ? "Hide code" : "Review code"}
        </button>
        <button
          onClick={() => run(`del-fn-${fn.name}`, () => api(`/api/sites/${siteId}/functions?name=${encodeURIComponent(fn.name)}`, { method: "DELETE" }), reload)}
          disabled={busy !== null}
          className="text-text-secondary hover:text-danger disabled:opacity-50"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {open && (
        <pre className="mt-2 max-h-56 overflow-auto rounded border border-border bg-main p-2 font-mono text-[10px] leading-relaxed text-text-primary">{fn.code}</pre>
      )}
      <div className="mt-2 flex items-center gap-2">
        {runnable ? (
          <button
            onClick={() => run(`disarm-${fn.name}`, () => api(`/api/sites/${siteId}/functions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fn.name, action: "disarm" }) }), reload)}
            disabled={busy !== null}
            className="rounded border border-border px-2.5 py-1 text-[11px] text-text-secondary hover:text-danger disabled:opacity-50"
          >
            Disarm
          </button>
        ) : (
          <button
            onClick={() => run(`arm-fn-${fn.name}`, () => api(`/api/sites/${siteId}/functions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: fn.name, expectedHash: fn.hash }) }), reload)}
            disabled={busy !== null || !flagEnabled}
            title={!flagEnabled ? "Operator has disabled server functions" : "Approve and arm this exact code"}
            className="rounded bg-accent px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {fn.armed ? "Re-arm" : "Arm"}
          </button>
        )}
        <span className="font-mono text-[10px] text-text-secondary">sha256:{fn.hash.slice(0, 12)}…</span>
      </div>
    </div>
  );
}

export default SiteBackendPanel;

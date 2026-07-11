import { spawn, type SpawnOptions } from "child_process";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import ipaddr from "ipaddr.js";
import { isBlockedIp } from "@/lib/net/safe-fetch";

/**
 * Hardened `git clone` for installing plugins from a remote repo.
 *
 * Cloning an arbitrary URL server-side is an SSRF + code-fetch surface, so we
 * defend in layers:
 *  - Only `https://` URLs; no credentials in the URL; length-capped.
 *  - Resolve the host's DNS and reject if ANY address is private/loopback/
 *    link-local (reuses the web_fetch blocklist). Literal-IP hosts are checked
 *    directly.
 *  - git runs with `protocol.{ext,file}.allow=never` (no `ext::`/`file::`
 *    transports), `core.symlinks=false` (checkout never creates symlinks),
 *    hooks disabled, a scrubbed HOME/env (no ~/.gitconfig, no credential
 *    helper, no terminal prompt), submodules NOT recursed, and a wall-clock
 *    timeout that kills the whole process group.
 *  - ALL of git's network traffic is forced through a loopback CONNECT proxy
 *    ({@link startGuardProxy}) that resolves the host and re-checks isBlockedIp
 *    at CONNECT time, then connects to the SAME validated address. This closes
 *    the DNS-rebinding TOCTOU that a pre-flight-only check has: git never does
 *    its own connect-time DNS, so the address that was validated is exactly the
 *    one connected to (TLS stays end-to-end to the real host over the tunnel).
 *
 * git only fetches files — it does not execute repo content — so the remaining
 * risk (a malicious SKILL.md/script) is handled downstream by the read-only
 * path jail, the trust gate, and never auto-executing bundled scripts.
 */

const MAX_URL_LENGTH = 2048;
const CLONE_TIMEOUT_MS = 90_000;

export class GitCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCloneError";
  }
}

/** Validate a git URL is https, credential-free, and does not resolve to a
 *  private/loopback/link-local address. Throws {@link GitCloneError}. */
export async function assertSafeGitUrl(raw: string): Promise<URL> {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new GitCloneError("A git URL is required.");
  }
  if (raw.length > MAX_URL_LENGTH) {
    throw new GitCloneError(`Git URL exceeds ${MAX_URL_LENGTH} characters.`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new GitCloneError(`Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:") {
    throw new GitCloneError(
      `Only https git URLs are allowed (got ${u.protocol}). Use an https:// clone URL.`,
    );
  }
  if (u.username || u.password) {
    throw new GitCloneError("Git URLs with embedded credentials are not allowed.");
  }

  const host = u.hostname.replace(/^\[|\]$/g, "");
  // Literal IP host → check directly (DNS lookup would just echo it back).
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) {
      throw new GitCloneError(
        `Refusing to clone from a private, loopback, or link-local address (${host}).`,
      );
    }
    return u;
  }

  const lowered = host.toLowerCase();
  if (
    lowered === "localhost" ||
    lowered.endsWith(".localhost") ||
    lowered.endsWith(".local") ||
    lowered.endsWith(".internal")
  ) {
    throw new GitCloneError(`Refusing to clone from ${host}.`);
  }

  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw new GitCloneError(`Could not resolve git host: ${host}.`);
  }
  if (addrs.length === 0) {
    throw new GitCloneError(`Could not resolve git host: ${host}.`);
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new GitCloneError(
        `Refusing to clone from ${host}: it resolves to a blocked address (${a.address}).`,
      );
    }
  }
  return u;
}

const HEX_REF = /^[0-9a-fA-F]{7,40}$/;

/**
 * Clone `url` (optionally at `ref`) into `dest` (which must not yet exist).
 * `ref` may be a branch, tag, or commit SHA. Rejects unsafe URLs first. The
 * clone is shallow for branch/tag refs; a commit SHA falls back to a full clone
 * + checkout (shallow fetch of an arbitrary SHA isn't universally supported).
 */
export async function cloneRepo(opts: {
  url: string;
  ref?: string;
  dest: string;
}): Promise<void> {
  await assertSafeGitUrl(opts.url);

  const ref = opts.ref?.trim() || undefined;
  // A ref is passed as the value of `--branch` (or to `checkout`). Reject one
  // that could be read as an option (leading '-') or that carries whitespace/
  // control chars, as defense-in-depth on top of the `--` separator.
  if (ref !== undefined && (/^-/.test(ref) || /[\s\x00-\x1f]/.test(ref))) {
    throw new GitCloneError(`Invalid git ref: ${JSON.stringify(ref)}`);
  }
  const isSha = ref !== undefined && HEX_REF.test(ref);

  // -c config flags harden the clone; order: hardening first, then subcommand.
  const hardening = [
    "-c", "protocol.ext.allow=never",
    "-c", "protocol.file.allow=never",
    "-c", "protocol.ftp.allow=never",
    "-c", "core.symlinks=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "http.followRedirects=false",
    "-c", "advice.detachedHead=false",
  ];

  const cloneArgs = ["clone", "--no-tags"];
  if (isSha) {
    // Full clone (no --depth), then checkout the SHA below.
    cloneArgs.push("--", opts.url, opts.dest);
  } else {
    cloneArgs.push("--depth", "1", "--single-branch");
    if (ref) cloneArgs.push("--branch", ref);
    cloneArgs.push("--", opts.url, opts.dest);
  }

  // Route git through a loopback guard proxy so the address validated at CONNECT
  // time is exactly the one connected to (defeats DNS rebinding). One proxy for
  // both the clone and any follow-up checkout.
  const proxy = await startGuardProxy();
  try {
    await runGit([...hardening, ...cloneArgs], proxy.port);
    if (isSha) {
      await runGit(
        ["-C", opts.dest, "-c", "advice.detachedHead=false", "checkout", ref!],
        proxy.port,
      );
    }
  } finally {
    await proxy.close();
  }
}

/**
 * A loopback HTTP CONNECT proxy that git tunnels through. On each CONNECT it
 * resolves the target host, rejects if ANY resolved address is blocked
 * (isBlockedIp), then connects to a validated address — so validation and the
 * actual connect are atomic (no second DNS lookup for git to be rebinded on).
 * Bound to 127.0.0.1 on an ephemeral port. TLS is end-to-end between git and the
 * real host over the tunnel, so certificate validation is unaffected.
 */
async function startGuardProxy(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer();
  // Reject ordinary (non-CONNECT) proxy requests outright.
  server.on("request", (_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on("connect", (req, clientSocket, head) => {
    void handleConnect(req.url ?? "", clientSocket, head);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Validate a CONNECT target and, if allowed, tunnel to a validated address. */
async function handleConnect(
  target: string,
  clientSocket: Duplex,
  head: Buffer,
): Promise<void> {
  clientSocket.on("error", () => {});
  const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
  if (!m) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const host = m[1];
  const port = Number(m[2]);

  let address: string;
  try {
    address = await resolveValidated(host);
  } catch {
    clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }

  const upstream = net.connect(port, address, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("close", () => upstream.destroy());
}

/** Resolve a host to a single address, rejecting if it (or ANY of its
 *  addresses) is a blocked/private/loopback/link-local IP. */
async function resolveValidated(host: string): Promise<string> {
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw new Error("blocked address");
    return host;
  }
  const addrs = await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("unresolved");
  for (const a of addrs) {
    if (isBlockedIp(a.address)) throw new Error("blocked address");
  }
  return addrs[0].address;
}

/** Spawn git with a scrubbed env and a hard timeout. Never uses a shell. All
 *  network egress is forced through the loopback guard proxy on `proxyPort`. */
function runGit(args: string[], proxyPort: number): Promise<void> {
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  return new Promise((resolve, reject) => {
    const options: SpawnOptions = {
      // Neutralize credential helpers, ~/.gitconfig, system config, and any
      // interactive prompt. git clone only fetches files (no repo-code
      // execution), so inheriting the rest of the env is safe. The *_proxy vars
      // force every fetch through the guard proxy; no_proxy is emptied so
      // nothing bypasses it.
      env: {
        ...process.env,
        HOME: "/nonexistent",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_ASKPASS: "/bin/echo",
        GCM_INTERACTIVE: "never",
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        ALL_PROXY: proxyUrl,
        no_proxy: "",
        NO_PROXY: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
      // New process group so a timeout can kill git AND any child it spawned.
      detached: true,
    };
    // `-c http.proxy` is explicit and not subject to env-precedence quirks.
    const child = spawn("git", ["-c", `http.proxy=${proxyUrl}`, ...args], options);

    let stderr = "";
    let settled = false;
    const cap = 16 * 1024;
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString("utf8");
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        // Negative pid → kill the whole process group.
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new GitCloneError(`git timed out after ${CLONE_TIMEOUT_MS}ms.`));
    }, CLONE_TIMEOUT_MS);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new GitCloneError(
          err instanceof Error && err.message.includes("ENOENT")
            ? "git is not installed or not on PATH."
            : `Failed to run git: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        const detail = stderr.trim().split("\n").slice(-4).join("\n");
        reject(
          new GitCloneError(
            `git exited with code ${code}${detail ? `:\n${detail}` : "."}`,
          ),
        );
      }
    });
  });
}

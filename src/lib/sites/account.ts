/**
 * Named visitor ACCOUNTS for a Site's mini-app (Phase 2b) — username + password
 * login layered on the anonymous visitor identity (visitor.ts).
 *
 * A logged-in visitor is identified by an `sa` cookie: a STATELESS, HMAC-signed
 * token `base64url(accountId).hmac`, so no session table is needed and it can't
 * be forged without the server secret. Passwords are bcrypt-hashed (same as the
 * app). When an account session is present, private data (Sites.me.*) is scoped
 * `account:<id>` instead of `visitor:<token>`, so it follows the account across
 * devices. Accounts are per-Site.
 *
 * Cookie is httpOnly + host-only + SameSite=Lax (+ `__Host-`/Secure over https),
 * exactly like the visitor cookie — a site origin can never touch the app session.
 */
import { createHmac, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";

const COOKIE_BASE = "sa";
const ONE_YEAR = 60 * 60 * 24 * 365;

function isSecure(): boolean {
  return (process.env.NEXTAUTH_URL ?? "").startsWith("https://");
}
function cookieName(): string {
  return isSecure() ? `__Host-${COOKIE_BASE}` : COOKIE_BASE;
}
function secret(): string {
  return process.env.SITES_SESSION_SECRET || process.env.NEXTAUTH_SECRET || "";
}

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

// A precomputed hash so the "no such user" login path still spends bcrypt time,
// blunting username-enumeration by response timing.
const DUMMY_HASH = bcrypt.hashSync("sites-timing-guard", 10);
export async function dummyVerify(pw: string): Promise<void> {
  await bcrypt.compare(pw, DUMMY_HASH);
}

function macFor(accountId: string): string {
  return createHmac("sha256", secret()).update(accountId).digest("base64url");
}

/** Build the Set-Cookie value that logs an account in. */
export function accountSetCookie(accountId: string): string {
  const token = `${Buffer.from(accountId).toString("base64url")}.${macFor(accountId)}`;
  const parts = [`${cookieName()}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${ONE_YEAR}`];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Build the Set-Cookie value that logs out (clears the account cookie). */
export function accountClearCookie(): string {
  const parts = [`${cookieName()}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (isSecure()) parts.push("Secure");
  return parts.join("; ");
}

/** Verify the `sa` cookie and return the accountId, or null if absent/invalid. */
export function readAccountId(req: Request): string | null {
  if (!secret()) return null;
  const cookie = req.headers.get("cookie") ?? "";
  const name = cookieName().replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  const val = m?.[1];
  if (!val) return null;
  const dot = val.indexOf(".");
  if (dot <= 0) return null;
  const accountId = Buffer.from(val.slice(0, dot), "base64url").toString("utf8");
  const got = Buffer.from(val.slice(dot + 1));
  const want = Buffer.from(macFor(accountId));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return accountId;
}

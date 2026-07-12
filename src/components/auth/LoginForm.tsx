"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Github, Loader2 } from "lucide-react";

export interface LoginFormProps {
  /** Whether the GitHub sign-in button should be shown. */
  githubEnabled: boolean;
}

export default function LoginForm({ githubEnabled }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const res = await signIn("credentials", {
      email: email.trim(),
      password,
      redirect: false,
    });

    setSubmitting(false);

    if (!res || res.error) {
      setError("Invalid email or password.");
      return;
    }

    router.push("/");
    router.refresh();
  }

  async function handleGithub() {
    setGithubLoading(true);
    await signIn("github", { callbackUrl: "/" });
  }

  const busy = submitting || githubLoading;

  return (
    <div className="rounded-2xl border border-border bg-sidebar p-8 shadow-xl">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold text-text-primary">
          Welcome back
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Sign in to continue to your chats
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-text-secondary"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            placeholder="you@example.com"
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="password"
            className="block text-sm font-medium text-text-secondary"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            placeholder="••••••••"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {githubEnabled && (
        <>
          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs uppercase tracking-wide text-text-secondary">
              or
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={handleGithub}
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-main px-4 py-2 font-medium text-text-primary transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {githubLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Github className="h-4 w-4" />
            )}
            Continue with GitHub
          </button>
        </>
      )}

      <p className="mt-6 text-center text-sm text-text-secondary">
        Don&apos;t have an account?{" "}
        <Link
          href="/register"
          className="font-medium text-text-primary hover:underline"
        >
          Sign up
        </Link>
      </p>
    </div>
  );
}

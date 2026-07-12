"use client";

import { signIn } from "next-auth/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Github, Loader2 } from "lucide-react";

import type { ApiError, RegisterRequest } from "@/lib/types";

export interface RegisterFormProps {
  /** Whether the GitHub sign-in button should be shown. */
  githubEnabled: boolean;
}

export default function RegisterForm({ githubEnabled }: RegisterFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [githubLoading, setGithubLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);

    const payload: RegisterRequest = {
      name: name.trim(),
      email: email.trim(),
      password,
    };

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let message = "Something went wrong. Please try again.";
      try {
        const data = (await res.json()) as ApiError;
        if (data?.error) message = data.error;
      } catch {
        /* ignore */
      }
      setSubmitting(false);
      setError(message);
      return;
    }

    // Account created — immediately sign the user in.
    const signInRes = await signIn("credentials", {
      email: payload.email,
      password: payload.password,
      redirect: false,
    });

    setSubmitting(false);

    if (!signInRes || signInRes.error) {
      setError(
        "Your account was created, but automatic sign-in failed. Please sign in.",
      );
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
          Create your account
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          Get started in seconds
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
            htmlFor="name"
            className="block text-sm font-medium text-text-secondary"
          >
            Name
          </label>
          <input
            id="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            placeholder="Ada Lovelace"
          />
        </div>

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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            className="w-full rounded-lg border border-border bg-main px-3 py-2 text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            placeholder="At least 8 characters"
          />
        </div>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? "Creating account…" : "Create account"}
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
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-text-primary hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}

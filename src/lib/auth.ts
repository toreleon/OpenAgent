
import type { NextAuthOptions, Session } from "next-auth";
import { getServerSession } from "next-auth";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";
import bcrypt from "bcryptjs";

import prisma from "@/lib/db";

// ---------------------------------------------------------------------------
// NextAuth module augmentation: put the user id on the session.
// Other agents rely on `session.user.id` being a string after a null check.
// ---------------------------------------------------------------------------
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
  }
}

const githubEnabled =
  !!process.env.GITHUB_ID && !!process.env.GITHUB_SECRET;

// When the app is served over https (prod), pin the session cookie as a
// host-only `__Host-` cookie: the `__Host-` prefix REQUIRES Secure + Path=/ +
// NO Domain, which the browser enforces. Over http (local dev) the prefix and
// Secure are dropped so the cookie is still set. See the `cookies` block below.
const useSecureCookies = (process.env.NEXTAUTH_URL ?? "").startsWith("https://");
const sessionCookieName = `${useSecureCookies ? "__Host-" : ""}next-auth.session-token`;

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: {
    strategy: "jwt",
  },
  // SITE ORIGIN ISOLATION (Phase 0): published Sites are served on their own
  // registrable domain (`<slug>.<SITES_DOMAIN>`), so the app's auth cookie must
  // never be readable from a site origin. We pin it host-only — NO `Domain`
  // attribute (so it is scoped to the exact app host, never sent to a subdomain
  // of any shared parent) + SameSite=Lax + HttpOnly. Separate registrable domain
  // is the primary boundary; this is defense-in-depth. NOTE: changing the cookie
  // name invalidates existing sessions once (users re-login).
  cookies: {
    sessionToken: {
      name: sessionCookieName,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase();
        const password = credentials?.password;
        if (!email || !password) {
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.hashedPassword) {
          return null;
        }

        const valid = await bcrypt.compare(password, user.hashedPassword);
        if (!valid) {
          return null;
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
        };
      },
    }),
    // GitHub provider is only registered when env vars are present.
    ...(githubEnabled
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_ID as string,
            clientSecret: process.env.GITHUB_SECRET as string,
          }),
        ]
      : []),
  ],
  callbacks: {
    async jwt({ token, user }) {
      // On initial sign-in, `user` is present; persist the id on the token.
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = (token.id as string) ?? (token.sub as string);
      }
      return session;
    },
  },
};

/**
 * Server-side session helper usable in Route Handlers and Server Components.
 * Equivalent to `getServerSession(authOptions)`.
 */
export function auth(): Promise<Session | null> {
  return getServerSession(authOptions);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "@prisma/client",
      "bcryptjs",
      "@openai/agents",
      // Server-only parsers used by the web_fetch tool. These pull in Node-only
      // internals (or ship their own bundling quirks); keep webpack from bundling
      // them so they load natively at runtime.
      "@mozilla/readability",
      "linkedom",
      "turndown",
      "unpdf",
      // Server-only browser automation used by the browser-control tools. Pulls in
      // Node-only internals + spawns a native Chromium; must not be webpack-bundled.
      "playwright",
      "playwright-core",
    ],
    // Next 14 needs this to load src/instrumentation.ts (starts the scheduler ticker).
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
      {
        protocol: "http",
        hostname: "localhost",
      },
    ],
  },
};

module.exports = nextConfig;

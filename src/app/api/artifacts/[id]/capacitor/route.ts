import { buildSiteSrcDoc } from "@/components/artifacts/sandbox";
import {
  bundleId,
  loadOwnedArtifactForExport,
  slugify,
  zipResponse,
} from "@/lib/artifact-export";
import { isSiteType, type ApiError, type SiteType } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/artifacts/<id>/capacitor — download a ready-to-build Capacitor project
 * that wraps a rendered artifact (typically a `mobile` React Native app, but any
 * publishable type works) as an installable iOS/Android app. `www/index.html` is
 * the SAME srcdoc the in-app preview and the published `/s/<slug>` page render, so
 * the shell shows exactly what the user saw. We emit an EXPORT + documented build
 * steps — never an in-product native binary (no server-side `cap build`).
 *
 * Auth: the artifact must belong to a conversation owned by the session user.
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const loaded = await loadOwnedArtifactForExport(params.id);
  if (!loaded.ok) return loaded.res;
  const { artifact } = loaded;

  if (!isSiteType(artifact.type)) {
    return Response.json(
      { error: `Type "${artifact.type}" can't be exported as an app` } satisfies ApiError,
      { status: 400 },
    );
  }

  const slug = slugify(artifact.identifier || artifact.title);
  const appId = bundleId(slug);
  const appName = artifact.title || slug;
  const indexHtml = buildSiteSrcDoc(artifact.type as SiteType, artifact.content);

  const files: Record<string, string> = {
    "capacitor.config.json": JSON.stringify(
      { appId, appName, webDir: "www", bundledWebRuntime: false },
      null,
      2,
    ),
    "package.json": JSON.stringify(
      {
        name: slug,
        version: "1.0.0",
        private: true,
        scripts: {
          "add:ios": "cap add ios",
          "add:android": "cap add android",
          sync: "cap sync",
        },
        dependencies: {
          "@capacitor/core": "^6.1.2",
          "@capacitor/ios": "^6.1.2",
          "@capacitor/android": "^6.1.2",
        },
        devDependencies: { "@capacitor/cli": "^6.1.2" },
      },
      null,
      2,
    ),
    "www/index.html": indexHtml,
    "README.md": [
      `# ${appName}`,
      "",
      "A Capacitor project that wraps this app as an installable iOS/Android app.",
      "The web bundle (`www/index.html`) is the exact preview you saw.",
      "",
      "## Build it",
      "",
      "You need Node.js, plus Xcode (iOS) and/or Android Studio (Android).",
      "",
      "```bash",
      "npm install",
      "npx cap add ios       # and/or: npx cap add android",
      "npx cap sync",
      "npx cap open ios      # opens Xcode; Run to build/sign",
      "npx cap open android  # opens Android Studio; Run to build",
      "```",
      "",
      "> Note: the app loads its runtime (react-native-web, etc.) from a CDN at",
      "> first run, so the device needs network access. Store submission uses your",
      "> own Apple/Google developer accounts.",
      "",
    ].join("\n"),
  };

  return zipResponse(files, `${slug}-capacitor.zip`);
}

import {
  bundleId,
  loadOwnedArtifactForExport,
  slugify,
  zipResponse,
} from "@/lib/artifact-export";
import {
  EXPO_DEP,
  EXPO_REACT_VERSION,
  EXPO_RN_VERSION,
  EXPO_SDK,
  EXPO_STATUS_BAR_VERSION,
  EXPO_TYPES_REACT_VERSION,
  EXPO_TYPESCRIPT_VERSION,
} from "@/lib/mobile-runtime";
import { type ApiError } from "@/lib/types";

export const runtime = "nodejs";

/**
 * GET /api/artifacts/<id>/expo — download a real, buildable Expo / React Native
 * project for a `mobile` artifact. The artifact's single-file source IS a React
 * Native app (it renders in the preview via react-native-web), so it drops in as
 * `App.tsx` and runs natively — no code transform beyond guaranteeing a default
 * export. The project pins the current Expo SDK (see src/lib/mobile-runtime.ts)
 * and ships an eas.json so the user runs `eas build` for a real signed
 * IPA/APK/AAB. No native binary is built on our servers.
 *
 * Only `mobile` artifacts export as Expo (other types are not RN source); use the
 * /capacitor route to wrap a web artifact instead.
 */

/**
 * Guarantee App.tsx has a default export. The preview mounts the root from
 * `export default` OR a bare top-level `App` binding (see buildMobileSrcDoc's
 * `typeof App` fallback), but the exported index.ts imports the DEFAULT — so an
 * app that previews fine via that fallback would export broken. Mirror the
 * preview's contract: if there is no default export but a top-level `App` exists,
 * add one. (A source with neither also fails the preview, so we leave it as-is.)
 */
function ensureDefaultExport(src: string): string {
  if (/\bexport\s+default\b/.test(src)) return src;
  if (/(^|\n)\s*(export\s+)?(async\s+)?(function|const|let|var|class)\s+App\b/.test(src)) {
    return `${src.replace(/\s*$/, "")}\n\nexport default App;\n`;
  }
  return src;
}

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const loaded = await loadOwnedArtifactForExport(params.id);
  if (!loaded.ok) return loaded.res;
  const { artifact } = loaded;

  if (artifact.type !== "mobile") {
    return Response.json(
      {
        error: `Only "mobile" artifacts export as an Expo project (this one is "${artifact.type}"). Use the Capacitor export for web artifacts.`,
      } satisfies ApiError,
      { status: 400 },
    );
  }

  const slug = slugify(artifact.identifier || artifact.title);
  const appName = artifact.title || slug;
  const appId = bundleId(slug);

  const files: Record<string, string> = {
    // The RN source, normalized to guarantee the default export index.ts imports.
    "App.tsx": ensureDefaultExport(artifact.content),
    // SDK 57 entry: index registers the App root; there is no expo/AppEntry.js.
    "index.ts":
      `import { registerRootComponent } from "expo";\n` +
      `import App from "./App";\n\n` +
      `registerRootComponent(App);\n`,
    "package.json": JSON.stringify(
      {
        name: slug,
        version: "1.0.0",
        main: "index.ts",
        // No `web` script: `expo start --web` needs react-dom + react-native-web
        // (not deps here); the in-app preview already IS the web view.
        scripts: {
          start: "expo start",
          android: "expo start --android",
          ios: "expo start --ios",
        },
        dependencies: {
          expo: EXPO_DEP,
          "expo-status-bar": EXPO_STATUS_BAR_VERSION,
          // react + react-native are pinned EXACTLY (as the Expo template does).
          react: EXPO_REACT_VERSION,
          "react-native": EXPO_RN_VERSION,
        },
        devDependencies: {
          "@types/react": EXPO_TYPES_REACT_VERSION,
          typescript: EXPO_TYPESCRIPT_VERSION,
        },
        private: true,
      },
      null,
      2,
    ),
    // No icon/splash/adaptiveIcon keys — we ship no binary assets, so Expo uses
    // its built-in defaults (referencing missing PNGs would fail prebuild).
    "app.json": JSON.stringify(
      {
        expo: {
          name: appName,
          slug,
          version: "1.0.0",
          orientation: "portrait",
          userInterfaceStyle: "automatic",
          ios: { supportsTablet: true, bundleIdentifier: appId },
          android: { package: appId },
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      { extends: "expo/tsconfig.base", compilerOptions: { strict: true } },
      null,
      2,
    ),
    // Ship eas.json so `eas build` works without `eas build:configure`. Only the
    // `preview` + `production` profiles — a `development` profile would need the
    // expo-dev-client package, which a minimal project doesn't include.
    "eas.json": JSON.stringify(
      {
        cli: { version: ">= 12.0.0", appVersionSource: "remote" },
        build: {
          preview: { distribution: "internal" },
          production: { autoIncrement: true },
        },
        submit: { production: {} },
      },
      null,
      2,
    ),
    ".gitignore": ["node_modules/", ".expo/", "dist/", "*.log", ".DS_Store", ""].join("\n"),
    "README.md": [
      `# ${appName}`,
      "",
      `A React Native app as a single-file Expo project (SDK ${EXPO_SDK}). The exact`,
      "source runs in the in-app preview (react-native-web) and natively here.",
      "",
      "## Run it locally",
      "",
      "Needs Node.js and the Expo Go app on your phone (or a simulator).",
      "",
      "```bash",
      "npm install",
      "npx expo start        # scan the QR in Expo Go, or press i / a",
      "```",
      "",
      "## Build a real installable app (no Mac needed for iOS)",
      "",
      "Uses EAS Build — Expo's cloud. Free tier is ~15 iOS + 15 Android builds/month.",
      "",
      "```bash",
      "npm install -g eas-cli",
      "eas login             # your Expo account",
      "eas init              # mints YOUR projectId and writes it into app.json",
      "eas build --platform android --profile production   # -> AAB/APK",
      "eas build --platform ios     --profile production   # -> IPA",
      "# or both at once:",
      "eas build --platform all --profile production",
      "```",
      "",
      "Notes:",
      "- `eas init` creates a projectId bound to your account — never reuse someone else's.",
      "- iOS builds run on Expo's macOS cloud; an Apple Developer account is needed only",
      "  for store/device signing (EAS can generate & manage the credentials for you).",
      "- `npx expo install --fix` reconciles versions to the SDK; `npx expo-doctor` validates.",
      "",
    ].join("\n"),
  };

  return zipResponse(files, `${slug}-expo.zip`);
}

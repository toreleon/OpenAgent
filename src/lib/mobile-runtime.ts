/**
 * Single source of truth for the mobile (React Native) runtime versions.
 *
 * Two runtimes render the SAME single-file `mobile` artifact source and must not
 * drift:
 *   1. the in-browser PREVIEW — react-native-web loaded from esm.sh (see the
 *      import map in src/components/artifacts/sandbox.ts), and
 *   2. the native EXPORT — a real Expo project the user builds with EAS (see
 *      src/app/api/artifacts/[id]/expo/route.ts).
 *
 * The preview and the export are independent toolchains (web vs native), so their
 * versions differ; keeping both here makes them one maintained set.
 */

// --- Web preview: react-native-web on esm.sh (MOBILE_IMPORT_MAP) ---------------
export const PREVIEW_REACT_VERSION = "18.3.1";
export const PREVIEW_RNW_VERSION = "0.19.13";

// --- Native export: the Expo SDK the exported project pins ----------------------
// Current stable = Expo SDK 57 (React Native 0.86, React 19.2). `react` and
// `react-native` are pinned EXACTLY (the template does); everything else with `~`.
// No @babel/core / babel.config.js — Metro applies babel-preset-expo automatically.
export const EXPO_SDK = "57";
export const EXPO_DEP = "~57.0.7";
export const EXPO_REACT_VERSION = "19.2.3";
export const EXPO_RN_VERSION = "0.86.0";
export const EXPO_STATUS_BAR_VERSION = "~57.0.1";
export const EXPO_TYPESCRIPT_VERSION = "~6.0.3";
export const EXPO_TYPES_REACT_VERSION = "~19.2.2";

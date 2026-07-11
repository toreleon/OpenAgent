/**
 * Public surface of the plugins subsystem. Routes and the agent import from
 * here; internal modules (git, discover, frontmatter, paths) stay private.
 */
export { installFromSource, PluginInstallError } from "./install";
export type { InstallResult, ResolvedPluginInstall } from "./install";
export {
  listPlugins,
  persistInstall,
  setPluginEnabled,
  setSkillEnabled,
  deletePlugin,
  toPluginDTO,
  parseSkills,
  type InstallSourceMeta,
} from "./store";
export {
  loadSkillsContext,
  loadSkillBody,
  readSkillFile,
} from "./context";
export { GitCloneError } from "./git";

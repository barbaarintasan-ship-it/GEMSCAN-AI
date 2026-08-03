// Metro config — exists solely so the app can import the shared geological core.
//
// shared/geo-core lives OUTSIDE mobile/, because the same deterministic reasoning
// runs on the server (Deno) and here (React Native). Metro only watches the
// project root by default, so the core has to be declared as an extra watch
// folder or its files are invisible to the bundler.
//
// nodeModulesPaths is pinned to mobile/node_modules: adding a watch folder makes
// Metro consider its ancestors for resolution, and the repo root has no
// node_modules — being explicit keeps resolution unambiguous.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const sharedRoot = path.resolve(projectRoot, "..", "shared");
// The 7 GeoContext providers and the engine are pure and are consumed by BOTH
// runtimes, so the app runs them in place rather than duplicating them. They
// still live under supabase/functions/_shared; relocating them into
// shared/geo-core is a mechanical follow-up, blocked only by unrelated
// uncommitted work in that directory.
const serverSharedRoot = path.resolve(projectRoot, "..", "supabase", "functions", "_shared");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedRoot, serverSharedRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

module.exports = config;

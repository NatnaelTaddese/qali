const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const { wrapWithReanimatedMetroConfig } = require("react-native-reanimated/metro-config");

/** @type {import('expo/metro-config').MetroConfig} */
// Expo's default config already detects the bun workspace root: it watches
// the whole monorepo and resolves from both apps/native/node_modules and the
// root node_modules. Do not set `resolver.disableHierarchicalLookup` — bun's
// isolated linker keeps each store package's dependencies beside it under
// node_modules/.bun/<pkg>/node_modules, which only hierarchical lookup from
// the symlink's real path can reach.
const config = getDefaultConfig(__dirname);

const uniwindConfig = withUniwindConfig(wrapWithReanimatedMetroConfig(config), {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});

module.exports = uniwindConfig;

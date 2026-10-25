/**
 * Rebuilds the Paimon host bundles only.
 *
 * `pnpm run build:lib:host` compiles the whole host aggregate (363 packages,
 * ~21 minutes on Windows) to produce the same `lib/index.js` files a profile
 * loads. Paimon iterates on five packages, so that cost is paid for nothing
 * almost every time. tsdown's workspace mode accepts a narrower list, and the
 * decorator plugin has to come along or `@Remote` is left untransformed.
 *
 * Usage, from the repository root, after `tsc -b` has emitted `lib/types/`:
 *
 *   ./node_modules/.bin/tsdown -c tsdown.paimon.config.mjs --config-loader native
 *
 * Two constraints learned the hard way:
 *  - `workspace` entries are globs resolved from the **config file's own
 *    directory**, so this file has to sit at the repository root;
 *  - they must be relative and forward-slash: absolute Windows paths are not
 *    matched by the directory glob, and `../` does not escape the config dir.
 */
import { defineConfig } from 'tsdown'
import { decoratorPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

export default defineConfig({
  workspace: [
    'packages/paimon/task-runtime',
    'packages/paimon/task-runtime-harness',
    'packages/paimon/task-store-file',
    'packages/paimon/tool-paimon-task',
    'packages/paimon/paimon-controller',
  ],
  entry: ['lib/types/{index,startup}.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [decoratorPlugin()],
})

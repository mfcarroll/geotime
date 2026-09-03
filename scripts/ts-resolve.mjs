// scripts/ts-resolve.mjs
//
// Lets `node --test` load the app's own TypeScript directly.
//
// Node 24 strips types by itself, but it will not guess an extension: `src/`
// imports as `./utils` because Vite resolves that, and Node refuses it. This
// adds the one rule that closes the gap, so a pure module can be tested where
// it lives rather than being copied into a test and drifting from the original.
//
// Deliberately not a build step and not a dependency. It only appends `.ts`
// where a relative specifier failed to resolve, which is the whole difference
// between the two resolvers for this codebase.

import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith('.')) return nextResolve(specifier, context);
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

/**
 * P1-A: `buildModelClientChain` has moved to `@focuscode/sdk` so that CLI,
 * SDK, and ACP share the same fallback-chain assembly logic. This file
 * re-exports the SDK implementation for backward compatibility with any
 * external code that imported from the CLI path.
 *
 * The CLI composition root imports directly from `@focuscode/sdk`.
 */
export {
  buildModelClientChain,
  type BuildModelClientChainOptions,
  type ModelClientFactory,
} from "@focuscode/sdk";

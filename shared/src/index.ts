export * from "./types.ts";
export { markdownToPlainText, markdownToPlainBlocks } from "./plaintext.ts";
export { resolveAnchor, makeQuoteSelector, type AnchorResult } from "./anchor-core.ts";
export { createSpanMapper, diffRegions, type SpanMapper, type Region } from "./revision-map.ts";
export {
  trackChanges,
  mapFromBaseline,
  mapToBaseline,
  blockSimilarity,
  PAIR_THRESHOLD,
  ALIGN_EVIDENCE,
  type TrackedChange,
  type BlockLayout,
} from "./track-changes.ts";
export * from "./comments-core.ts";
export * from "./handoff.ts";

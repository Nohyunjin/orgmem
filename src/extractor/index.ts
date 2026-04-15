export type {
  DecisionLabel,
  DecisionResult,
  ExtractedDecision,
} from "./types.ts";

export {
  createExtractorClient,
  createStubExtractorClient,
  parseExtractorJson,
  DEFAULT_EXTRACTOR_MODEL,
  type ExtractorClient,
  type ExtractorClientConfig,
  type ExtractorRequest,
  type ExtractorResponse,
  type ExtractorUsage,
} from "./client.ts";

export { CLASSIFY_SYSTEM, EXTRACT_SYSTEM } from "./prompts.ts";
export { classifyDecision } from "./classify.ts";
export { extractDecisionsFromDoc } from "./extract.ts";
export {
  materializeDecisions,
  type MaterializedDecision,
  type MaterializeError,
  type MaterializeOptions,
  type MaterializeReport,
} from "./materialize.ts";

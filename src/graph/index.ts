/**
 * Public graph API — the surface that Lane B (MCP server) and Lane C
 * (Decision Extractor) are contracted against. **Breaking changes require
 * a version bump AND coordination with Lane B/C** — see TODO.md.
 *
 * Locked by end of week 2:
 *   - createNode / createEdge (this file re-exports them)
 *   - search (see ./search.ts, landing in W2.3)
 *   - upsertDocNodeAndEdges (internal but stable)
 *   - openDb / requireVec
 *   - parseDoc / serializeDoc
 */

export {
  upsertDocNodeAndEdges,
  getNode,
  listEdgesFromFile,
  countNodes,
  countEdges,
} from "./engine.ts";
export type { UpsertResult, NodeRow } from "./engine.ts";

export {
  createNode,
  createEdge,
  appendToNode,
  updateNodeStatus,
  slugify,
  SLUG_MAX_BYTES,
  TASK_STATUSES,
  isTaskStatus,
} from "./write.ts";
export type {
  CreateNodeInput,
  CreateNodeResult,
  CreateEdgeInput,
  CreateEdgeResult,
  AppendToNodeResult,
  UpdateNodeStatusResult,
  TaskStatus,
} from "./write.ts";

export { search, formatHits } from "./search.ts";
export type { SearchHit, SearchNode, Neighbor, SearchOptions } from "./search.ts";

export { computeEdgeId } from "./ids.ts";
export type { EdgeIdInput } from "./ids.ts";

export {
  NODE_TYPES,
  RELATION_TYPES,
  isNodeType,
  isRelationType,
} from "./types.ts";
export type { NodeType, RelationType, GraphNode, GraphEdge } from "./types.ts";

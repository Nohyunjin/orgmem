// Graph type enums — fixed for MVP per design doc.
// v2 will allow user-defined types; do not extend these without bumping the schema version.

export const NODE_TYPES = ["Document", "Task", "Meeting", "Decision", "Person"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const RELATION_TYPES = [
  "references",
  "drives",
  "blocks",
  "decides",
  "attends",
  "driven_by",
  "decided_in",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export function isNodeType(x: unknown): x is NodeType {
  return typeof x === "string" && (NODE_TYPES as readonly string[]).includes(x);
}

export function isRelationType(x: unknown): x is RelationType {
  return typeof x === "string" && (RELATION_TYPES as readonly string[]).includes(x);
}

export interface GraphNode {
  id: string;
  type: NodeType;
  title: string | null;
  content: string | null;
  sourceFile: string | null; // path relative to vault root
  frontmatter: Record<string, unknown>;
  contentHash: string | null; // sha256 of canonicalized file bytes
  mtime: number | null; // ms since epoch
  createdAt: number;
  updatedAt: number;
}

export interface GraphEdge {
  edgeId: string; // deterministic: sha256(src|type|dst|source_file|source_line)
  srcId: string;
  relation: RelationType;
  dstId: string;
  sourceFile: string | null; // file that authored this edge (usually the src)
  sourceLine: number; // 1-based line; 0 for frontmatter-origin
  createdAt: number;
}

/**
 * Embedding model constants. MVP locks this to OpenAI text-embedding-3-small
 * at native dim 1536. Dim switcher is out of scope for now (see TODO.md) —
 * changing dim requires dropping and recreating node_vec, which is a blast-
 * radius operation and deserves its own explicit migration path.
 */
export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIM = 1536;

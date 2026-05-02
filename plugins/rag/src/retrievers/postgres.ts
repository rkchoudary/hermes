/**
 * Postgres + SQL patterns (Postgres 14+).
 */
import type { Retriever } from '../index';

const POSTGRES_PATTERNS = `
**Schema migration safety on populated tables:**

- \`ALTER TABLE … ADD COLUMN x TYPE\` — INSTANT in Postgres 11+ (with default), but
  \`ADD COLUMN x TYPE NOT NULL\` blocks for full table scan
- \`ALTER TABLE … DROP COLUMN x\` — fast (just metadata) but breaks any code that reads x
- \`CREATE INDEX\` blocks writes; use \`CREATE INDEX CONCURRENTLY\` for production
- \`DROP INDEX\` is fast; \`DROP INDEX CONCURRENTLY\` if it's a critical query path
- \`VACUUM FULL\` rewrites the entire table — never on a hot table without maintenance window
- \`CLUSTER\` reorders rows on disk; same caveat

**Locking — what blocks what:**

- \`FOR UPDATE\` — row-level write lock; blocks other UPDATE/DELETE/SELECT FOR UPDATE
- \`FOR SHARE\` — row-level read lock; blocks UPDATE/DELETE but not SELECT
- \`SKIP LOCKED\` — for queue patterns: \`SELECT … FOR UPDATE SKIP LOCKED LIMIT 1\`
- ALTER TABLE takes ACCESS EXCLUSIVE; everything else waits

**Indexes:**
- B-tree (default) — equality, range, ORDER BY
- Partial index for sparse predicates: \`CREATE INDEX … WHERE deleted_at IS NULL\`
- Expression index for derived values: \`CREATE INDEX … ON users(lower(email))\`
- Composite index column order matters: most-selective first, query-pattern second
- \`EXPLAIN ANALYZE\` is the only honest way to see what's happening

**Concurrency / queues:**

\`\`\`sql
-- pull next job atomically
WITH next AS (
  SELECT id FROM jobs
  WHERE status = 'pending'
  ORDER BY priority DESC, created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE jobs SET status = 'in_progress', started_at = NOW()
WHERE id = (SELECT id FROM next)
RETURNING *;
\`\`\`

**JSONB:**
- \`->\` returns JSONB; \`->>\` returns text. Use \`->>\` in WHERE clauses on text values
- GIN index on JSONB: \`CREATE INDEX … USING GIN (col)\` for arbitrary path queries
- Targeted GIN: \`USING GIN ((col -> 'frequently_queried_field'))\` if only one path matters
- Don't store huge documents in JSONB if you query individual fields — normalize them

**Common pitfalls:**
- \`SELECT *\` in production code: locks you into the schema, hurts caching
- N+1 queries from ORMs — measure with \`pg_stat_statements\`
- Long-running transactions hold locks; break large UPDATEs into batches
- \`LIKE '%foo%'\` can't use a B-tree index; use a trigram (pg_trgm) GIN index instead
- Connection pool exhaustion: cap your pool, use a queue for bursts
`;

export const postgresRetriever: Retriever = {
  name: 'postgres@14+',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /\.sql|migration|alter table|create index|jsonb|prisma\/schema|select|postgres|psql/.test(hints);
  },
  async enrich(_pack) { return POSTGRES_PATTERNS.trim(); },
};

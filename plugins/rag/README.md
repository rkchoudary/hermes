# hermes-rag

Framework-aware RAG plugin for Hermes. When the task pack's `allowed_paths` or `objective` matches a known stack, prepends a curated patterns block to the worker prompt under "FRAMEWORK CONTEXT".

Reduces "stale knowledge" failures — workers using old API patterns because their training cut-off pre-dates a major release.

## How to use

In your worker dispatch code (e.g., `work.ts`):

```ts
import { enrichPromptForPack } from 'hermes-rag';

const frameworkBlock = await enrichPromptForPack(pack);
const finalPrompt = frameworkBlock + '\n' + originalPrompt;
```

Or via the plugin loader pattern (planned):

```yaml
# .hermes/config.yaml
plugins:
  - hermes-rag
```

## What ships

- `react@18+` reference retriever — Server Components, useTransition, Form Actions, common pitfalls. Hand-curated.

## Adding your own retriever

1. Create `plugins/rag/src/retrievers/<name>.ts`
2. Implement the `Retriever` interface from `../index.ts`:
   - `name`: stable identifier ("django@5", "fastapi@0.100")
   - `matches(pack)`: returns true if this retriever should run
   - `enrich(pack)`: returns the markdown block to inject (or null)
3. Register it in `src/index.ts`:
   ```ts
   import { djangoRetriever } from './retrievers/django';
   registerRetriever(djangoRetriever);
   ```
4. Submit a PR

## Real production retrievers

The reference impl is hand-curated for proof-of-concept. Production retrievers should:
- Back onto a vector store (Chroma, Qdrant, pgvector) seeded from official framework docs
- Query LSP / language server for actual symbol availability in the host project
- Cache fetched docs locally to avoid network IO during dispatch
- Version-pin the retriever to a specific framework release tag

## License

Apache-2.0.

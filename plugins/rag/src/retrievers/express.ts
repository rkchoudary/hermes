/**
 * Express + Fastify (Node.js HTTP servers) modern patterns.
 */
import type { Retriever } from '../index';

const NODE_HTTP_PATTERNS = `
**Express 4 vs 5 — what changed:**

- Express 5 (released 2024) made async route handlers first-class:
  - \`app.get('/x', async (req, res) => { ... })\` — uncaught rejections now go to error middleware automatically
  - Express 4 silently swallowed unhandled rejections — must wrap with \`asyncHandler\` HOF
- Path-to-regexp 6 (Express 5): wildcards changed (\`:slug*\` → \`{:slug}*\`)
- Removed deprecated APIs: \`req.param()\`, \`res.sendfile()\`, \`app.del()\`

**Async-safe error handling (Express 4 — required wrapper):**

\`\`\`ts
const asyncHandler = (fn: RequestHandler): RequestHandler =>
  (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/users/:id', asyncHandler(async (req, res) => {
  const user = await db.users.findById(req.params.id);
  res.json(user);
}));

// At the end:
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal' });
});
\`\`\`

**Validation — zod recommended:**

\`\`\`ts
import { z } from 'zod';
const CreateUser = z.object({ email: z.string().email(), age: z.number().int().min(13) });

app.post('/users', asyncHandler(async (req, res) => {
  const input = CreateUser.parse(req.body);  // throws on invalid → handled by error middleware
  const user = await db.users.create(input);
  res.status(201).json(user);
}));
\`\`\`

**Fastify (alternative — faster):**

- \`fastify\` instead of \`express\`
- Schema-first: every route declares request/response JSON Schema → automatic validation + 2x speed
- Plugin system replaces middleware: \`fastify.register(authPlugin)\`
- Typescript types are first-class (no \`@types/express\` divergence)

**Common pitfalls:**
- Don't trust \`req.body\` without validation — even with body-parser, types are not enforced
- Set \`trust proxy\` if behind a load balancer for accurate \`req.ip\`
- Use \`helmet()\` for security headers; CSRF token only for browser-form endpoints
- Pin \`express\` major version; 4→5 is breaking
- Stream large responses: \`res.write\` + \`res.end\`, not buffering JSON.stringify
`;

export const expressRetriever: Retriever = {
  name: 'express@4-5 / fastify',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /express|fastify|app\.(get|post|put|delete|patch|use)|router\.|res\.(json|send|status)|asynchandler/.test(hints);
  },
  async enrich(_pack) { return NODE_HTTP_PATTERNS.trim(); },
};

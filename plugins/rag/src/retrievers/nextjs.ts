/**
 * Next.js 13+ app-router patterns.
 */
import type { Retriever } from '../index';

const NEXT_PATTERNS = `
**App router (Next.js 13+):**

- File conventions in \`app/\`:
  - \`page.tsx\` — route segment renderer
  - \`layout.tsx\` — wraps page + nested layouts; persists across navigation
  - \`loading.tsx\` — Suspense fallback for the segment
  - \`error.tsx\` — error boundary; must be a Client Component
  - \`not-found.tsx\` — 404 fallback
  - \`route.ts\` — REST handler (GET/POST/etc exported)
  - \`template.tsx\` — like layout but re-mounts on navigation

**Data fetching (App Router):**

\`\`\`tsx
// app/posts/[id]/page.tsx — Server Component, async by default
export default async function Post({ params }: { params: { id: string } }) {
  const post = await fetch(\`https://api.example.com/posts/\${params.id}\`).then(r => r.json());
  return <article>{post.title}</article>;
}
\`\`\`

**Caching defaults (Next.js 15 changed):**

- Next 14: fetch() defaults to \`cache: 'force-cache'\`
- Next 15: fetch() defaults to \`cache: 'no-store'\` — must opt in for caching
- Use \`export const revalidate = 60\` at page level for ISR-style revalidation
- Use \`unstable_cache\` for memoizing arbitrary functions

**Route handlers:**

\`\`\`ts
// app/api/users/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function GET(req: NextRequest) {
  const users = await db.users.findAll();
  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  // ...
  return NextResponse.json({ ok: true }, { status: 201 });
}
\`\`\`

**Streaming + Suspense:**

\`\`\`tsx
import { Suspense } from 'react';

export default function Page() {
  return (
    <>
      <Header />  {/* renders immediately */}
      <Suspense fallback={<Loading />}>
        <SlowDataComponent />  {/* streams in when ready */}
      </Suspense>
    </>
  );
}
\`\`\`

**Common pitfalls:**
- Don't put \`'use client'\` on the layout — it forces every child to client.
- \`searchParams\` and \`params\` are async in Next 15 (\`await params\`).
- Don't import server-only code into Client Components — wrap with \`'server-only'\`.
`;

export const nextjsRetriever: Retriever = {
  name: 'next.js@13+',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /next\.config|app\/[a-z]+\/page\.tsx|use[\s-]?server|next\/font|next\/image|next\/link|app router|server.action/.test(hints);
  },
  async enrich(_pack) { return NEXT_PATTERNS.trim(); },
};

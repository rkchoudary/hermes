/**
 * Reference retriever — React 18+ server-component / transition / form-action
 * patterns. Hand-curated; small enough to ship in-tree.
 *
 * Real production retrievers should back onto a vector store + dynamic doc
 * fetch. This file is the proof-of-concept the community can replicate for
 * other frameworks.
 */
import type { Retriever } from '../index';

const REACT_PATTERNS = `
**Server Components vs Client Components (React 18+ / Next.js 13+):**

- Server Components are the default in app/ directory. They run only on the
  server, can access fs / db directly, but cannot use \`useState\`,
  \`useEffect\`, browser APIs, or event handlers.
- Client Components opt in with \`'use client'\` directive at the top of the
  file. Required for interactivity (onClick, useState, useRef, etc.).
- A Server Component can render a Client Component as a child, but a Client
  Component cannot import a Server Component (only pass it as a child via
  props.children).

**useTransition + Suspense (concurrent rendering):**

\`\`\`tsx
'use client';
import { useTransition } from 'react';

const [isPending, startTransition] = useTransition();

const handleSearch = (q: string) => {
  startTransition(() => {
    // updates inside startTransition are non-blocking — UI stays responsive
    setQuery(q);
  });
};
\`\`\`

**Form Actions (React 19):**

\`\`\`tsx
// In a Server Component
async function submitOrder(formData: FormData) {
  'use server';
  // runs on server when form submits
  const items = formData.get('items');
  await db.orders.insert({ items });
  revalidatePath('/orders');
}

export default function OrderForm() {
  return <form action={submitOrder}>...</form>;
}
\`\`\`

**Common pitfalls:**

- Don't import server-only modules (\`fs\`, \`db client\`) into Client Components.
- Don't pass functions or class instances as props from Server → Client; only
  serializable data + Server Actions.
- Don't useEffect for data fetching in Server Components — fetch directly in
  the component body, return JSX.
- \`use\` (the React 19 hook) unwraps a Promise; only callable inside a
  Suspense boundary.

**Hooks that DO NOT work in Server Components:**

useState, useEffect, useRef, useReducer, useContext, useMemo, useCallback,
useLayoutEffect, useImperativeHandle, useDeferredValue, useTransition.

**Hooks that work everywhere (React 19):**

\`use\` (unwraps a Promise / Context), \`useId\`.
`;

export const reactRetriever: Retriever = {
  name: 'react@18+',
  matches(pack) {
    const hints = [
      ...(pack.allowed_paths || []),
      ...(pack.references?.code_paths || []),
      pack.objective || '',
    ].join(' ').toLowerCase();
    return /\.(tsx|jsx)\b|use[\s-]?client|use[\s-]?server|server.component|app\/[a-z]+\/page|next\.js|next@/.test(hints);
  },
  async enrich(_pack) {
    // No external IO — just return the curated patterns. A real production
    // retriever would query a vector store seeded from React docs.
    return REACT_PATTERNS.trim();
  },
};

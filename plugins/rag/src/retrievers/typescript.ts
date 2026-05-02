/**
 * TypeScript 5.4+ patterns.
 */
import type { Retriever } from '../index';

const TYPESCRIPT_PATTERNS = `
**Strict mode essentials (tsconfig.json):**

\`\`\`json
{
  "compilerOptions": {
    "strict": true,                          // shorthand for the 8 below
    "noImplicitAny": true,                   // every parameter must have a type
    "strictNullChecks": true,                // null and undefined are not assignable
    "strictFunctionTypes": true,             // covariance/contravariance enforcement
    "strictBindCallApply": true,             // .bind/.call/.apply argument types checked
    "strictPropertyInitialization": true,    // class fields must be initialized
    "noImplicitThis": true,                  // 'this' in functions must be typed
    "alwaysStrict": true,                    // emit "use strict" + parse in strict mode
    "useUnknownInCatchVariables": true       // catch (e: unknown), narrow before use
  }
}
\`\`\`

**Type narrowing (TypeScript 5.x):**

\`\`\`ts
function process(input: string | number) {
  if (typeof input === 'string') {
    // input is string here
    return input.toUpperCase();
  }
  // input is number here
  return input.toFixed(2);
}

// Discriminated unions:
type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };
function area(s: Shape) {
  switch (s.kind) {
    case 'circle': return Math.PI * s.radius ** 2;  // s.radius is typed
    case 'square': return s.side ** 2;
  }
}

// Type predicates for custom narrowing:
function isError(x: unknown): x is Error {
  return x instanceof Error;
}
\`\`\`

**Branded types (compile-time-only nominal typing):**

\`\`\`ts
type UserId = string & { readonly __brand: 'UserId' };
type OrderId = string & { readonly __brand: 'OrderId' };

function makeUserId(s: string): UserId { return s as UserId; }
function fetchUser(id: UserId) { /* ... */ }
fetchUser('123' as OrderId);  // type error — different brands
\`\`\`

**const generics + as const:**

\`\`\`ts
const colors = ['red', 'green', 'blue'] as const;
type Color = typeof colors[number];  // 'red' | 'green' | 'blue'

// Generic that preserves literal types:
function tuple<T extends readonly unknown[]>(...args: T): T { return args; }
const t = tuple(1, 'a', true);  // [1, 'a', true], not [number, string, boolean]
\`\`\`

**satisfies (TypeScript 4.9+):**

\`\`\`ts
const config = {
  host: 'localhost',
  port: 3000,
} satisfies { host: string; port: number };
// config.host is still 'localhost' (not widened to string)
\`\`\`

**Common pitfalls:**
- \`any\` defeats the type system; \`unknown\` forces narrowing
- \`as Type\` is an unsafe cast; prefer narrowing or runtime validation (zod)
- \`enum\` ships extra runtime code; use \`as const\` literal unions instead
- \`object\` is too broad (\`{}\`, arrays, functions); use \`Record<string, unknown>\`
- Don't \`Object.keys(x)\` for typed iteration — TS widens to \`string[]\` (bug-by-design)
`;

export const typescriptRetriever: Retriever = {
  name: 'typescript@5.4+',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /\.(ts|tsx)\b|tsconfig|typescript|\binterface\b|\btype\s/.test(hints);
  },
  async enrich(_pack) { return TYPESCRIPT_PATTERNS.trim(); },
};

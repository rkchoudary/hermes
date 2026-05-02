/**
 * Tailwind CSS 3+ patterns (incl. Tailwind 4 alpha).
 */
import type { Retriever } from '../index';

const TAILWIND_PATTERNS = `
**Tailwind 3 → 4: what changed (Tailwind 4 alpha, 2024):**

- Configuration moves from \`tailwind.config.js\` → CSS-first \`@import "tailwindcss"\`
- No more \`content: [...]\` — Tailwind 4 auto-detects template files
- New oxide engine: 10x faster builds; no more JIT vs AOT distinction
- \`@theme\` directive replaces JS theme config
- \`text-balance\` / \`text-pretty\` utilities

**Composition over single utilities:**

\`\`\`tsx
// Don't: long utility chains repeated everywhere
<button className="rounded-lg bg-blue-600 px-4 py-2 text-white shadow hover:bg-blue-700">

// Do: extract to component (React) or @apply (CSS) for repeated patterns
function PrimaryButton({ children, ...props }) {
  return <button className="btn btn-primary" {...props}>{children}</button>;
}
// In CSS:
@layer components {
  .btn { @apply rounded-lg px-4 py-2 shadow; }
  .btn-primary { @apply bg-blue-600 text-white hover:bg-blue-700; }
}
\`\`\`

**Dark mode:**
- \`dark:bg-gray-900\` for class-strategy (default)
- Configure with \`darkMode: 'class'\` in v3 or \`@variant dark (.dark &)\` in v4
- Use a top-level \`<html class="dark">\` toggle

**Responsive — mobile first:**
- \`md:flex\` means "flex at md breakpoint and above"
- Don't write \`max-md:flex\` for mobile-only — use the default class + \`md:hidden\`

**Performance:**
- Avoid arbitrary values \`w-[123px]\` when a standard utility works — JIT generates extra CSS
- Group related modifiers: \`hover:focus:bg-blue\` — Tailwind handles the cartesian
- Use \`@apply\` sparingly; the per-element utility is faster to build

**Accessibility:**
- \`focus:outline-none\` is bad UX without replacing the focus indicator (\`focus:ring-2\`)
- Color contrast: text-gray-500 on white is borderline; use text-gray-700+
- \`sr-only\` for visually-hidden but screen-reader-accessible content

**Common pitfalls:**
- Don't use \`important: true\` to fight specificity — fix the cascade
- Don't \`@apply\` from a CSS file Tailwind doesn't process (must be in a .css file passed to PostCSS)
- Tailwind doesn't ship a CSS reset by default — use \`@tailwind base\` (v3) or it's auto in v4
`;

export const tailwindRetriever: Retriever = {
  name: 'tailwind@3-4',
  matches(pack) {
    const hints = [...(pack.allowed_paths || []), ...(pack.references?.code_paths || []), pack.objective || ''].join(' ').toLowerCase();
    return /tailwind|className=.*\b(flex|grid|p-\d|m-\d|bg-|text-|rounded|hover:)|@apply|tailwind\.config/.test(hints);
  },
  async enrich(_pack) { return TAILWIND_PATTERNS.trim(); },
};

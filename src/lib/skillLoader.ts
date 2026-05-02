/**
 * v0.5.0 T2 core (Codex tier-plan first-sprint scope, bgxrqvh58):
 * Wire `pack.required_skills` into worker prompts.
 *
 * Skills are SKILL.md files under skills/<name>/ at the harness root. They
 * declare executable policy (Codex prescription: "skills must be executable
 * policy, not inspirational prompt text"). The worker dispatcher reads the
 * skill list from the TaskPack, loads each SKILL.md body, and prepends a
 * compact skills block to the worker's system message.
 *
 * Per Codex risk #1: "Prompt-fragment skills create token bloat and
 * instruction dilution. Five skills can easily become 3k-8k tokens before
 * the actual task. Mitigation: skills must be compact, versioned, and mostly
 * refer to local artifacts and checklists."
 *
 * We keep this loader strict-budgeted. If a skill's body exceeds 4 KB, we
 * truncate with a clear marker so the operator notices and trims the SKILL.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { harnessRoot } from './harnessRoot';
import { sha256OfFile } from './uxEvidence';
import { getLogger } from './logger';

const log = getLogger('skill-loader');

const MAX_SKILL_BODY_KB = 4;

export interface LoadedSkill {
  name: string;
  path: string;
  /** SHA-256 of the SKILL.md file at load time. Pinned in evidence so review can detect drift. */
  sha256: string;
  /** Full body (sans frontmatter) up to MAX_SKILL_BODY_KB. */
  body: string;
  /** Whether the body was truncated to fit the budget. */
  truncated: boolean;
}

/**
 * Resolve the on-disk path of a skill by name. Looks under
 * `${HARNESS_ROOT}/skills/<name>/SKILL.md`.
 *
 * Returns `null` if not found (caller decides whether to error or warn).
 */
export function resolveSkillPath(skillName: string): string | null {
  const root = harnessRoot();
  const candidate = path.join(root, 'skills', skillName, 'SKILL.md');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Load a single skill's body. Strips zod frontmatter (---…--- block at top).
 * Truncates to MAX_SKILL_BODY_KB.
 */
// Codex efficiency review (2026-04-29) #2 (TWEAK: cache only static primer/
// skills sections, exclude volatile pack fields). Process-local cache keyed
// on (skillPath, mtime). SKILL.md files rarely change at runtime; daemon
// can reuse the parsed body across thousands of dispatches.
interface SkillCacheEntry { mtimeMs: number; loaded: LoadedSkill }
const _skillCache = new Map<string, SkillCacheEntry>();

export function loadSkill(skillName: string): LoadedSkill | null {
  const skillPath = resolveSkillPath(skillName);
  if (!skillPath) {
    log.warn('skill not found', { skill: skillName });
    return null;
  }
  // Cache lookup: same path + same mtime → reuse. mtime check is < 1ms.
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(skillPath).mtimeMs; } catch { /* fall through */ }
  const cached = _skillCache.get(skillPath);
  if (cached && cached.mtimeMs === mtimeMs && mtimeMs > 0) return cached.loaded;
  const raw = fs.readFileSync(skillPath, 'utf8');
  // Strip YAML frontmatter (---…---) at top.
  let body = raw;
  if (body.startsWith('---')) {
    const endIdx = body.indexOf('\n---', 3);
    if (endIdx > 0) {
      body = body.slice(endIdx + 4).trimStart();
    }
  }
  const maxBytes = MAX_SKILL_BODY_KB * 1024;
  let truncated = false;
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    body = body.slice(0, maxBytes) + '\n…\n[truncated for prompt budget; see SKILL.md for full text]';
    truncated = true;
  }
  const loaded: LoadedSkill = {
    name: skillName,
    path: skillPath,
    sha256: sha256OfFile(skillPath),
    body,
    truncated,
  };
  if (mtimeMs > 0) _skillCache.set(skillPath, { mtimeMs, loaded });
  return loaded;
}

/**
 * Load all skills declared in pack.required_skills. Missing skills produce a
 * warn line but don't throw (a stale skill name shouldn't block the worker).
 *
 * @returns Loaded skills + a list of missing skill names (for evidence).
 */
export function loadSkills(skillNames: ReadonlyArray<string>): { loaded: LoadedSkill[]; missing: string[] } {
  const loaded: LoadedSkill[] = [];
  const missing: string[] = [];
  for (const name of skillNames) {
    const s = loadSkill(name);
    if (s) loaded.push(s);
    else missing.push(name);
  }
  return { loaded, missing };
}

/**
 * Format the loaded skills as a compact prompt block, ready to prepend to a
 * worker system message. Includes a one-line summary of each skill + its full
 * body separated by skill boundaries.
 *
 * Returns empty string when `loaded` is empty so callers can join unconditionally.
 */
export function formatSkillsForPrompt(loaded: LoadedSkill[]): string {
  if (loaded.length === 0) return '';
  const lines: string[] = [];
  lines.push(`══════════════════════════════════════════════════════════════════════════`);
  lines.push(`REQUIRED SKILLS — ${loaded.length} skill(s) attached to this task pack`);
  lines.push(`Each skill is EXECUTABLE POLICY. Read every section below before writing code.`);
  lines.push(`Worker output will be REJECTED if a skill's stated rejection conditions are violated.`);
  lines.push(`══════════════════════════════════════════════════════════════════════════`);
  lines.push('');
  for (const s of loaded) {
    lines.push(`╭─── SKILL: ${s.name} ${s.truncated ? '(TRUNCATED)' : ''} ───`);
    for (const bodyLine of s.body.split('\n')) {
      lines.push(`│ ${bodyLine}`);
    }
    lines.push(`╰─── END SKILL: ${s.name} ───`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Write loaded skills' identity (path + sha256) to evidence so consensus +
 * replay + doctor can see exactly which skill versions the worker had access to.
 *
 * Codex prescription: "design-system-aware will rot unless it reads canonical
 * repo files at runtime and records their hashes/paths in evidence." This is
 * the harness side of that contract — the worker's design-system-aware
 * actions ALSO record their reads, but pinning the skill SHA itself catches
 * drift in the SKILL.md text between rounds.
 */
export function writeSkillEvidence(evidenceDir: string, loaded: LoadedSkill[], missing: string[]): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const out = {
    schema_version: '1',
    captured_at: new Date().toISOString(),
    skills: loaded.map((s) => ({ name: s.name, path: s.path, sha256: s.sha256, truncated: s.truncated })),
    missing,
  };
  fs.writeFileSync(path.join(evidenceDir, 'skills-loaded.json'), JSON.stringify(out, null, 2));
}

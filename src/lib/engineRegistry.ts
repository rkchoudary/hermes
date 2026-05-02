/**
 * engineRegistry.ts — Sprint M (#21): full multi-CLI provider matrix.
 *
 * Adapter pattern. Adding new engine = one entry below. Lazy availability
 * detection via PATH lookup.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type EngineKey =
  | 'claude-code-cli'
  | 'claude-agent-sdk'
  | 'codex-cli'
  | 'cursor-cli'
  | 'aider'
  | 'continue'
  | 'gemini-cli'
  | 'ollama'
  | 'openai-cli';

export interface EngineSpec {
  key: EngineKey;
  bin: string;
  binEnvVar: string;
  defaultArgs: string[];
  promptDelivery: 'stdin' | 'flag-p' | 'file' | 'arg';
  modelFlag?: string;
  notes: string;
  available: boolean;
}

const SPECS: Omit<EngineSpec, 'available'>[] = [
  { key: 'claude-code-cli', bin: 'claude', binEnvVar: 'AUTO_CLAUDE_BIN', defaultArgs: ['--print', '--dangerously-skip-permissions'], promptDelivery: 'stdin', modelFlag: '--model', notes: 'Claude Code headless; primary harness engine' },
  { key: 'claude-agent-sdk', bin: 'node', binEnvVar: 'AUTO_CLAUDE_AGENT_SDK_BIN', defaultArgs: ['--experimental-vm-modules'], promptDelivery: 'file', notes: 'Claude Agent SDK direct API' },
  { key: 'codex-cli', bin: 'codex', binEnvVar: 'AUTO_CODEX_BIN', defaultArgs: ['exec', '-c', 'model_reasoning_effort=high'], promptDelivery: 'stdin', notes: 'OpenAI codex; council scoring' },
  { key: 'cursor-cli', bin: 'cursor-agent', binEnvVar: 'AUTO_CURSOR_BIN', defaultArgs: ['--print'], promptDelivery: 'flag-p', modelFlag: '--model', notes: 'Cursor agent mode' },
  { key: 'aider', bin: 'aider', binEnvVar: 'AUTO_AIDER_BIN', defaultArgs: ['--no-stream', '--yes-always'], promptDelivery: 'flag-p', modelFlag: '--model', notes: 'Aider git-aware pair programmer' },
  { key: 'continue', bin: 'continue', binEnvVar: 'AUTO_CONTINUE_BIN', defaultArgs: ['run', '--no-color'], promptDelivery: 'stdin', notes: 'Continue.dev CLI' },
  { key: 'gemini-cli', bin: 'gemini', binEnvVar: 'AUTO_GEMINI_BIN', defaultArgs: ['--non-interactive'], promptDelivery: 'stdin', modelFlag: '--model', notes: 'Google Gemini CLI; non-Claude diversity' },
  { key: 'ollama', bin: 'ollama', binEnvVar: 'AUTO_OLLAMA_BIN', defaultArgs: ['run'], promptDelivery: 'stdin', notes: 'Local Ollama; offline tier-3' },
  { key: 'openai-cli', bin: 'openai', binEnvVar: 'AUTO_OPENAI_BIN', defaultArgs: ['api', 'chat.completions.create'], promptDelivery: 'arg', modelFlag: '-m', notes: 'OpenAI-compat CLI; works with proxies' },
];

let _registry: EngineSpec[] | null = null;

export function getRegistry(): EngineSpec[] {
  if (_registry) return _registry;
  _registry = SPECS.map(spec => {
    const overrideBin = process.env[spec.binEnvVar];
    const finalBin = overrideBin || spec.bin;
    let available = false;
    try {
      const pathDirs = (process.env.PATH || '').split(':');
      for (const dir of pathDirs) {
        if (fs.existsSync(path.join(dir, finalBin))) { available = true; break; }
      }
      if (!available && (overrideBin?.startsWith('/') || overrideBin?.startsWith('~'))) {
        if (fs.existsSync(overrideBin)) available = true;
      }
    } catch { /* ignore */ }
    return { ...spec, bin: finalBin, available };
  });
  return _registry;
}

export function findEngine(key: EngineKey): EngineSpec | undefined {
  return getRegistry().find(e => e.key === key);
}

export function pickAvailableEngine(preferred: EngineKey[]): EngineSpec {
  const reg = getRegistry();
  for (const k of preferred) {
    const e = reg.find(x => x.key === k && x.available);
    if (e) return e;
  }
  const fallback = reg.find(x => x.available);
  if (!fallback) throw new Error(`No available LLM engine. Install one of: ${reg.map(e => e.bin).join(', ')}`);
  return fallback;
}

export function describeRegistry(): string {
  return getRegistry().map(e => `${e.available ? '✓' : '✗'} ${e.key.padEnd(20)} ${e.bin.padEnd(20)} ${e.notes}`).join('\n');
}

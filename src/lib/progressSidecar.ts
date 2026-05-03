/**
 * Layer 5 — Progress sidecar reader.
 *
 * Counterpart to the append-only writer in src/cli/work.ts. Consumers
 * (auto:fleet, dashboard SSE, watchdog) call readLatestProgress() to
 * get the most recent event without taking the TaskPack lock.
 *
 * Doctrine: hot-path progress NEVER goes through TaskPack. Lost-update
 * window closed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProgressEvent {
  updated_at: string;
  elapsed_sec: number;
  tool_calls: number;
  edits: number;
  last_tool: string;
  last_file: string;
  engine: string;
  task_id: string;
  run_id: string;
}

export function progressSidecarPath(harnessRootDir: string, runId: string, taskId: string): string {
  return path.join(harnessRootDir, '.agent-runs', runId, 'evidence', taskId, '_progress.jsonl');
}

/**
 * Read the LAST progress event for a task. Returns null when the
 * sidecar doesn't exist or has no parseable lines. O(file size) but
 * sidecars are typically <100 KB even for hour-long dispatches.
 */
export function readLatestProgress(harnessRootDir: string, runId: string, taskId: string): ProgressEvent | null {
  const p = progressSidecarPath(harnessRootDir, runId, taskId);
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]);
      if (typeof ev === 'object' && ev !== null && 'updated_at' in ev) return ev as ProgressEvent;
    } catch { continue; }
  }
  return null;
}

/**
 * Read all progress events for a task (oldest → newest). Used by KPI
 * post-mortem analysis and the dashboard timeline view.
 */
export function readAllProgress(harnessRootDir: string, runId: string, taskId: string): ProgressEvent[] {
  const p = progressSidecarPath(harnessRootDir, runId, taskId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const events: ProgressEvent[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (typeof ev === 'object' && ev !== null && 'updated_at' in ev) events.push(ev as ProgressEvent);
    } catch { continue; }
  }
  return events;
}

/**
 * Compress an old sidecar into a single summary line + truncate.
 * Janitor (Layer 10) calls this for completed tasks where only the
 * summary is interesting going forward.
 */
export function compactSidecar(harnessRootDir: string, runId: string, taskId: string): { compacted: boolean; lines_collapsed: number } {
  const events = readAllProgress(harnessRootDir, runId, taskId);
  if (events.length < 50) return { compacted: false, lines_collapsed: 0 };
  const summary = {
    summary: true,
    first_event_at: events[0].updated_at,
    last_event_at: events[events.length - 1].updated_at,
    final_elapsed_sec: events[events.length - 1].elapsed_sec,
    final_tool_calls: events[events.length - 1].tool_calls,
    final_edits: events[events.length - 1].edits,
    final_last_tool: events[events.length - 1].last_tool,
    final_last_file: events[events.length - 1].last_file,
    engine: events[0].engine,
    task_id: events[0].task_id,
    run_id: events[0].run_id,
    lines_compacted: events.length,
  };
  const p = progressSidecarPath(harnessRootDir, runId, taskId);
  fs.writeFileSync(p, JSON.stringify(summary) + '\n');
  return { compacted: true, lines_collapsed: events.length };
}

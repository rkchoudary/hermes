/**
 * Hermes VS Code extension — minimal MCP-relay surface.
 *
 * Speaks JSON-RPC over stdio to a child `hermes mcp` process. Surfaces
 * the same 4 tools (harness.status, .module_state, .list_parked,
 * .skill_memory) as VS Code commands + tree views.
 *
 * The extension intentionally stays thin: the heavy lifting is in the
 * Hermes core. If you want richer in-IDE behavior (inline diff review,
 * agent thought streaming), wire that in via Webviews on top of this base.
 */
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';

let mcpProcess: ChildProcess | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

interface McpResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function startMcp(harnessRoot: string): ChildProcess | null {
  const cmd = harnessRoot ? 'pnpm' : 'npx';
  const args = harnessRoot ? ['auto:mcp-server'] : ['hermes', 'mcp'];
  const cwd = harnessRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();

  const proc = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as McpResponse;
        const pending = pendingRequests.get(msg.id);
        if (!pending) continue;
        pendingRequests.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result);
      } catch {
        // not JSON-RPC; probably a banner line, ignore
      }
    }
  });
  proc.on('exit', (code) => {
    vscode.window.showInformationMessage(`Hermes MCP exited: ${code}`);
    mcpProcess = null;
  });
  return proc;
}

function callMcp<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  if (!mcpProcess) {
    return Promise.reject(new Error('MCP process not running. Set hermes.mcpAutoStart=true or run "Hermes: Status snapshot" first.'));
  }
  const id = nextRequestId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  return new Promise<T>((resolve, reject) => {
    pendingRequests.set(id, { resolve: resolve as (v: unknown) => void, reject });
    mcpProcess!.stdin?.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 30_000);
  });
}

async function ensureMcp(): Promise<void> {
  if (mcpProcess) return;
  const cfg = vscode.workspace.getConfiguration('hermes');
  const harnessRoot = cfg.get<string>('harnessRoot', '');
  mcpProcess = startMcp(harnessRoot);
  // Send a tools/list to wake it up + verify
  await callMcp('tools/list');
}

export function activate(context: vscode.ExtensionContext): void {
  const cfg = vscode.workspace.getConfiguration('hermes');
  if (cfg.get<boolean>('mcpAutoStart', false)) {
    ensureMcp().catch((e) => vscode.window.showErrorMessage(`Hermes MCP startup: ${e.message}`));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('hermes.status', async () => {
      try {
        await ensureMcp();
        const result = await callMcp<{ content: Array<{ type: string; text: string }> }>('tools/call', { name: 'harness.status' });
        const text = result.content?.[0]?.text || JSON.stringify(result, null, 2);
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: text });
        vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        vscode.window.showErrorMessage(`Hermes status: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('hermes.diagnose', async () => {
      const taskId = await vscode.window.showInputBox({ prompt: 'Task ID to diagnose', placeHolder: 'TP-2026-05-02-001' });
      if (!taskId) return;
      const term = vscode.window.createTerminal({ name: 'hermes diagnose' });
      term.sendText(`pnpm auto:diagnose-task ${taskId}`);
      term.show();
    }),

    vscode.commands.registerCommand('hermes.steer', async () => {
      const taskId = await vscode.window.showInputBox({ prompt: 'Task ID to steer', placeHolder: 'TP-2026-05-02-001' });
      if (!taskId) return;
      const directive = await vscode.window.showInputBox({ prompt: 'Steering directive', placeHolder: 'Use Postgres, not MySQL' });
      if (!directive) return;
      const term = vscode.window.createTerminal({ name: 'hermes steer' });
      term.sendText(`pnpm auto:steer ${taskId} ${JSON.stringify(directive)}`);
      term.show();
    }),

    vscode.commands.registerCommand('hermes.interrupt', async () => {
      const taskId = await vscode.window.showInputBox({ prompt: 'Task ID to interrupt', placeHolder: 'TP-2026-05-02-001' });
      if (!taskId) return;
      const reason = await vscode.window.showInputBox({ prompt: 'Reason for interrupt', placeHolder: 'scope changed' });
      const term = vscode.window.createTerminal({ name: 'hermes interrupt' });
      term.sendText(`pnpm auto:interrupt ${taskId}${reason ? ` --reason ${JSON.stringify(reason)}` : ''}`);
      term.show();
    }),

    vscode.commands.registerCommand('hermes.dispatch', async () => {
      const moduleId = await vscode.window.showInputBox({ prompt: 'Module ID', placeHolder: 'M01' });
      if (!moduleId) return;
      const objective = await vscode.window.showInputBox({ prompt: 'Objective (≤500 chars)' });
      if (!objective) return;
      const term = vscode.window.createTerminal({ name: 'hermes dispatch' });
      term.sendText(`pnpm auto:plan --module ${moduleId} --version v1.0 --type code-sprint --objective ${JSON.stringify(objective)} --auto-fill && pnpm auto:work`);
      term.show();
    }),

    vscode.commands.registerCommand('hermes.dashboard', () => {
      const cfg = vscode.workspace.getConfiguration('hermes');
      const url = cfg.get<string>('dashboardUrl', 'http://localhost:7777');
      const panel = vscode.window.createWebviewPanel('hermesDashboard', 'Hermes Dashboard', vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
      });
      panel.webview.html = `<!DOCTYPE html><html><head><style>body,html{margin:0;padding:0;height:100vh;width:100vw;overflow:hidden}iframe{width:100%;height:100%;border:0}</style></head><body><iframe src="${url}"></iframe></body></html>`;
    }),
  );
}

export function deactivate(): void {
  if (mcpProcess) {
    mcpProcess.kill();
    mcpProcess = null;
  }
}

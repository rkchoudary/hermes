/**
 * Smoke tests for notifications. Run via: pnpm auto:test:notifications
 */
import { notify, notifyFromLegacyMessage, loadConfig } from '../notifications';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}`); } }
function assertEq<T>(a: T, b: T, l: string): void { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); } }

console.log('\n[notifications smoke] starting…\n');

// Suppress console noise during tests
const _log = console.log, _err = console.error;
function silence(): void { console.log = () => {}; console.error = () => {}; }
function restore(): void { console.log = _log; console.error = _err; }

// ─── 1. Severity routing — info goes to console only ────────────────────────
{
  console.log('1. info → console only');
  silence();
  const r = notify('info', 'test info', { source: 'test' }, { dry_run: true, slack_webhook: 'https://example.com/x', pagerduty_integration_key: 'k', email_to: 'x@y' });
  restore();
  assertEq(r.length, 1, 'info routed to 1 backend (console)');
  assertEq(r[0].backend, 'console', 'console backend');
  assertEq(r[0].ok, true, 'console ok');
}

// ─── 2. warning routes to console + slack ───────────────────────────────────
{
  console.log('\n2. warning → console + slack');
  silence();
  const r = notify('warning', 'test warning', {}, { dry_run: true, slack_webhook: 'https://example.com/x', pagerduty_integration_key: 'k', email_to: 'x@y' });
  restore();
  assertEq(r.length, 2, 'warning routes to 2 backends');
  assertEq(r.map((x) => x.backend).sort(), ['console', 'slack'], 'backends include console + slack');
}

// ─── 3. critical routes to console + slack + pagerduty + email ──────────────
{
  console.log('\n3. critical → console + slack + pagerduty + email');
  silence();
  const r = notify('critical', 'test critical', {}, { dry_run: true, slack_webhook: 'https://example.com/x', pagerduty_integration_key: 'k', email_to: 'x@y' });
  restore();
  assertEq(r.length, 4, 'critical routes to 4 backends');
  const backends = r.map((x) => x.backend).sort();
  assertEq(backends, ['console', 'email', 'pagerduty', 'slack'], 'all 4 backends');
  for (const x of r) assertEq(x.ok, true, `${x.backend} ok in dry-run`);
}

// ─── 4. Skipped when not configured ─────────────────────────────────────────
{
  console.log('\n4. unconfigured backends skip cleanly');
  silence();
  const r = notify('critical', 'test', {}, { dry_run: false });  // no creds for any backend
  restore();
  // console always runs; slack/pd/email all skip with attempted=false
  const console_ = r.find((x) => x.backend === 'console')!;
  const slack = r.find((x) => x.backend === 'slack')!;
  const pd = r.find((x) => x.backend === 'pagerduty')!;
  const email = r.find((x) => x.backend === 'email')!;
  assertEq(console_.ok, true, 'console always succeeds');
  assertEq(slack.attempted, false, 'slack skipped (no webhook)');
  assertEq(pd.attempted, false, 'pagerduty skipped (no key)');
  assertEq(email.attempted, false, 'email skipped (no to)');
}

// ─── 5. PagerDuty/email skipped on warning (critical-only by default) ───────
{
  console.log('\n5. pagerduty + email critical-only');
  silence();
  const r = notify('warning', 'test', {}, { dry_run: true, slack_webhook: 'x', pagerduty_integration_key: 'k', email_to: 'x@y' });
  restore();
  assert(!r.some((x) => x.backend === 'pagerduty'), 'no pagerduty for warning');
  assert(!r.some((x) => x.backend === 'email'), 'no email for warning');
}

// ─── 6. Quiet hours suppress slack but NOT pagerduty/email ──────────────────
{
  console.log('\n6. quiet hours: slack suppressed, pagerduty/email always go');
  silence();
  // Force quiet hours window covering the current UTC hour
  const nowH = new Date().getUTCHours();
  const start = nowH;
  const end = (nowH + 1) % 24;
  const quiet = `${start}-${end}`;
  // Warning during quiet → slack should be skipped
  const rWarn = notify('warning', 'test warning', {}, { dry_run: true, slack_webhook: 'x', quiet_hours: quiet });
  const slackWarn = rWarn.find((x) => x.backend === 'slack')!;
  // Critical during quiet → slack should still go (override)
  const rCrit = notify('critical', 'test crit', {}, { dry_run: true, slack_webhook: 'x', pagerduty_integration_key: 'k', email_to: 'x@y', quiet_hours: quiet });
  const slackCrit = rCrit.find((x) => x.backend === 'slack')!;
  const pd = rCrit.find((x) => x.backend === 'pagerduty')!;
  restore();
  assertEq(slackWarn.attempted, false, 'slack suppressed for warning in quiet hours');
  assertEq(slackCrit.attempted, true, 'slack overridden for critical in quiet hours');
  assertEq(pd.attempted, true, 'pagerduty fires regardless of quiet hours');
}

// ─── 7. notifyFromLegacyMessage parses severity from prefix ─────────────────
{
  console.log('\n7. notifyFromLegacyMessage prefix parsing');
  silence();
  const cfg = { dry_run: true };
  const rInfo = notifyFromLegacyMessage('[INFO] something happened', false, cfg);
  const rAlert = notifyFromLegacyMessage('[ALERT] task stuck', false, cfg);
  const rCrit = notifyFromLegacyMessage('[CRITICAL] disk full', false, cfg);
  restore();
  // Each notify() returns one entry per backend CONSIDERED (attempted=true or false)
  assertEq(rInfo.length, 1, 'INFO considers 1 backend');
  assertEq(rAlert.length, 2, 'ALERT (warning) considers console + slack');
  assertEq(rCrit.length, 4, 'CRITICAL considers all 4 backends');
  // Without creds, only console is attempted
  assertEq(rAlert.find((x) => x.backend === 'console')!.attempted, true, 'ALERT console attempted');
  assertEq(rAlert.find((x) => x.backend === 'slack')!.attempted, false, 'ALERT slack skipped (no creds)');
  assertEq(rCrit.find((x) => x.backend === 'pagerduty')!.attempted, false, 'CRITICAL pd skipped (no creds)');
}

// ─── 8. loadConfig reads file + env ─────────────────────────────────────────
{
  console.log('\n8. loadConfig reads file + env');
  // No file at the test cwd; should fall back to env (probably also not set in test) — just verify no throw
  const cfg = loadConfig('/tmp/__nonexistent_root__');
  assert(typeof cfg === 'object', 'loadConfig returns an object');
  assert(cfg.dry_run === false || cfg.dry_run === true || cfg.dry_run === undefined, 'dry_run is boolean or undefined');
}

console.log(`\n[notifications smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

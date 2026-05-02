# hermes-skill-aggregator

Opt-in cross-project skill memory. Every Hermes operator who contributes makes the harness smarter for *everyone* — without anyone giving up proprietary data.

## What it does

When a Hermes operator runs `auto:tick`, the harness writes per-task entries to `.agent-runs/_skill-memory/<phase>.jsonl`. Locally, that drives skill-memory hints in the worker prompt.

Cross-project, this aggregator does the same but pooled. An operator can run:

```bash
pnpm auto:skill-contribute --phase code-sprint
```

…which:
1. Reads the local skill memory file
2. Passes each entry through `scrubber.ts` (drops module IDs, task IDs, paths; buckets exact values)
3. Shows the operator the scrubbed payload
4. Asks "upload? [y/N]"
5. On yes, POSTs to the aggregator

Other operators query:

```bash
pnpm auto:skill-aggregated --phase code-sprint --module-shape code-sprint --ac-count-bucket 4-6
```

…and get back: median patch rounds across N contributors, recovery-rate distribution, cost-bucket distribution.

The harness uses these as additional context in worker prompts: *"Across N operators on similar tasks, median patch rounds = 1.2; cognitive-recovery used 12% of the time."*

## Privacy posture

**Only scrubbed bucket-granularity data crosses the wire:**

| Field | Never sent | Sent | Bucket only |
|---|---|---|---|
| module ID | ✓ | | |
| task ID | ✓ | | |
| file paths | ✓ | | |
| operator name/email | ✓ | | |
| free-text reasons / notes | ✓ | | |
| AC count exact | ✓ | | |
| AC count bucket | | | ✓ (1-3 / 4-6 / 7-10 / 11+) |
| duration exact | ✓ | | |
| duration bucket | | | ✓ (≤5min / 5-15min / 15-60min / >60min) |
| cost USD exact | ✓ | | |
| cost bucket | | | ✓ (≤$0.10 / $0.10-$1 / $1-$10 / >$10) |
| phase | | ✓ | |
| patch rounds (0-10 int) | | ✓ | |
| recovered_via | | ✓ | |
| module shape (frd / trd / etc.) | | ✓ | |

**Other guarantees:**
- Operator IDs are sha256-hashed (truncated to 16 chars) before storage — counts contributors without identifying them
- k-anonymity threshold of 5: bucket aggregates with fewer than 5 contributions are HIDDEN from the public API (prevents single-operator inference)
- GDPR Recital 26: aggregates are not personal data
- Opt-in per upload — no auto-send, no telemetry without explicit operator action

## API

```
POST /api/contribute         operator → us, body: ScrubbedEntry or ScrubbedEntry[]
GET  /api/aggregated/<phase> any → us, returns buckets meeting k-anonymity
GET  /api/stats              total contributors + entries
GET  /api/health
```

## Quick start (run your own aggregator)

```bash
cd packages/hermes-skill-aggregator
pnpm install
pnpm start    # listens on :7791
```

Curl test:
```bash
curl -X POST localhost:7791/api/contribute \
  -H 'Content-Type: application/json' \
  -d '{"phase":"code-sprint","patch_rounds":1,"recovered_via":null,"module_shape":"code-sprint","ac_count_bucket":"4-6","duration_bucket":"5-15min","cost_bucket":"$0.10-$1"}'
```

## v0.1 limitations

- **In-memory** state — aggregates lost on restart. v0.2 will use Postgres or D1.
- **No moderation** — bad actors can submit garbage. v0.2 will add per-contributor rate limits + outlier detection.
- **No RTBF API** — once durable storage lands, contributors can request deletion.
- **No trained model** — just aggregation + retrieval. No fine-tuning, no embeddings.

## License

Apache-2.0. Run your own; don't trust public deployments without reading their privacy notice.

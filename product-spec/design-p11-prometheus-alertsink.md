# P1.1 — Prometheus exporter + AlertSink interface

**Status:** Design · **Author:** /architect · **Date:** 2026-04-22 · **Roadmap ref:** `project_roadmap_plan.md` P1.1 (M)

---

## §1 Context

### What's in the repo today (verified)

| Module | File | State |
|---|---|---|
| `MonitorCollector` | `packages/outer-harness/src/observability/monitor-collector.ts` | In-memory aggregator. `getSnapshot()` pull-only (l.103–115). No subscribe. |
| `AlertEngine` | `packages/outer-harness/src/observability/alert-engine.ts` | Rule-based. `onAlert(listener)` synchronous (l.79–85). 4 default rules. No external delivery. |
| `AuditLogger` | `packages/outer-harness/src/observability/audit-logger.ts` | In-memory ring buffer (MAX_ENTRIES=10000). **Not** JSONL-persisted. |
| HTTP retry | `packages/outer-harness/src/governance/hook-engine.ts:336–374, 483–486` | Exponential backoff on 5xx, capped at 5s. Tangled inside `executeHttpHook`. |
| Types exports | `packages/types/src/metrics.ts:55–135` | `MonitorSnapshot`, `ToolMetrics`, `TurnMetrics`, `AlertEvent`, `AlertSeverity`, `AlertRule` already exported. |

### The gap

`outer-harness-audit.md` §4+§5 flags this as the highest-leverage Phase 2 gap:

> *"No external delivery sinks. Listener is in-process only."* (AlertEngine)
> *"No export format. Snapshot is a JS object, not OTLP / Prometheus text / JSONL."* (MonitorCollector)

POSITIONING Phase 2 names Prometheus + AlertSink explicitly. Without them, users see governance decisions but **can't pipe them into existing Grafana/PagerDuty stacks** — breaking the pitch that AgentWeave drops into an ops pipeline instead of replacing it.

### Goals (aligned to roadmap DoD)

1. Prometheus `/metrics` endpoint returns valid `# HELP` / `# TYPE` lines + ≥5 counter/gauge series mapped from M1–M10.
2. `AlertSink` interface with 3 impls: `StdoutSink`, `FileSink`, `WebhookSink`.
3. `WebhookSink` retries with exponential backoff — **reuses** the HookEngine HTTP retry (extracted into a shared utility).
4. Sink failures never block the pipeline or the `AlertEngine` listener fan-out.
5. Dep-graph invariant preserved: new code lives in `@agentweave/outer-harness`. No cross to inner.
6. No new runtime dependency. Node's built-in `http` module for the `/metrics` server.
7. 594 baseline tests still pass.

---

## §2 Interfaces

### 2.1 `AlertSink` (new, in `@agentweave/outer-harness`)

```ts
// packages/outer-harness/src/observability/alert-sink.ts

import type { AlertEvent } from "@agentweave/types";

/**
 * One-way consumer of AlertEngine output. Sinks are fire-and-forget:
 * errors are swallowed (logged, not thrown) so one failing sink never
 * blocks another, and no sink can feed back into the AlertEngine.
 */
export interface AlertSink {
  readonly name: string;
  /**
   * Deliver one alert. MUST NOT throw — catch internally and log.
   * Called synchronously from AlertEngine's notify loop; sinks that
   * do I/O should return a promise the engine ignores (fire-and-forget).
   */
  publish(alert: AlertEvent): Promise<void>;
  /** Optional graceful shutdown — flush buffered alerts, close sockets. */
  close?(): Promise<void>;
}
```

Three built-in implementations in the same file:

```ts
export class StdoutSink implements AlertSink {
  readonly name = "stdout";
  async publish(alert: AlertEvent): Promise<void> {
    // JSON line — machine-readable, greppable
    process.stdout.write(JSON.stringify({ ...alert, snapshot: undefined }) + "\n");
  }
}

export interface FileSinkOptions {
  path: string;               // JSONL append path
  maxBytes?: number;          // rotation threshold; default 10 MB
}
export class FileSink implements AlertSink { /* ... */ }

export interface WebhookSinkOptions {
  url: string;
  method?: "POST" | "PUT";              // default POST
  headers?: Record<string, string>;
  maxRetries?: number;                  // default 3
  timeoutMs?: number;                   // default 5000 per attempt
  severityFilter?: AlertSeverity[];     // default ["warning","critical"]
}
export class WebhookSink implements AlertSink { /* ... */ }
```

**Registration API** (added to `AlertEngine`):

```ts
// delta on alert-engine.ts — ~10 LOC
class AlertEngine {
  private sinks: AlertSink[] = [];

  addSink(sink: AlertSink): () => void { /* returns remove() */ }

  // Existing notify() loop gains: await-less dispatch to sinks, errors isolated
  private notify(alert: AlertEvent): void {
    // ... existing listener loop ...
    for (const sink of this.sinks) {
      sink.publish(alert).catch((err) => {
        // log but never rethrow — one bad sink can't break others
      });
    }
  }
}
```

### 2.2 Shared HTTP retry utility (extracted, DRY)

```ts
// packages/outer-harness/src/shared/http-retry.ts — NEW, ~40 LOC

export interface HttpRetryOptions {
  maxRetries: number;         // attempts after the initial one
  timeoutMs: number;          // per-attempt timeout
  shouldRetry?: (status: number) => boolean;  // default: 5xx
  baseDelayMs?: number;       // default 1000
  maxDelayMs?: number;        // default 5000
}

export interface HttpRetryResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: Error;
  attempts: number;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: HttpRetryOptions,
  signal?: AbortSignal,
): Promise<HttpRetryResult> { /* ... */ }
```

Both `executeHttpHook()` (hook-engine.ts) and `WebhookSink.publish()` delegate to this. No behavior change for hooks.

### 2.3 `PrometheusExporter` (new)

```ts
// packages/outer-harness/src/observability/prometheus-exporter.ts

import type { MonitorSnapshot } from "@agentweave/types";
import type { MonitorCollector } from "./monitor-collector";
import type { AlertEngine } from "./alert-engine";

export interface PrometheusExporterOptions {
  /** Process-level label applied to every metric. Default: none. */
  instance?: string;
  /** Emit per-session label. Default: false (cardinality safety). */
  includeSessionLabel?: boolean;
}

/**
 * Pure formatter — no HTTP, no I/O. Given a snapshot, returns Prometheus
 * text-format output. The HTTP server (prometheus-server.ts) is a thin
 * wrapper that calls this on each scrape.
 */
export class PrometheusExporter {
  constructor(
    private readonly monitor: MonitorCollector,
    private readonly alerts: AlertEngine,
    private readonly opts: PrometheusExporterOptions = {},
  ) {}

  /** Render the current snapshot as Prometheus text format. */
  render(): string { /* ... */ }
}
```

### 2.4 `PrometheusServer` (new — HTTP binding)

```ts
// packages/outer-harness/src/observability/prometheus-server.ts

import { createServer, type Server } from "node:http";

export interface PrometheusServerOptions {
  port: number;               // required
  host?: string;              // default "127.0.0.1" (localhost by default!)
  path?: string;              // default "/metrics"
}

export class PrometheusServer {
  constructor(
    private readonly exporter: PrometheusExporter,
    private readonly opts: PrometheusServerOptions,
  ) {}

  async start(): Promise<void> { /* createServer + listen, return when listening */ }
  async stop(): Promise<void> { /* graceful close */ }
  get address(): { host: string; port: number } | null { /* ... */ }
}
```

### 2.5 Metric mapping (≥5 series required — 10 defined)

| Prometheus name | Type | Source (MonitorSnapshot) | Labels | Unit |
|---|---|---|---|---|
| `agentweave_turns_total` | counter | `turnCount` | `instance` | turns |
| `agentweave_session_duration_ms` | gauge | `sessionDurationMs` | `instance` | ms |
| `agentweave_input_tokens_total` | counter | `totalUsage.inputTokens` | `instance` | tokens |
| `agentweave_output_tokens_total` | counter | `totalUsage.outputTokens` | `instance` | tokens |
| `agentweave_cost_usd_total` | counter | `totalUsage.totalCost` | `instance` | USD |
| `agentweave_errors_total` | counter | `errorCount` | `instance` | errors |
| `agentweave_permission_denied_total` | counter | `permissionDeniedCount` | `instance` | decisions |
| `agentweave_tool_calls_total` | counter | `toolMetrics.get(t).callCount` | `instance`, `tool` | calls |
| `agentweave_tool_errors_total` | counter | `toolMetrics.get(t).errorCount` | `instance`, `tool` | errors |
| `agentweave_tool_duration_ms_avg` | gauge | `toolMetrics.get(t).avgDurationMs` | `instance`, `tool` | ms |

**Naming convention:** follows Prometheus best practice (`<namespace>_<subsystem>_<name>_<unit>` — unit suffix mandatory for non-dimensionless metrics, `_total` suffix for counters). Base namespace `agentweave_`.

**Cardinality budget:**
- `instance` — single value per process. Safe.
- `tool` — bounded to ~10 built-ins + a handful of custom. Safe.
- **`session_id` is OPT-IN** (`includeSessionLabel: true`). Default OFF because long-running processes accumulate sessions → cardinality explosion → Prometheus OOM.

**Counter semantics note:** `turnCount`, `errorCount`, etc. reset when `MonitorCollector.reset()` is called (session boundary). Prometheus clients handle monotonic-reset correctly via `rate()` / `increase()`. Exposed as `_total` to match convention.

---

## §3 Wiring

### 3.1 Binding model decision — sidecar HTTP server (pull), text-file as fallback

**Decision: HTTP pull** (the Prometheus native model), built on `node:http`. No express/fastify dep.

**Alternatives considered & rejected:**

| Alternative | Why rejected |
|---|---|
| Push Gateway / OpenTelemetry SDK | Adds a dep (`@opentelemetry/api` + exporter). Overkill for 10 series. Can add later as a parallel exporter without breaking this one. |
| Text-file pull mode (file-on-disk scraper) | Requires cron/timer to rewrite the file. Stale-data risk. Keep as a one-shot `agentweave monitor export --format prometheus > metrics.txt` for air-gapped CI — secondary use case, same exporter core. |
| fastify / express | External dep; a `/metrics` endpoint needs zero middleware. `node:http` is 20 lines. |

### 3.2 Pull vs push from MonitorCollector (ADR-002)

**Decision: pull on every scrape** — exporter calls `monitor.getSnapshot()` each HTTP request.

**Why:**
- Matches Prometheus's own pull model — no mismatch between "when scraped" and "what's in buffer".
- Snapshot is already cheap (object copy of in-memory counters, no I/O).
- Avoids adding a subscribe API to `MonitorCollector` (pull-only today — keeps the class small).
- No rate-limiter needed — if a client scrapes 100× in a second, exporter just re-renders the same snapshot 100×.

**Push (rejected):** would require `MonitorCollector.onEvent(...)` and an in-memory cache inside the exporter — doubles the state, doubles the invalidation logic.

### 3.3 AlertSink dispatch — fire-and-forget from `notify()`

```
InnerEvent ──▶ OuterHarness.onEvent()
                      │
                      ├──▶ MonitorCollector.collect()  (already today)
                      │          │
                      │          └──▶ (on scrape) PrometheusExporter.render()
                      │
                      ├──▶ AlertEngine.check(snapshot) (already today)
                      │          │
                      │          ├──▶ listeners (sync, in-process)   (already today)
                      │          │
                      │          └──▶ sinks[] (fire-and-forget async)  ◀── NEW
                      │                     │
                      │                     ├── StdoutSink
                      │                     ├── FileSink
                      │                     └── WebhookSink (→ http-retry)
                      │
                      └──▶ AuditLogger.logEvent()      (already today)
```

**Why fire-and-forget and not `await`:** A slow webhook must not stall the inner event loop. AlertEngine already isolates listener errors (l.67–71); we extend the same pattern to sinks with `.catch()` at dispatch.

**Amplification loop guard:** Sinks receive `AlertEvent` (outbound) and **must not** emit `InnerEvent` back. Enforced by design — `AlertSink.publish()` returns `Promise<void>`, no return channel. If a sink needs to re-audit its own delivery, it uses an external log, not the OuterHarness bus.

---

## §4 CLI shape

Two subcommands on a new `agentweave monitor` parent:

```
agentweave monitor serve [--port 9090] [--host 127.0.0.1]
    # Persistent sidecar. Runs until SIGINT. Exits 0 on clean shutdown.
    # Attaches to the current OuterHarness instance of the parent process
    # — OR — runs as a standalone process that reads a shared state path.

agentweave monitor export [--format prometheus | --format json]
    # One-shot. Renders the current snapshot to stdout and exits.
    # Use case: CI/air-gapped, or `curl`-less environments.
```

**Embed-in-pipeline variant** (ADR-004):

`pipeline run --monitor-port 9090` flag starts the server alongside the pipeline and shuts it down in `finally`. This is the **primary** use case — a long-running scrape target that lives exactly as long as the run. Standalone `monitor serve` is a secondary op-tool.

**Config surface** in `agentweave.yaml`:

```yaml
monitoring:
  prometheus:
    enabled: true
    port: 9090
    host: 127.0.0.1
    includeSessionLabel: false
  alertSinks:
    - type: stdout
    - type: file
      path: .agentweave/alerts.jsonl
    - type: webhook
      url: https://hooks.slack.com/services/XXX
      severityFilter: [warning, critical]
      maxRetries: 3
```

`createSdlcGovernance()` (built in P0.2) reads `config.monitoring` and wires sinks/exporter onto the `OuterHarness` before handing back the bundle.

---

## §5 Ordered file-by-file change list

| # | File | Size | Nature |
|---|---|---|---|
| 1 | `packages/outer-harness/src/shared/http-retry.ts` | NEW ~60 LOC | Extract `fetchWithRetry()` — pure util, no deps beyond `node:http` / WHATWG fetch |
| 2 | `packages/outer-harness/src/governance/hook-engine.ts` | MOD ~-25 LOC | Delete in-place backoff; call `fetchWithRetry()`. Behavior unchanged. |
| 3 | `packages/outer-harness/__tests__/shared/http-retry.test.ts` | NEW ~120 LOC | Retry on 5xx, give-up after N, timeout each attempt, no retry on 4xx |
| 4 | `packages/outer-harness/src/observability/alert-sink.ts` | NEW ~180 LOC | `AlertSink` interface + `StdoutSink` + `FileSink` + `WebhookSink` |
| 5 | `packages/outer-harness/src/observability/alert-engine.ts` | MOD ~+20 LOC | `addSink()` + `notify()` sink dispatch with `.catch()` |
| 6 | `packages/outer-harness/__tests__/alert-sink.test.ts` | NEW ~180 LOC | Each sink: happy path + failure isolation + retry (webhook only) |
| 7 | `packages/outer-harness/src/observability/prometheus-exporter.ts` | NEW ~150 LOC | Formatter — `render()` returns text; no I/O |
| 8 | `packages/outer-harness/__tests__/prometheus-exporter.test.ts` | NEW ~150 LOC | Format validation, label escaping, ≥5 series, cardinality guard |
| 9 | `packages/outer-harness/src/observability/prometheus-server.ts` | NEW ~80 LOC | `node:http` wrapper; `start()` / `stop()` / `address` |
| 10 | `packages/outer-harness/__tests__/prometheus-server.test.ts` | NEW ~100 LOC | Serve → scrape → parse; stop → port released; concurrent scrape |
| 11 | `packages/outer-harness/src/outer-harness.ts` | MOD ~+15 LOC | Read `config.monitoring`; instantiate exporter + sinks; wire via `addSink()` |
| 12 | `packages/outer-harness/src/index.ts` | MOD ~+5 LOC | Re-export `AlertSink`, `StdoutSink`, `FileSink`, `WebhookSink`, `PrometheusExporter`, `PrometheusServer` |
| 13 | `packages/cli/src/commands/monitor.ts` | NEW ~100 LOC | `serve` + `export` subcommands |
| 14 | `packages/cli/src/bin.ts` | MOD ~+10 LOC | Register `monitor` command + help text |
| 15 | `packages/cli/__tests__/monitor.test.ts` | NEW ~80 LOC | Subcommand dispatch; `export` one-shot returns stdout with valid format |

**Total: ≈ 1,250 LOC across 15 files.** Size classification: **M** (roadmap estimated 1–2 sessions — holds if tests are batch-written).

**Implementation order** (strict):

1. **Step A — http-retry extraction** (#1–3). Refactor-only, zero behavior change. Gate: hook-engine.ts 22 existing tests still green.
2. **Step B — AlertSink** (#4–6). Adds a new surface; no existing AlertEngine behavior changes (listeners + rules untouched). Gate: alert-engine.ts 10 existing tests still green.
3. **Step C — PrometheusExporter (formatter)** (#7–8). Pure function, easy to unit-test.
4. **Step D — PrometheusServer** (#9–10). HTTP wrapper; uses a dynamic port (`port: 0`) in tests to avoid conflicts.
5. **Step E — OuterHarness wiring** (#11–12). Read config, instantiate optional components. Gate: outer-harness.ts 250 existing tests still green.
6. **Step F — CLI** (#13–15). User-facing surface.

Each step commits independently. Total: 6 commits on the pivot branch (bringing post-P0.2 to 17 ahead of develop).

---

## §6 Test plan

### New tests (per ordered step)

**Step A — `http-retry.test.ts`**
- 200 → returns ok=true on first attempt, attempts=1.
- 503 twice then 200 → attempts=3, ok=true.
- 503 three times → ok=false, attempts=4 (initial + 3 retries).
- 404 → ok=false, attempts=1 (no retry on 4xx).
- Per-attempt timeout triggers AbortError → counted as one attempt.
- Custom `shouldRetry` predicate respected.

**Step B — `alert-sink.test.ts`**
- `StdoutSink.publish()` writes a JSON line to stdout (spied via `process.stdout.write`).
- `FileSink.publish()` appends JSONL; creates file if missing.
- `FileSink` rotation at `maxBytes` (rename to `.1`, start fresh).
- `WebhookSink.publish()` POSTs alert JSON; honors `severityFilter`.
- `WebhookSink` retries on 5xx with backoff; gives up after `maxRetries`.
- `WebhookSink.publish()` swallows errors (returns resolved promise even on give-up).
- `AlertEngine.addSink()` registers; `notify()` dispatches to all; one throwing sink doesn't block others (inject a sink whose `publish()` rejects; assert the other sink still got called).

**Step C — `prometheus-exporter.test.ts`**
- `render()` output starts with `# HELP` and `# TYPE` lines for each series.
- Metric names match regex `^[a-zA-Z_:][a-zA-Z0-9_:]*$`.
- Labels are quote-escaped (`tool="Bash\\n"` → valid).
- At least 5 series in output (from a representative snapshot).
- All 10 M1-M10-derived metrics present when snapshot has tool data.
- `includeSessionLabel: false` → no `session_id=` labels anywhere.
- `includeSessionLabel: true` → every metric carries `session_id=...`.
- Empty snapshot (no tools, no turns) → headers present, values = 0 (no missing series).

**Step D — `prometheus-server.test.ts`**
- `start()` resolves when listening; `address` returns bound port.
- `GET /metrics` → 200, `Content-Type: text/plain; version=0.0.4`, body starts with `# HELP`.
- `GET /other` → 404.
- 50 concurrent scrapes don't corrupt output (diff all 50 bodies; assert equal).
- `stop()` releases the port (second `start()` on the same port succeeds).
- Port `0` (OS-assigned) path covered in tests to avoid flakes.

**Step E — `outer-harness.test.ts` additions**
- `config.monitoring.prometheus.enabled: true` → exporter reachable via accessor.
- `config.monitoring.alertSinks` → sinks registered; `alerts.getSinks()` returns list.
- Backward compat: no `monitoring` config → no exporter, no sinks, zero baseline regression.

**Step F — `monitor.test.ts`**
- `monitor export --format prometheus` → stdout matches Prometheus text format.
- `monitor export --format json` → stdout is parseable JSON of `MonitorSnapshot`.
- `monitor serve --port 0` → prints bound port; exits cleanly on SIGINT (test via `process.emit("SIGINT")`).

### Integration test (required by DoD)

In `packages/cli/__tests__/pipeline-governance.test.ts` (existing file — add new describe block):

```ts
describe("pipeline run → prometheus scrape", () => {
  it("exposes ≥5 series after a completed pipeline run", async () => {
    const gov = createSdlcGovernance({
      sessionId: "s-prom",
      config: { monitoring: { prometheus: { enabled: true, port: 0 } } },
    });
    const pipeline = createSDLCPipeline({ /* ... SAFE_MODULES ... */ governance: gov.outer });
    pipeline.setExecutionProvider(createMockProvider());

    await drain(pipeline);

    const exporter = gov.outer.getPrometheusExporter();
    const text = exporter.render();
    const series = text.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(series.length).toBeGreaterThanOrEqual(5);
    expect(text).toMatch(/^# HELP /m);
    expect(text).toMatch(/^# TYPE /m);
  });
});
```

### Existing tests at risk

- `hook-engine.test.ts` (22) — Step A refactors internals. **Mitigation:** keep public API of `executeHttpHook()` unchanged; delegate to `fetchWithRetry()`. All 22 should pass unchanged.
- `alert-engine.test.ts` (10) — Step B adds `addSink()` / sink dispatch. **Mitigation:** `notify()` keeps existing listener loop first; sinks iterate after. Existing tests never register a sink → unaffected.
- `outer-harness.test.ts` (15+ described; 250 total package) — Step E adds config paths. **Mitigation:** all new config is optional; existing tests pass no `monitoring` block.
- `pipeline-governance.test.ts` (6) — integration test is additive; no existing test mutated.

**Regression budget:** 0 tests break. Abandon the change if any baseline turns red for non-trivial reasons.

**Test-count expectation post-P1.1:** 594 + ~95 new tests = **~689 total**.

---

## §7 Risks + mitigations

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | High-cardinality labels (session_id) blow up Prometheus memory | HIGH | `includeSessionLabel` defaults to **false**. Documented in doc + config schema. `instance` label is single-valued per process. `tool` label is bounded by tool registry (≤ 20 in practice). |
| 2 | HTTP port conflict on `serve` | MEDIUM | Config-driven port; clear error on `EADDRINUSE`. Tests use `port: 0`. Default host is `127.0.0.1` (not `0.0.0.0`) — requires explicit opt-in to expose externally. |
| 3 | Memory growth for long-running exporter | LOW | Exporter is stateless — holds only refs to `MonitorCollector` + `AlertEngine` (already in `OuterHarness`). No accumulator. HTTP server closes connections per-request. |
| 4 | Alerting amplification loop (sink event → sink event) | LOW | Enforced by type signature: `AlertSink.publish(): Promise<void>`. No return channel. Documented as a constraint in the interface JSDoc. |
| 5 | Slow webhook stalls alert fan-out | MEDIUM | Fire-and-forget dispatch (`sink.publish().catch(...)`). Per-attempt `timeoutMs` (default 5s). `maxRetries` default 3 → worst-case 3 × (5s + backoff) before giving up, but the main event loop sees no delay. |
| 6 | Refactoring hook-engine retry breaks 22 existing tests | MEDIUM | Step A is refactor-only, gated by the existing test suite. If a test breaks, roll back the extraction and duplicate the backoff in WebhookSink instead. Cost: +40 LOC; correctness preserved. |
| 7 | Prometheus text format bugs (missing `\n`, bad label escape) | MEDIUM | Table-driven unit tests with representative snapshots. Reference against `prom-client`'s output via fuzzed comparison if flakes appear (no dep — just test-only). |
| 8 | Exporter exposed externally leaks session counts / tool names | LOW | Default bind is `127.0.0.1`. Explicit `--host 0.0.0.0` required to expose. Doc warns against exposing without reverse-proxy auth. No secrets in metric values (tool names are public API). |
| 9 | `node:http` doesn't support HTTP/2 — some scrapers prefer it | LOW | Prometheus scrape model uses HTTP/1.1 by default. No production scraper requires HTTP/2 for `/metrics`. Revisit only if a user requests it. |

---

## §8 ADRs

### ADR-001 — Pull-based MonitorCollector reads (vs push subscription)

**Context:** Prometheus scrapes; need to turn in-memory state into text format on demand. Two options: (a) exporter subscribes to collector, caches in its own state; (b) exporter calls `getSnapshot()` on each scrape.

**Decision:** (b) pull on scrape.

**Consequences:** One extra snapshot-copy per scrape — O(tools + turns) ≈ cheap. No duplicated state. No cache-invalidation bugs.

**Alternatives considered:** Push model fits OpenTelemetry better but adds state + invalidation. Rejected for scope.

### ADR-002 — `node:http` over express/fastify

**Context:** Need a `/metrics` endpoint.

**Decision:** `node:http`. Server is ~20 lines. Single route. No middleware needed.

**Consequences:** Zero new runtime deps. Manual routing (`req.url === "/metrics"` branch). If we add health/ready endpoints later, we'll stay under 50 lines.

**Alternatives considered:** fastify (2MB+ tree, overkill); express (legacy, maintenance risk). Rejected.

### ADR-003 — Extract `http-retry.ts` as shared util

**Context:** `WebhookSink` needs exponential backoff. `HookEngine.executeHttpHook()` already has it.

**Decision:** Extract `fetchWithRetry()` into `shared/http-retry.ts`. Hook-engine and WebhookSink both consume it.

**Consequences:** One place for HTTP retry policy. Test once, reuse twice.

**Alternatives considered:** Duplicate the backoff (40 LOC × 2). Rejected — drift risk.

### ADR-004 — Embed prometheus server in `pipeline run` vs standalone sidecar

**Context:** Two deployment models — (a) Prometheus scrapes a long-running daemon, (b) scrapes a single pipeline run.

**Decision:** Support both. `pipeline run --monitor-port N` is primary (matches ephemeral CI runs). `monitor serve` is the secondary op-tool (multi-session fleets). Same exporter core underneath.

**Consequences:** Two CLI entry points sharing the same `PrometheusServer`. No duplication.

---

## §9 Appendix — ASCII architecture

```
┌────────────────────── OuterHarness (one per process) ─────────────────────┐
│                                                                           │
│   InnerEvent ──▶ onEvent()                                                │
│                      │                                                    │
│   ┌──────────────────┼──────────────────────────┬─────────────────────┐   │
│   ▼                  ▼                          ▼                     ▼   │
│ AuditLogger   MonitorCollector          BudgetManager         SessionMgr  │
│                    │                                                      │
│                    │  getSnapshot()                                       │
│                    ▼                                                      │
│            ┌─────────────────┐                                            │
│            │ PrometheusExp.  │ ◀── scraped on demand                      │
│            └────────┬────────┘                                            │
│                     │ render()                                            │
│                     ▼                                                     │
│            ┌─────────────────┐                                            │
│            │PrometheusServer │  ──HTTP──▶  Prometheus scraper             │
│            │  (node:http)    │           (Grafana, Alertmanager, etc.)    │
│            └─────────────────┘                                            │
│                                                                           │
│                    ▲                                                      │
│                    │ check(snapshot)                                      │
│            ┌─────────────────┐    onAlert() ──▶ [listener fn]             │
│            │   AlertEngine   │                                            │
│            └────────┬────────┘    notify() ──▶ sinks[]                    │
│                     │                           │                         │
│                     │                           ├──▶ StdoutSink           │
│                     │                           ├──▶ FileSink (JSONL)     │
│                     │                           └──▶ WebhookSink          │
│                     │                                     │               │
│                     │                                     ▼               │
│                     │                          http-retry.ts (shared)     │
│                     │                                     │               │
│                     │                                     ▼               │
│                     │                          HookEngine.executeHttp     │
│                     │                          ── (same util) ──          │
└─────────────────────┴─────────────────────────────────────────────────────┘

Dep-graph (unchanged):
  @agentweave/types       ◀── @agentweave/outer-harness (all new files land here)
                          ◀── @agentweave/cli (consumes via getPrometheusExporter())
  @agentweave/inner-harness — untouched. No new imports.
```

---

## §10 Decision summary (for the reviewer)

- **Interface:** `AlertSink` (3 impls) + `PrometheusExporter` + `PrometheusServer` — all in `@agentweave/outer-harness`.
- **Wiring:** Exporter pulls from `MonitorCollector.getSnapshot()` on each scrape. Sinks consume `AlertEngine.notify()` fan-out (fire-and-forget).
- **HTTP retry:** Extracted into `shared/http-retry.ts`. Reused by `HookEngine` + `WebhookSink`.
- **Binding:** `node:http` (no new runtime dep). Default bind `127.0.0.1`.
- **CLI:** `agentweave monitor serve` + `agentweave monitor export`. `pipeline run --monitor-port N` is the primary path.
- **Backward compat:** all new features opt-in via `config.monitoring`. Default off → zero behavior change.
- **Size:** ~1,250 LOC across 15 files. M-sized (1–2 sessions).
- **Regression budget:** 0 baseline test breaks. Expected post-P1.1 test count: ~689.

Ready for `/po` priority confirmation + `/implement` review. Pick nits first; once approved, implementation follows the 6-step commit plan in §5.

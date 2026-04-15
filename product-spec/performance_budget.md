# AgentWeave — Performance Budget

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia performance targets cho moi component

---

## 1. Latency Targets

### 1.1 Per-Component (p50 / p99)

```
Component                          p50        p99        Max        Notes
---------------------------------  ---------  ---------  ---------  ------------------
EventBus.emit (no handlers)        <0.01ms    <0.05ms    0.1ms      Fire-and-forget
EventBus.emit (10 handlers)        <0.1ms     <0.5ms     1ms        Non-blocking
EventBus.emit (100 handlers)       <1ms       <5ms       10ms       Scaling limit

InterceptorRegistry (passthrough)  <0.5ms     <1ms       2ms        No handler registered
InterceptorRegistry (with handler) <2ms       <10ms      30ms       Handler-dependent

PermissionEngine.evaluate
  10 rules                         <1ms       <3ms       5ms
  50 rules                         <3ms       <8ms       15ms
  100 rules                        <5ms       <15ms      30ms

HookEngine.execute
  Command hook (echo)              <50ms      <100ms     200ms      Process spawn
  Prompt hook (haiku)              <500ms     <2000ms    5000ms     LLM call
  Agent hook                       <2000ms    <10000ms   30000ms    Full agent
  HTTP hook (local)                <10ms      <50ms      200ms      Network
  Function hook (inline)           <0.1ms     <1ms       5ms        In-process

OutputPipeline (Streaming mode)
  Per-buffer filter (regex)        <1ms       <3ms       5ms        50-token buffer
  Per-buffer filter (PII)          <2ms       <5ms       10ms       Regex-based
  Post-stream validate             <50ms      <200ms     1000ms     Runs after stream

OutputPipeline (Batch mode)
  Stage 1: Intercept               <1ms       <2ms       5ms
  Stage 2: Validate (basic)        <10ms      <50ms      100ms
  Stage 2: Validate (safety LLM)   <500ms     <2000ms    5000ms     LLM call
  Stage 3: Filter (all)            <5ms       <20ms      50ms
  Stage 4: Transform (template)    <1ms       <5ms       10ms
  Stage 4: Transform (formatter)   <100ms     <500ms     2000ms     External tool
  Stage 5: Review (auto-approve)   <1ms       <5ms       10ms
  Stage 6: Deliver                 <1ms       <5ms       10ms

InputGate.process                  <2ms       <5ms       10ms
BudgetManager.canProceed           <0.1ms     <0.5ms     1ms
ConfigHierarchy.merge              <3ms       <10ms      20ms       7 levels
AuditLogger.log                    <1ms       <5ms       10ms       Async write
SessionManager.persist             <10ms      <50ms      100ms      Disk write
```

### 1.2 End-to-End Overhead (per turn)

```
Scenario                                   Overhead Target    Notes
-----------------------------------------  ----------------   -----
Passthrough (Outer disabled)               <1ms               Inner only
Streaming + basic filter (default)         <5ms/buffer        Permission + filter
Streaming + all filters                    <10ms/buffer       Permission + PII + secret + denylist
Batch + full pipeline (no LLM hooks)       <100ms             All 6 stages
Batch + LLM validation                     <3000ms            Includes LLM call for safety check
With AWOCP (remote interceptor)            +10-50ms           Network round trip to Gateway
```

---

## 2. Throughput Targets

```
Metric                             Target           Notes
---------------------------------  ---------------  ------------------
Events/second (EventBus)           10,000+          In-process
Intercepts/second (local)          1,000+           In-process
Intercepts/second (AWOCP remote)   100+             Network-bound
Concurrent agent sessions          50+              Per Gateway Node
AWOCP connections per Gateway      200+             WebSocket
Config hot-reload                  <100ms           File watch + merge
```

---

## 3. Memory Budget

```
Component                   Baseline    Per-Session    Notes
--------------------------  ----------  -------------  ------------------
AgentWeave SDK (idle)       ~20MB       -              Node.js baseline
Inner Harness               ~5MB        +2-10MB        Depends on messages
Outer Harness               ~10MB       +1-5MB         Rules, hooks, config
Control Plane               ~2MB        +0.5MB         Event handlers
Session transcript          -           +0.1-5MB       Depends on length
Audit log buffer            ~1MB        +0.1MB/turn    Flushed to disk periodically
EventBus (100 handlers)     ~0.5MB      -

Total (1 session, typical)  ~40MB       ~10MB
Total (5 concurrent)        ~40MB       ~50MB
```

---

## 4. Startup Time

```
Phase                              Target     Notes
---------------------------------  ---------  ------------------
CLI parse + init                   <100ms
Load config (7 levels)             <50ms      File reads + merge
Load plugins                       <200ms     Depends on count
Initialize Inner Harness           <50ms      Tool registry
Initialize Outer Harness           <100ms     Permission engine, hooks
Initialize Control Plane           <10ms      Event bus, interceptors
AWOCP connect (if Team mode)       <500ms     WebSocket + auth
Total cold start                   <500ms     Solo mode
Total cold start (Team mode)       <1000ms    With Gateway connect
```

---

## 5. Disk & Network

```
Metric                             Target           Notes
---------------------------------  ---------------  ------------------
npm package size (@agentweave/cli) <10MB            Bundled
Transcript per session             <1MB typical     JSONL, compressed
Audit log per session              <100KB           Structured, compact
AWOCP message size                 <10KB typical    JSON encoded
AWOCP bandwidth per session        <1MB/hour        Events + intercepts
Config file size                   <50KB            YAML
```

---

## 6. Benchmarking Practice

### 6.1 Khi nao benchmark

- Moi PR thay doi performance-critical code (EventBus, Interceptor, PermissionEngine, OutputPipeline)
- Weekly nightly CI benchmark (tracking trends)
- Truoc moi release

### 6.2 Regression Detection

```yaml
# CI: fail neu performance giam >20% so voi baseline
benchmark:
  regressionThreshold: 0.20        # 20% slower = fail
  baselineBranch: "main"
  compareMetrics:
    - "permission_evaluate_p99"
    - "output_filter_p99"
    - "turn_overhead_p99"
    - "startup_time"
```

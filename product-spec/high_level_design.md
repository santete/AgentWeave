# AgentWeave — High-Level Design & Network Topology

> Version: 0.1 Draft
> Date: 2026-04-15

---

## Muc luc

1.  [HLD Overview](#1-hld-overview)
2.  [Component Placement Matrix](#2-component-placement-matrix)
3.  [Topology 1: Solo Developer (Local)](#3-topology-1-solo-developer)
4.  [Topology 2: Team (Hybrid)](#4-topology-2-team)
5.  [Topology 3: Enterprise (Full Cloud)](#5-topology-3-enterprise)
6.  [Topology 4: CI/CD Pipeline](#6-topology-4-cicd-pipeline)
7.  [Topology 5: Multi-Agent Fleet](#7-topology-5-multi-agent-fleet)
8.  [Gateway Design](#8-gateway-design)
9.  [Traffic Flow & Protocols](#9-traffic-flow--protocols)
10. [Data Residency & Storage Topology](#10-data-residency--storage-topology)
11. [Scaling Patterns](#11-scaling-patterns)
12. [Infrastructure Requirements](#12-infrastructure-requirements)
13. [Security Zones & Network Policies](#13-security-zones--network-policies)
14. [Failure Domains & HA](#14-failure-domains--ha)
15. [Migration Path: Local -> Team -> Enterprise](#15-migration-path)

---

## 1. HLD Overview

### 1.1 Component Recap (tu Architecture doc)

```
INNER HARNESS (Execution Engine)
  - AgentLoop, LLMCaller, ToolExecutor, ContextManager, TokenCounter

CONTROL PLANE (Bridge)
  - EventBus, CommandBus, InterceptorRegistry, StateProxy

OUTER HARNESS (Governance)
  - PermissionEngine, HookEngine, OutputPipeline, InputGate
  - BudgetManager, ToolGovernor
  - MonitorCollector, AlertEngine, AuditLogger
  - SessionManager, ConfigHierarchy, MultiAgentOrchestrator

INTERFACE LAYER
  - AWOCP Server (WebSocket/gRPC)
  - REST API
  - SDK

PRESENTATION
  - CLI Dashboard
  - Web Dashboard
  - IDE Extension
```

### 1.2 Node Types

Trong moi topology, cac components duoc dat tren cac **node types** sau:

```
+--[ DEV NODE ]---------------------------------------------------+
|  May tinh cua developer (laptop/desktop/remote devbox)           |
|  OS: macOS / Linux / Windows                                     |
|  Chay: IDE, terminal, agent CLI                                  |
+------------------------------------------------------------------+

+--[ GATEWAY NODE ]------------------------------------------------+
|  Server/service lam trung gian giua dev nodes va external APIs   |
|  Chay: AWOCP server, API gateway, auth proxy                    |
+------------------------------------------------------------------+

+--[ GOVERNANCE NODE ]---------------------------------------------+
|  Server chuyen trach governance (permission, hooks, output ctrl) |
|  Chay: Outer Harness services                                    |
+------------------------------------------------------------------+

+--[ OBSERVABILITY NODE ]------------------------------------------+
|  Server chuyen trach monitoring va storage                       |
|  Chay: metrics, traces, logs, dashboard                          |
+------------------------------------------------------------------+

+--[ CONFIG NODE ]-------------------------------------------------+
|  Server/service luu tru va phan phoi config                      |
|  Chay: config store, policy engine                               |
+------------------------------------------------------------------+

+--[ LLM API NODE ]------------------------------------------------+
|  External: Anthropic API, AWS Bedrock, Google Vertex, OpenAI     |
|  KHONG do ta quan ly — third-party service                       |
+------------------------------------------------------------------+

+--[ CI/CD NODE ]--------------------------------------------------+
|  GitHub Actions runner, GitLab runner, Jenkins agent              |
+------------------------------------------------------------------+
```

---

## 2. Component Placement Matrix

### O dau dat component nao, tuy topology:

```
                        Solo Dev    Team        Enterprise   CI/CD
                        (Local)     (Hybrid)    (Full Cloud) (Pipeline)
                        ----------  ----------  -----------  ----------
INNER HARNESS
  AgentLoop             DEV         DEV         DEV          CI/CD
  LLMCaller             DEV         DEV         DEV          CI/CD
  ToolExecutor          DEV         DEV         DEV          CI/CD
  Built-in Tools        DEV         DEV         DEV          CI/CD

CONTROL PLANE
  EventBus              DEV         DEV         DEV          CI/CD
  CommandBus            DEV         DEV         DEV          CI/CD
  Interceptors          DEV         DEV+GW      GW           CI/CD+GW

OUTER HARNESS - Governance
  PermissionEngine      DEV         DEV+GW      GOVERN       GW
  HookEngine            DEV         DEV         DEV+GOVERN   CI/CD
  OutputPipeline        DEV         DEV+GW      GW           GW
  InputGate             DEV         DEV         GW           GW
  BudgetManager         DEV         GW          GOVERN       GW
  ToolGovernor          DEV         DEV         DEV+GOVERN   CI/CD

OUTER HARNESS - Observability
  MonitorCollector      DEV         DEV+OBS     OBS          OBS
  AlertEngine           DEV         OBS         OBS          OBS
  AuditLogger           DEV         OBS         OBS          OBS
  TraceManager          DEV         OBS         OBS          OBS

OUTER HARNESS - Orchestration
  SessionManager        DEV         DEV+OBS     OBS          CI/CD
  ConfigHierarchy       DEV         DEV+CFG     CFG          CFG
  MultiAgentOrch.       DEV         DEV         GOVERN       CI/CD

INTERFACE
  AWOCP Server          -           GW          GW           GW
  REST API              -           GW          GW           GW
  SDK                   DEV         DEV         DEV          CI/CD

PRESENTATION
  CLI Dashboard         DEV         DEV         DEV          -
  Web Dashboard         -           OBS         OBS          OBS
  IDE Extension         DEV         DEV         DEV          -

Legend:
  DEV     = Dev Node (developer machine)
  GW      = Gateway Node
  GOVERN  = Governance Node
  OBS     = Observability Node
  CFG     = Config Node
  CI/CD   = CI/CD Runner Node
  DEV+GW  = Split: mot phan o DEV, mot phan o GW
  -       = Khong su dung trong topology nay
```

---

## 3. Topology 1: Solo Developer

### 3.1 Khi nao dung

- 1 developer, 1 may, lam viec doc lap
- Khong can centralized governance
- Khong can web dashboard
- Chi can CLI + local config

### 3.2 Network Diagram

```
+===================================================================+
|                         DEV NODE                                   |
|                    (Developer Laptop)                               |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |  Terminal / IDE                                               |  |
|  |                                                               |  |
|  |  $ agentweave run "Fix the login bug"                         |  |
|  +------+-------------------------------------------------------+  |
|         |                                                          |
|         v                                                          |
|  +------+-------------------------------------------------------+  |
|  |  @agentweave/cli                                              |  |
|  +------+-------------------------------------------------------+  |
|         |                                                          |
|         v                                                          |
|  +------+-------------------------------------------------------+  |
|  |  @agentweave/sdk  (createHarness)                             |  |
|  |                                                               |  |
|  |  +-----------------+  +----------------+  +-----------------+ |  |
|  |  | INNER HARNESS   |  | CONTROL PLANE  |  | OUTER HARNESS   | |  |
|  |  |                 |  |                |  |                 | |  |
|  |  | AgentLoop       |  | EventBus       |  | PermissionEng   | |  |
|  |  | LLMCaller  -----+--+--> intercept --+--+-> OutputPipeline| |  |
|  |  | ToolExecutor    |  | CommandBus     |  | HookEngine      | |  |
|  |  | ContextManager  |  | StateProxy     |  | BudgetManager   | |  |
|  |  | TokenCounter    |  |                |  | MonitorCollector| |  |
|  |  |                 |  |                |  | AuditLogger     | |  |
|  |  +---------+-------+  +----------------+  | SessionManager  | |  |
|  |            |                               | ConfigHierarchy| |  |
|  |            |                               +---------+-------+ |  |
|  |            |                                         |         |  |
|  +------------+-----------------------------------------+---------+  |
|               |                                         |            |
|               v                                         v            |
|  +------------+------------+           +----------------+----------+ |
|  | File System             |           | Local Storage              | |
|  |                         |           |                            | |
|  | src/  (project files)   |           | ~/.agentweave/             | |
|  | .agentweave/config.yaml |           |   sessions/                | |
|  |                         |           |   audit.jsonl              | |
|  +-------------------------+           |   metrics/                 | |
|                                        +----------------------------+ |
+===================================================================+
         |
         | HTTPS (outbound only)
         v
+-------------------+
| LLM API NODE      |
| (Anthropic API)   |
| api.anthropic.com |
+-------------------+
```

### 3.3 Traffic Flow

```
1. User input --> CLI --> SDK --> [Control Plane: input_received intercept]
2. [Outer: InputGate] --> decision: pass
3. [Inner: AgentLoop] --> HTTPS --> Anthropic API --> streaming response
4. [Inner: parse tool_use] --> [Control Plane: tool_request intercept]
5. [Outer: PermissionEngine] --> decision: allow/deny
6. [Inner: ToolExecutor] --> local file system / local shell
7. [Inner: loop continues...]
8. [Inner: terminal] --> [Control Plane: output_ready intercept]
9. [Outer: OutputPipeline] --> 6 stages --> decision: approve
10. CLI --> terminal output --> User

Network:
  - Outbound HTTPS only (to LLM API)
  - Zero inbound connections
  - Zero inter-node traffic (everything in-process)
```

### 3.4 Config files location

```
~/.agentweave/
├── config.yaml              # User-level config
├── sessions/                # Transcripts
├── audit.jsonl              # Audit log
└── metrics/                 # Local metrics

<project>/
├── .agentweave/
│   ├── config.yaml          # Project-level config
│   └── config.local.yaml    # Machine-local (gitignored)
```

---

## 4. Topology 2: Team

### 4.1 Khi nao dung

- Team 5-50 developers
- Can shared governance rules (team lead quan ly)
- Can centralized monitoring (ai dung bao nhieu, lam gi)
- Can web dashboard
- Can shared config (khong phai moi nguoi tu cau hinh)

### 4.2 Network Diagram

```
                    +================================+
                    |       CORPORATE NETWORK         |
                    |                                 |
  +-------------+  |  +---------------------------+  |  +------------------+
  | DEV NODE 1  |  |  | GATEWAY NODE              |  |  | OBSERVABILITY    |
  | (Dev A)     |  |  | (Docker / K8s pod)        |  |  | NODE             |
  |             |  |  |                           |  |  | (Docker / K8s)   |
  | +---------+ |  |  | +-----+ +--------------+ |  |  |                  |
  | |Inner    | |  |  | |AWOCP| |Outer Harness | |  |  | +-------------+  |
  | |Harness  +-+--+--+>|Gate- | |(Governance)  | |  |  | |Web          |  |
  | |+Control | |  |  | |way   | |              | |  |  | |Dashboard    |  |
  | |Plane    | |  |  | |Server| |Permission    | |  |  | |(:3000)      |  |
  | +---------+ |  |  | |(WS)  | |Engine(shared)| |  |  | +-------------+  |
  | |SDK+CLI  | |  |  | |(:9100| |              | |  |  |                  |
  | +---------+ |  |  | |)     | |OutputPipeline| |  |  | +-------------+  |
  +------+------+  |  | +--+--+ |(shared rules) | |  |  | |Metrics      |  |
         |         |  | |  |    |              | |  |  | |Store        |  |
  +------+------+  |  | |  |    |BudgetManager | |  |  | |(Prometheus) |  |
  | DEV NODE 2  |  |  | |  |    |(team quotas) | |  |  | |(:9090)      |  |
  | (Dev B)     |  |  | |  |    +---------+----+ |  |  | +-------------+  |
  |             |  |  | |  |              |       |  |  |                  |
  | +---------+ |  |  | |  |    +---------v----+  |  |  | +-------------+  |
  | |Inner    +-+--+--+>|  |    |Config Store  |  |  |  | |Log Store    |  |
  | |Harness  | |  |  | |  |    |(shared YAML  |  |  |  | |(Loki /      |  |
  | |+Control | |  |  | |  |    | + policies)  |  |  |  | | Elastic)    |  |
  | |Plane    | |  |  | |  |    +--------------+  |  |  | +-------------+  |
  | +---------+ |  |  | |  |                      |  |  |                  |
  | |SDK+CLI  | |  |  | +--+------+               |  |  | +-------------+  |
  | +---------+ |  |  |    |      |               |  |  | |Trace Store  |  |
  +------+------+  |  |    |REST  |               |  |  | |(Jaeger /    |  |
         |         |  |    |API   |               |  |  | | Tempo)      |  |
  +------+------+  |  |    |(:8080               |  |  | +-------------+  |
  | DEV NODE N  |  |  |    |)     |               |  |  |                  |
  | (Dev C..Z)  |  |  |    |      |               |  |  | +-------------+  |
  |             |  |  | +--v------v--+            |  |  | |Alert        |  |
  | +---------+ |  |  | |API Gateway |            |  |  | |Manager      |  |
  | |Inner    +-+--+--+>|(nginx/     |            |  |  | |(Alertmanager|  |
  | |Harness  | |  |  | | traefik)   |            |  |  | | + Slack)    |  |
  | +---------+ |  |  | |(:443)      |            |  |  | +-------------+  |
  +-------------+  |  | +------+-----+            |  |  +------------------+
                   |  |        |                   |  |
                   |  +--------+-------------------+  |
                   |           |                      |
                   +===========|======================+
                               |
                               | HTTPS
                               v
                    +----------+---------+
                    | LLM API NODE       |
                    | (Anthropic API)    |
                    +--------------------+
```

### 4.3 Node Responsibilities

```
DEV NODE (moi developer):
  [Inner Harness]     -- Agent loop + tools chay LOCAL tren may dev
  [Control Plane]     -- In-process + remote interceptors (WS to Gateway)
  [SDK + CLI]         -- User interface
  [Local Outer]       -- HookEngine (local hooks), ToolGovernor (local sandbox)
  [Local Config]      -- .agentweave/config.yaml (project), overrides

GATEWAY NODE (shared, 1 per team):
  [AWOCP Server]      -- WebSocket endpoint cho dev nodes connect
  [Permission Engine]  -- SHARED rules (team lead quan ly)
  [Output Pipeline]    -- SHARED filters (PII, secrets — team policy)
  [Budget Manager]     -- SHARED quotas (per-user, per-day, per-team)
  [Config Store]       -- SHARED config (policy rules, hook templates)
  [API Gateway]        -- Auth, rate limit, routing
  [REST API]           -- CRUD for rules, hooks, budgets

OBSERVABILITY NODE (shared, 1 per team):
  [Web Dashboard]      -- Grafana / custom dashboard
  [Metrics Store]      -- Prometheus / VictoriaMetrics
  [Log Store]          -- Loki / Elasticsearch
  [Trace Store]        -- Jaeger / Tempo
  [Alert Manager]      -- Alertmanager + Slack/PagerDuty integration
  [Session Store]      -- Transcript archive (S3 / local disk)
```

### 4.4 Traffic Flow (Dev A goi tool bi deny boi team policy)

```
DEV NODE A                          GATEWAY NODE                 OBSERVABILITY
                                                                 NODE
[User] "delete all logs"
  |
  v
[Inner: AgentLoop]
  |-- LLM call --> Anthropic API --> tool_use: Bash("rm -rf logs/")
  |
  v
[Control Plane: intercept('tool_request')]
  |
  |-- LOCAL check: .agentweave/config.yaml --> no match
  |
  |-- REMOTE check (WS) --------> [AWOCP Server]
  |                                     |
  |                                     v
  |                                [Permission Engine]
  |                                  rule: DENY "Bash(rm -rf *)"
  |                                  source: team_policy
  |                                     |
  |                                     v
  |   <--- ToolDecision: DENY ----[AWOCP Server]
  |
  v
[Inner: return error to LLM]       [AWOCP Server]
                                     |-- event --> [Metrics: tool_denied++]
                                     |-- event --> [Audit: log entry]
                                     |-- event --> [Alert: check conditions]
                                                         |
                                                         v
                                                   [Slack: "#agent-alerts"
                                                    "Dev A denied: rm -rf"]
```

### 4.5 Hybrid Interceptor Pattern

```
Dev Node co ca LOCAL va REMOTE interceptors.
Evaluation order: LOCAL first, REMOTE second.

[Inner: tool_request]
  |
  v
[Control Plane: intercept]
  |
  +--> [LOCAL interceptor]
  |      Check .agentweave/config.yaml (project rules)
  |      Check .agentweave/config.local.yaml (personal rules)
  |      If MATCH (allow or deny) --> return immediately
  |      If NO MATCH --> forward to remote
  |
  +--> [REMOTE interceptor] (WS to Gateway)
         Check team policy rules
         Check org policy rules
         If MATCH --> return
         If NO MATCH --> default decision (fail-closed: deny)

Tai sao LOCAL first?
  - Latency: local check < 1ms, remote check ~ 10-50ms
  - Offline: dev van lam viec duoc khi Gateway down
  - Privacy: khong gui tool input len server neu local da quyet dinh
```

---

## 5. Topology 3: Enterprise

### 5.1 Khi nao dung

- 100+ developers, nhieu team
- Compliance requirements (SOC2, HIPAA, GDPR)
- Centralized governance bat buoc
- Immutable policy rules (dev KHONG the override)
- Full audit trail

### 5.2 Network Diagram

```
+=======================================================================+
|                        ENTERPRISE NETWORK                              |
|                                                                        |
|  +---- VPC / Private Subnet: Agent Control Plane ------------------+  |
|  |                                                                  |  |
|  |  +------------------+     +------------------+                   |  |
|  |  | API GATEWAY      |     | CONFIG NODE      |                   |  |
|  |  | (Kong / Envoy)   |     | (etcd / Consul)  |                   |  |
|  |  |                  |     |                  |                   |  |
|  |  | - mTLS terminate |     | - Policy store   |                   |  |
|  |  | - JWT validate   |     | - Rule versions  |                   |  |
|  |  | - Rate limit     |     | - Config history |                   |  |
|  |  | - RBAC enforce   |     | - Push to nodes  |                   |  |
|  |  | - Request log    |     |                  |                   |  |
|  |  +--------+---------+     +--------+---------+                   |  |
|  |           |                        |                             |  |
|  |           v                        v                             |  |
|  |  +--------+------------------------+--------+                    |  |
|  |  |         GOVERNANCE NODE CLUSTER          |                    |  |
|  |  |         (K8s Deployment, 3+ replicas)    |                    |  |
|  |  |                                          |                    |  |
|  |  |  +----------------+  +----------------+  |                    |  |
|  |  |  | Permission     |  | Output         |  |                    |  |
|  |  |  | Engine         |  | Pipeline       |  |                    |  |
|  |  |  |                |  |                |  |                    |  |
|  |  |  | - Org policies |  | - Compliance   |  |                    |  |
|  |  |  | - Team rules   |  |   filters      |  |                    |  |
|  |  |  | - ML classifier|  | - PII/secret   |  |                    |  |
|  |  |  | - Audit every  |  |   redaction    |  |                    |  |
|  |  |  |   decision     |  | - Output schema|  |                    |  |
|  |  |  +----------------+  +----------------+  |                    |  |
|  |  |                                          |                    |  |
|  |  |  +----------------+  +----------------+  |                    |  |
|  |  |  | Budget         |  | Hook           |  |                    |  |
|  |  |  | Manager        |  | Engine         |  |                    |  |
|  |  |  |                |  |                |  |                    |  |
|  |  |  | - Org quotas   |  | - Org hooks    |  |                    |  |
|  |  |  | - Team quotas  |  | - Compliance   |  |                    |  |
|  |  |  | - Per-user     |  |   checks       |  |                    |  |
|  |  |  | - Billing      |  | - Auto-test    |  |                    |  |
|  |  |  +----------------+  +----------------+  |                    |  |
|  |  |                                          |                    |  |
|  |  |  +----------------+                      |                    |  |
|  |  |  | AWOCP Server   |                      |                    |  |
|  |  |  | (WS + gRPC)    |                      |                    |  |
|  |  |  | (:9100, :9101) |                      |                    |  |
|  |  |  +----------------+                      |                    |  |
|  |  +------------------------------------------+                    |  |
|  |                                                                  |  |
|  +------------------------------------------------------------------+  |
|                                                                        |
|  +---- VPC / Private Subnet: Observability -------------------------+  |
|  |                                                                  |  |
|  |  +--------------+  +--------------+  +--------------+            |  |
|  |  | Prometheus   |  | Loki         |  | Tempo        |            |  |
|  |  | (metrics)    |  | (logs)       |  | (traces)     |            |  |
|  |  +--------------+  +--------------+  +--------------+            |  |
|  |                                                                  |  |
|  |  +--------------+  +--------------+  +--------------+            |  |
|  |  | Grafana      |  | Alertmanager |  | Audit DB     |            |  |
|  |  | (dashboard)  |  | (alerts)     |  | (PostgreSQL) |            |  |
|  |  | (:3000)      |  |              |  | (immutable   |            |  |
|  |  +--------------+  +--------------+  |  append-only)|            |  |
|  |                                      +--------------+            |  |
|  |  +--------------+                                                |  |
|  |  | Session Store|                                                |  |
|  |  | (S3 / MinIO) |                                                |  |
|  |  +--------------+                                                |  |
|  |                                                                  |  |
|  +------------------------------------------------------------------+  |
|                                                                        |
+========================================================================+
     |              |              |              |
     | mTLS         | mTLS         | mTLS         | mTLS
     v              v              v              v
+--------+    +--------+    +--------+    +-----------+
|DEV NODE|    |DEV NODE|    |DEV NODE|    |CI/CD NODE |
| (Dev A)|    | (Dev B)|    | (Dev N)|    | (Runner)  |
|        |    |        |    |        |    |           |
|+------+|    |+------+|    |+------+|    |+------+   |
||Inner ||    ||Inner ||    ||Inner ||    ||Inner ||   |
||Harnes||    ||Harnes||    ||Harnes||    ||Harnes||   |
||+CP   ||    ||+CP   ||    ||+CP   ||    ||+CP   ||   |
|+--+---+|    |+--+---+|    |+--+---+|    |+--+---+|  |
|   |WS  |    |   |WS  |    |   |WS  |    |   |gRPC|  |
+---+----+    +---+----+    +---+----+    +---+-----+
    |              |              |              |
    +--------------+--------------+--------------+
                         |
                    mTLS | (to API Gateway)
                         v
               +-------------------+
               | API GATEWAY       |
               +-------------------+
                         |
                         | HTTPS
                         v
               +-------------------+
               | LLM API           |
               | (Anthropic /      |
               |  Bedrock /        |
               |  Vertex)          |
               +-------------------+
```

### 5.3 Enterprise-Specific Patterns

```
PATTERN: Immutable Policy
  Config Node giu policy rules voi versioning.
  Dev KHONG the override policy rules (priority cao nhat).
  Thay doi policy can approval workflow (Git PR + review).

PATTERN: LLM Proxy
  API Gateway cung lam LLM proxy:
  - Dev nodes KHONG goi Anthropic truc tiep
  - API Gateway inject org API key
  - Track usage per-user tai gateway
  - Rate limit per-user tai gateway
  - Log moi LLM request/response

PATTERN: Audit Chain
  Moi decision duoc log vao Audit DB (PostgreSQL, append-only).
  Schema: (timestamp, session_id, user_id, action, tool, input_hash, decision, source)
  Khong cho UPDATE/DELETE — chi INSERT.
  Export cho compliance team hang thang.

PATTERN: Config Push
  Config Node push config xuong dev nodes qua:
  - WebSocket subscription (real-time)
  - Periodic pull (fallback, moi 5 phut)
  Dev node cache config local (hoat dong khi network mat).
```

---

## 6. Topology 4: CI/CD Pipeline

### 6.1 Khi nao dung

- Agent chay trong CI/CD (GitHub Actions, GitLab CI)
- Automated code review, test generation, PR fix
- Khong co user tuong tac — headless mode
- Can strict governance (khong ai giam sat real-time)

### 6.2 Network Diagram

```
+===================================================================+
|  CI/CD RUNNER NODE (ephemeral container)                           |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |  CI Job: "Agent Code Review"                                  |  |
|  |                                                               |  |
|  |  +----------+    +----------+    +----------+                 |  |
|  |  | Inner    |    | Control  |    | Outer    |                 |  |
|  |  | Harness  |<-->| Plane    |<-->| Harness  |                 |  |
|  |  |          |    | (in-proc)|    | (STRICT) |                 |  |
|  |  | model:   |    +----------+    |          |                 |  |
|  |  | haiku    |                    | mode:    |                 |  |
|  |  | (cheap)  |                    | plan     |                 |  |
|  |  +-----+----+                    | (read    |                 |  |
|  |        |                         |  only)   |                 |  |
|  |        |                         +-----+----+                 |  |
|  |        |                               |                      |  |
|  +--------+-------------------------------+----------------------+  |
|           |                               |                         |
|           v                               v                         |
|  +--------+--------+            +--------+---------+                |
|  | Repo Checkout   |            | Job Artifacts    |                |
|  | (read-only)     |            | - review.md      |                |
|  |                 |            | - metrics.json   |                |
|  +-----------------+            | - audit.jsonl    |                |
|                                 +------------------+                |
+===================================================================+
           |                               |
           | HTTPS                         | HTTPS (upload)
           v                               v
+----------+---------+          +----------+---------+
| LLM API            |          | GATEWAY NODE       |
| (Anthropic)        |          | (report metrics,   |
+--------------------+          |  upload audit log)  |
                                +--------------------+

Hoac neu co Gateway:

+===================================================================+
|  CI/CD RUNNER NODE                                                 |
|                                                                    |
|  +----------+    +----------+                                      |
|  | Inner    |    | Control  |                                      |
|  | Harness  |<-->| Plane    |----gRPC----> GATEWAY NODE            |
|  +----------+    | (hybrid) |              (permission, output,    |
|                  +----------+               budget, audit)         |
+===================================================================+
```

### 6.3 CI/CD Config

```yaml
# .github/workflows/agent-review.yaml

- uses: agentweave/action@v1
  with:
    prompt: "Review this PR for bugs and security issues"
    config: |
      inner:
        model: claude-haiku-4-5      # Cheap cho CI
        maxTurns: 20
        tools: [file-read, grep, glob]  # Read-only tools only
      permissions:
        mode: plan                    # Read-only mode
        rules:
          - { pattern: "Bash(*)", behavior: deny }       # Khong cho chay bash
          - { pattern: "FileWrite(*)", behavior: deny }   # Khong cho ghi file
      budget:
        maxPerSession: 1.00           # $1 max per PR review
      output:
        gateMode: passthrough
        pipeline:
          filter:
            enabled: true
            filters:
              - { name: secrets, type: secret, patterns: ["sk-.*", "AKIA.*"] }
```

---

## 7. Topology 5: Multi-Agent Fleet

### 7.1 Khi nao dung

- Coordinator pattern: 1 lead agent + N worker agents
- Moi agent co Inner Harness rieng
- Outer Harness chung (shared governance)

### 7.2 Network Diagram

```
+===================================================================+
|  DEV NODE (hoac dedicated server)                                  |
|                                                                    |
|  +--------------------------------------------------------------+  |
|  |  COORDINATOR AGENT                                            |  |
|  |                                                               |  |
|  |  +----------+    +----------+                                 |  |
|  |  | Inner    |    | Control  |                                 |  |
|  |  | Harness  |<-->| Plane    |<---+                            |  |
|  |  | (Opus)   |    | (main)   |    |                            |  |
|  |  +----------+    +----------+    |                            |  |
|  |                                  |                            |  |
|  +----------------------------------+----------------------------+  |
|                                     |                               |
|              spawn                  | shared Control Plane          |
|          +---+---+---+              |                               |
|          |       |   |              |                               |
|          v       v   v              |                               |
|  +-------+-+ +--+-+ +--+-+         |                               |
|  |Worker 1 | |W 2 | |W 3 |         |                               |
|  |         | |    | |    |         |                               |
|  |+------+ | |+--+| |+--+|         |                               |
|  ||Inner | | ||In || ||In ||         |                               |
|  ||Harnes| | ||  || ||  ||         |                               |
|  ||Sonnet| | ||Ha|| ||So||         |                               |
|  |+--+---+ | |+--+| |+--+|         |                               |
|  |   |     | |    | |    |         |                               |
|  |   +-----+-+----+-+----+---------+                               |
|  |   |     | |    | |    |  (all workers share                     |
|  |   |     | |    | |    |   same Control Plane                    |
|  +---+-----+-+----+-+----+   = same Outer Harness)                 |
|      |       |      |                                               |
|      v       v      v                                               |
|  +---+-------+------+-----------+                                   |
|  | SHARED OUTER HARNESS         |                                   |
|  |                              |                                   |
|  | PermissionEngine             |  <-- shared rules cho tat ca      |
|  | BudgetManager                |  <-- shared budget, per-agent     |
|  | OutputPipeline               |  <-- shared filters               |
|  | MultiAgentOrchestrator       |  <-- track agent fleet            |
|  |   - agent registry           |                                   |
|  |   - per-agent metrics        |                                   |
|  |   - total budget tracking    |                                   |
|  |   - agent communication log  |                                   |
|  +------------------------------+                                   |
|                                                                     |
+===================================================================+
         |
         | HTTPS (shared connection pool)
         v
+-------------------+
| LLM API           |
+-------------------+
```

### 7.3 Multi-Agent Budget Allocation

```
Total session budget: $20.00
  |
  +-- Coordinator: $5.00 (Opus — expensive but smart)
  +-- Worker 1 (research): $2.00 (Haiku — cheap, read-only)
  +-- Worker 2 (research): $2.00 (Haiku)
  +-- Worker 3 (implement): $8.00 (Sonnet — mid-range, writes code)
  +-- Reserve: $3.00 (cho retry, fallback)

BudgetManager tracks:
  coordinator.spent = $1.20
  worker1.spent = $0.80
  worker2.spent = $0.60
  worker3.spent = $3.50
  total.spent = $6.10 / $20.00

Alert: worker3 at 44% of budget ($3.50 / $8.00)
```

---

## 8. Gateway Design

### 8.1 Gateway la gi?

Gateway Node la **trung tam dieu phoi** giua dev nodes va backend services. No la **single entry point** cho tat ca traffic.

### 8.2 Gateway Components

```
+================================================================+
|  GATEWAY NODE                                                   |
|                                                                 |
|  +--[EDGE LAYER]--------------------------------------------+  |
|  |                                                           |  |
|  |  +-------------------+   +-------------------+            |  |
|  |  | TLS Termination   |   | Authentication    |            |  |
|  |  | (mTLS for agents, |   | (JWT validation,  |            |  |
|  |  |  TLS for browser) |   |  API key check,   |            |  |
|  |  +-------------------+   |  SSO/OIDC)        |            |  |
|  |                          +-------------------+            |  |
|  |  +-------------------+   +-------------------+            |  |
|  |  | Rate Limiter      |   | RBAC Enforcer     |            |  |
|  |  | (per-user,        |   | (role -> allowed   |            |  |
|  |  |  per-team,        |   |  actions mapping)  |            |  |
|  |  |  per-minute)      |   +-------------------+            |  |
|  |  +-------------------+                                    |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
|  +--[PROTOCOL LAYER]----------------------------------------+  |
|  |                                                           |  |
|  |  +-------------------+   +-------------------+            |  |
|  |  | AWOCP Server      |   | REST API Server   |            |  |
|  |  | (WebSocket :9100) |   | (HTTP :8080)      |            |  |
|  |  |                   |   |                   |            |  |
|  |  | - Agent connect   |   | - Config CRUD     |            |  |
|  |  | - Real-time       |   | - Rule CRUD       |            |  |
|  |  |   events          |   | - Session query   |            |  |
|  |  | - Interceptor     |   | - Metrics query   |            |  |
|  |  |   relay           |   | - Dashboard API   |            |  |
|  |  +-------------------+   +-------------------+            |  |
|  |                                                           |  |
|  |  +-------------------+                                    |  |
|  |  | gRPC Server       |                                    |  |
|  |  | (:9101)           |                                    |  |
|  |  |                   |                                    |  |
|  |  | - High-perf path  |                                    |  |
|  |  |   cho CI/CD       |                                    |  |
|  |  | - Streaming       |                                    |  |
|  |  |   intercepts      |                                    |  |
|  |  +-------------------+                                    |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
|  +--[GOVERNANCE LAYER]---------------------------------------+  |
|  |                                                           |  |
|  |  Shared Permission Engine                                 |  |
|  |  Shared Output Pipeline                                   |  |
|  |  Shared Budget Manager                                    |  |
|  |  Shared Hook Engine (org-level hooks)                     |  |
|  |                                                           |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
|  +--[ROUTING LAYER]-----------------------------------------+  |
|  |                                                           |  |
|  |  +-------------------+   +-------------------+            |  |
|  |  | Event Router      |   | LLM Proxy         |            |  |
|  |  | (fan-out events   |   | (optional:         |            |  |
|  |  |  to Observability |   |  centralize LLM    |            |  |
|  |  |  node)            |   |  calls, inject org |            |  |
|  |  +-------------------+   |  API key, cache)   |            |  |
|  |                          +-------------------+            |  |
|  +-----------------------------------------------------------+  |
|                                                                 |
+================================================================+
```

### 8.3 Gateway Traffic Routing

```
INBOUND from Dev Node (WebSocket):

  [Dev Node] --WS--> [TLS] --> [Auth: JWT] --> [RBAC] --> [AWOCP Server]
                                                                |
                          +-------------------------------------+
                          |
              +-----------+-----------+-----------+
              |                       |           |
        intercept:              intercept:    event:
        tool_request            output_ready  * (all)
              |                       |           |
              v                       v           v
        [Permission            [Output       [Event Router]
         Engine]                Pipeline]         |
              |                       |     +-----+-----+
              v                       v     v           v
        [ToolDecision]          [OutputDecision]  [Observability]
              |                       |           [Node]
              v                       v
        [AWOCP Server] --WS--> [Dev Node]
```

### 8.4 LLM Proxy Pattern (optional)

```
Tai sao proxy LLM qua Gateway?

1. API Key management: dev KHONG can biet API key
   - Gateway inject org key tu vault
   - Dev node chi can AgentWeave auth token

2. Usage tracking: dem token/cost tai 1 diem
   - Khong phu thuoc dev node bao cao dung

3. Rate limiting: gioi han per-user tai gateway
   - Tranh 1 developer dung het quota ca team

4. Caching: cache identical requests
   - 2 developer cung query -> cache hit

5. Fallback: gateway tu dong switch provider
   - Anthropic down -> switch Bedrock
   - Khong can thay doi code o dev node

Flow:
  [Dev Node: Inner Harness]
    |-- HTTPS --> [Gateway: LLM Proxy]
                    |-- track usage
                    |-- inject API key
                    |-- check rate limit
                    |-- HTTPS --> [Anthropic API]
                    |<-- response
                    |-- track tokens/cost
                    |-- forward to dev
    |<-- response
```

---

## 9. Traffic Flow & Protocols

### 9.1 Protocol Summary

```
Connection              Protocol        Port    Auth            Direction
------------------      ----------      ----    -----------     ---------
Dev <-> Gateway         WebSocket/TLS   9100    JWT             Bidirectional
Dev <-> Gateway         gRPC/mTLS       9101    mTLS cert       Bidirectional
Dev <-> LLM API         HTTPS           443     API key/OAuth   Outbound only
Dev <-> Local files     Filesystem      -       OS perms        Local
Gateway <-> Observ.     gRPC/mTLS       4317    mTLS            Outbound (GW->Obs)
Gateway <-> Config      gRPC/mTLS       2379    mTLS            Bidirectional
Browser <-> Dashboard   HTTPS           3000    JWT/Cookie      Inbound
CI/CD <-> Gateway       gRPC/mTLS       9101    Service token   Bidirectional
Gateway <-> LLM API     HTTPS           443     Org API key     Outbound only
```

### 9.2 Bandwidth Estimates

```
Per developer, per hour (active coding session):

  Dev <-> LLM API:     ~50 MB (prompt + response, streaming)
  Dev <-> Gateway:      ~2 MB  (interceptor decisions, events)
  Gateway <-> Observ:   ~5 MB  (metrics, traces, audit logs)

Per CI/CD job:
  Runner <-> LLM API:  ~5 MB
  Runner <-> Gateway:   ~0.5 MB
```

---

## 10. Data Residency & Storage Topology

### 10.1 Data Types va o dau luu

```
DATA TYPE          SENSITIVITY   RETENTION   STORAGE LOCATION
-----------        -----------   ---------   ----------------
Conversation       HIGH          7-30 days   Dev Node (local) + Session Store (encrypted)
transcript                                   KHONG luu tren Gateway

Tool input/output  HIGH          7 days      Dev Node (local) + Audit DB (hashed)
                                             Full content chi o Dev, hash o central

Audit log          MEDIUM        1-5 years   Audit DB (PostgreSQL, append-only, encrypted)
(decisions only)                             Tamper-evident chain

Metrics            LOW           90 days     Prometheus / VictoriaMetrics
(aggregated)

Traces             MEDIUM        30 days     Tempo / Jaeger (with PII scrubbing)

Config/Rules       LOW           Forever     Config Node (etcd / git repo)
                                             Versioned, audited

API Keys           CRITICAL      -           Vault (HashiCorp / AWS Secrets Manager)
                                             KHONG BAO GIO luu plaintext

Budget/Billing     MEDIUM        1 year      Billing DB (PostgreSQL)
```

### 10.2 Storage Diagram

```
DEV NODE                          GATEWAY NODE               OBSERVABILITY NODE
+------------------+              +---------------+           +------------------+
|~/.agentweave/    |              |               |           |                  |
|  sessions/       |  transcript  |  (NO storage  |  metrics  | Prometheus       |
|    *.jsonl    ---+--encrypted-->|   of content  |--(push)-->| (90 day)         |
|  audit.local.jsonl              |   at gateway) |           |                  |
|  config-cache.yaml              |               |  traces   | Tempo            |
+------------------+              |  +----------+ |-(push)--->| (30 day)         |
                                  |  |Audit DB  | |           |                  |
                                  |  |(decisions| |  audit    | Grafana          |
                                  |  | + hashes | |<(query)---| (dashboard)      |
                                  |  +----------+ |           |                  |
                                  |               |           | S3 / MinIO       |
                                  |  +----------+ |           | (session archive,|
                                  |  |Config    | |           |  encrypted)      |
                                  |  |Store     | |           +------------------+
                                  |  |(etcd)    | |
                                  |  +----------+ |
                                  +---------------+
```

---

## 11. Scaling Patterns

### 11.1 Horizontal Scaling

```
COMPONENT               SCALING STRATEGY                BOTTLENECK
---------               ----------------                ----------
Gateway: AWOCP Server   Horizontal (K8s replicas)       WebSocket connections
                        Load balance: sticky sessions
                        Target: 500 connections/pod

Gateway: Permission     Horizontal (stateless)          Rule evaluation CPU
                        Cache rules in-memory
                        Target: 10K decisions/sec/pod

Gateway: Output Pipeline Horizontal (stateless)         Filter/transform CPU
                         Target: 1K outputs/sec/pod

Observability: Metrics   Vertical (Prometheus)           Disk I/O, memory
                         or Horizontal (Thanos/Cortex)

Observability: Logs      Horizontal (Loki)               Disk I/O

Config Store             Raft consensus (etcd, 3-5 nodes) Consensus latency

Audit DB                 Vertical (PostgreSQL)            Write throughput
                         or Horizontal (CockroachDB)
```

### 11.2 Capacity Planning

```
TEAM SIZE    GATEWAY PODS    OBSERV. RESOURCES    ESTIMATED COST
---------    ------------    -----------------    --------------
5 devs       1 pod           1 pod (2 CPU, 4GB)   ~$50/month
20 devs      2 pods          2 pods (4 CPU, 8GB)   ~$200/month
50 devs      3 pods          3 pods + S3            ~$500/month
200 devs     5 pods (HPA)    Dedicated cluster      ~$2000/month
```

---

## 12. Infrastructure Requirements

### 12.1 Dev Node (minimum)

```
OS:       macOS 13+ / Ubuntu 22+ / Windows 11
Runtime:  Node.js 22+ (or Bun 1.1+)
Memory:   8 GB (agent + tools)
Disk:     1 GB (sessions, cache)
Network:  Outbound HTTPS (to LLM API + Gateway)
```

### 12.2 Gateway Node (minimum)

```
Container: Docker / K8s pod
CPU:       2 vCPU
Memory:    4 GB
Disk:      20 GB (config cache, temp audit)
Network:   Inbound: 9100 (WS), 9101 (gRPC), 8080 (REST)
           Outbound: to LLM API, Observability
TLS:       TLS cert (Let's Encrypt / internal CA)
```

### 12.3 Observability Node (minimum)

```
Container: Docker / K8s pod
CPU:       4 vCPU
Memory:    8 GB (Prometheus, Grafana)
Disk:      100 GB (metrics 90 days, logs 30 days)
Network:   Inbound: 4317 (OTLP), 3000 (dashboard)
```

---

## 13. Security Zones & Network Policies

### 13.1 Zone Diagram

```
+---[ZONE: UNTRUSTED]---------+
|                              |
|  Internet                    |
|  (LLM API providers)        |
|                              |
+----------+-------------------+
           | HTTPS only, outbound only
           v
+---[ZONE: DMZ]----------------+
|                               |
|  API Gateway (Kong / Envoy)   |
|  - TLS termination            |
|  - Auth enforcement           |
|  - Rate limiting              |
|                               |
+----------+--------------------+
           | mTLS
           v
+---[ZONE: TRUSTED - Control]--+
|                               |
|  Governance Node              |
|  Config Node                  |
|  AWOCP Server                 |
|                               |
+----------+--------------------+
           | mTLS
           v
+---[ZONE: TRUSTED - Data]-----+
|                               |
|  Observability Node           |
|  Audit DB                     |
|  Session Store                |
|                               |
+-------------------------------+

+---[ZONE: AGENT]--------------+
|                               |
|  Dev Nodes (agent execution)  |
|  CI/CD Nodes                  |
|                               |
|  Outbound: DMZ (gateway)      |
|  Outbound: LLM API            |
|  Inbound: NONE                |
|                               |
+-------------------------------+
```

### 13.2 Network Policies (K8s)

```yaml
# Gateway: chi cho phep tu Agent zone va inbound dashboard
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: gateway-policy
spec:
  podSelector:
    matchLabels: { app: agentweave-gateway }
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { zone: agent } }
      ports:
        - { port: 9100, protocol: TCP }   # AWOCP WS
        - { port: 9101, protocol: TCP }   # gRPC
    - from:
        - namespaceSelector: { matchLabels: { zone: dashboard } }
      ports:
        - { port: 8080, protocol: TCP }   # REST API
  egress:
    - to:
        - namespaceSelector: { matchLabels: { zone: observability } }
      ports:
        - { port: 4317, protocol: TCP }   # OTLP
    - to:
        - namespaceSelector: { matchLabels: { zone: config } }
      ports:
        - { port: 2379, protocol: TCP }   # etcd
```

---

## 14. Failure Domains & HA

### 14.1 Failure Scenarios

```
FAILURE                        IMPACT                          MITIGATION
-------                        ------                          ----------
Gateway Node down              Dev nodes can't get             1. Local config cache (stale OK)
                               remote permission               2. Fallback to local-only rules
                               decisions                       3. K8s: auto-restart pod
                                                               4. Multi-replica: LB routes to healthy

LLM API down                   Agent can't call LLM            1. Retry with backoff
                                                               2. Fallback model (diff provider)
                                                               3. Queue prompt, retry later

Observability Node down        No metrics/dashboard            1. Events buffered on dev node
                                                               2. Auto-flush when OBS recovers
                                                               3. Agent keeps running (non-critical)

Config Node down               No config updates               1. Dev nodes cache last-known config
                                                               2. Gateway caches config in-memory
                                                               3. Stale config OK for hours

Audit DB down                  Audit logs not persisted        1. Buffer in Gateway memory (ring)
                                                               2. Write to local disk as fallback
                                                               3. Flush when DB recovers
                                                               4. ALERT: audit gap detected

Dev Node crash                 Agent session lost              1. Session transcript on disk (auto-save)
                                                               2. Resume from last checkpoint
                                                               3. Outer Harness detects disconnect

Network partition              Dev can't reach Gateway         1. Local-only mode (all Outer runs local)
(Dev <-> Gateway)                                              2. Buffer events, sync later
                                                               3. Conservative permissions (fail-closed)
```

### 14.2 Degradation Modes

```
FULL MODE (all nodes healthy):
  Local rules + Remote rules + Centralized monitoring + Dashboard

DEGRADED MODE (Gateway down):
  Local rules only + Local monitoring + No dashboard
  Agent keeps working, governance limited to local config

OFFLINE MODE (no network):
  Local rules only + Local monitoring + No LLM API
  Agent CANNOT work (needs LLM) — queue prompts for later

EMERGENCY MODE (admin override):
  All permissions = DENY
  All agents stopped
  Audit preserved
  Triggered by: admin command or auto-detect anomaly
```

---

## 15. Migration Path

### 15.1 Local -> Team -> Enterprise

```
STAGE 1: Solo Developer (Week 1)
  - Install agentweave CLI
  - agentweave.yaml in project
  - Everything runs local
  - Zero infrastructure needed

STAGE 2: Team (Month 2)
  - Deploy Gateway Node (1 Docker container)
  - Team lead configures shared rules
  - Dev nodes connect via WebSocket
  - Add Grafana dashboard (1 container)
  - Total: 2 containers

STAGE 3: Enterprise (Month 6)
  - Deploy to K8s
  - Add API Gateway (Kong/Envoy)
  - Add Config Node (etcd)
  - Add Audit DB (PostgreSQL)
  - Add SSO integration
  - Add immutable policy rules
  - Total: K8s cluster

Progression is ADDITIVE:
  - KHONG can thay doi code tren dev node
  - KHONG can thay doi Inner Harness
  - Chi them infrastructure + config
  - Dev node tu dong detect va connect Gateway neu co
```

### 15.2 Config Evolution

```
Stage 1 (local only):
  .agentweave/config.yaml  <-- chi co file nay

Stage 2 (add team):
  .agentweave/config.yaml       <-- project rules (same as before)
  + gateway: "wss://gateway.team.internal:9100"  <-- them 1 dong
  (Gateway co team config rieng, merge voi project config)

Stage 3 (add enterprise):
  .agentweave/config.yaml       <-- project rules (same)
  + gateway: "wss://gateway.corp.internal:9100"
  (Gateway co enterprise policy, OVERRIDE project rules khi conflict)
  (Dev KHONG the thay doi policy rules — read-only tu Gateway)
```

---

## Appendix: Document Map (Updated)

```
[1] knowledge_base_claude_code.md           -- Reference: codebase goc
[2] harness_engineering.md                  -- Patterns: ky thuat tu Claude Code
[3] product_spec_agent_harness_framework.md -- Product: WHAT to build
[4] architecture_agent_harness_framework.md -- Architecture: Inner/Outer/CP layers
[5] scenario_b_implementation_guide.md      -- Implementation: HOW to code
[6] high_level_design.md                    -- HLD: WHERE to deploy (THIS FILE)
     |
     v
   READY TO BUILD + DEPLOY
```

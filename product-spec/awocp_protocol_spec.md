# AWOCP — AgentWeave Outer Control Protocol

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia giao thuc giao tiep giua Dev Node va Gateway Node

---

## 1. Tong quan

AWOCP la giao thuc cho phep **Dev Node** (chay Inner Harness + local Outer) giao tiep voi **Gateway Node** (shared Outer Harness governance) trong topology Team va Enterprise.

```
DEV NODE                          GATEWAY NODE
+------------------+              +------------------+
| Inner Harness    |              | Shared Outer     |
| Control Plane    |              |   Permission     |
|   |              |   AWOCP      |   OutputPipeline |
|   +-- Local -----+-- (WS) ---->|   BudgetManager  |
|   |  Interceptor |              |   AuditLogger    |
|   |              |              |   ConfigStore    |
+------------------+              +------------------+
```

**Khi nao dung AWOCP:**
- Solo Dev: KHONG dung (tat ca in-process)
- Team: Dev Node connect toi Gateway qua AWOCP (WS)
- Enterprise: Dev Node connect toi Gateway qua AWOCP (gRPC voi mTLS)
- CI/CD: CI runner connect toi Gateway qua AWOCP (gRPC)

---

## 2. Transport Layer

### 2.1 WebSocket (Team topology — default)

```
URL: wss://gateway.team.internal:9100/awocp/v1
Subprotocol: awocp-v1
Auth: Bearer token trong first message (handshake)
Encoding: JSON (human-readable, debuggable)
Compression: permessage-deflate (optional)
Heartbeat: ping/pong moi 30s
```

### 2.2 gRPC (Enterprise topology — high-performance)

```
Endpoint: gateway.enterprise.internal:9101
Service: agentweave.awocp.v1.ControlService
Auth: mTLS (client certificate)
Encoding: Protocol Buffers (protobuf)
Streaming: bidirectional stream
```

### 2.3 Chon transport nao?

| Tieu chi | WebSocket + JSON | gRPC + Protobuf |
|---|---|---|
| Latency | ~5-20ms | ~1-5ms |
| Throughput | Trung binh | Cao |
| Debuggability | Cao (JSON readable) | Thap (binary) |
| Setup | Don gian | Phuc tap (certs, proto) |
| Browser support | Co (dashboard) | Khong (can proxy) |
| Use case | Team (5-50 devs) | Enterprise (50-1000+) |

---

## 3. Message Format

### 3.1 Envelope (chung cho tat ca messages)

```typescript
type AWOCPMessage = {
  /** Message ID (nanoid, 21 chars) */
  id: string

  /** Timestamp (ISO 8601) */
  ts: string

  /** Message type */
  type: AWOCPMessageType

  /** Session ID cua agent session */
  sessionId: string

  /** Agent ID (support multi-agent) */
  agentId: string

  /** Correlation ID (de match request/response) */
  correlationId?: string

  /** Payload (type-specific) */
  payload: unknown
}

type AWOCPMessageType =
  // === Handshake ===
  | 'auth:request'
  | 'auth:response'
  | 'auth:refresh'

  // === Intercept (request/response pattern) ===
  | 'intercept:tool_request'
  | 'intercept:tool_response'
  | 'intercept:output_request'
  | 'intercept:output_response'
  | 'intercept:input_request'
  | 'intercept:input_response'

  // === Events (fire-and-forget) ===
  | 'event:inner'              // Inner event forwarded to Gateway
  | 'event:outer'              // Outer event from Gateway

  // === Commands (request/ack pattern) ===
  | 'command:send'
  | 'command:ack'

  // === Config ===
  | 'config:pull'              // Dev Node requests latest config
  | 'config:push'              // Gateway pushes config update
  | 'config:ack'

  // === Health ===
  | 'health:ping'
  | 'health:pong'
```

### 3.2 Handshake Flow

```
DEV NODE                                  GATEWAY NODE

1. WebSocket connect
   wss://gateway:9100/awocp/v1
                                          2. Connection accepted

3. auth:request
   {
     type: 'auth:request',
     payload: {
       token: 'Bearer eyJ...',           // JWT hoac API key
       clientVersion: '0.1.0',
       capabilities: ['intercept', 'event', 'config'],
       sessionInfo: {
         sessionId: 'ses_abc123',
         userId: 'user_456',
         projectId: 'proj_789',
         model: 'claude-sonnet-4-6',
       }
     }
   }
                                          4. auth:response
                                             {
                                               type: 'auth:response',
                                               payload: {
                                                 status: 'ok',
                                                 serverId: 'gw_001',
                                                 serverVersion: '0.1.0',
                                                 effectiveConfig: { ... },
                                                 features: ['permission', 'output_filter', 'budget'],
                                               }
                                             }

5. Ready to intercept
```

### 3.3 Intercept Flow (Tool Request)

```
DEV NODE                                  GATEWAY NODE

1. Inner Harness emits tool:requested
2. Local interceptor: no match
3. Forward to Gateway:

   intercept:tool_request
   {
     correlationId: 'corr_001',
     payload: {
       toolName: 'Bash',
       toolInput: { command: 'rm -rf logs/' },
       toolUseId: 'tu_123',
       turnIndex: 3,
       isReadOnly: false,
       isDestructive: true,
       // NOTE: toolInput co the bi redact truoc khi gui
       //       tuy config (dataMinimization: true)
     }
   }
                                          4. Permission Engine evaluates
                                          5. Rule match: DENY "Bash(rm -rf *)"

                                          intercept:tool_response
                                          {
                                            correlationId: 'corr_001',
                                            payload: {
                                              behavior: 'deny',
                                              reason: 'Destructive deletion is not allowed',
                                              source: 'rule:team_policy',
                                            }
                                          }

6. Local interceptor receives response
7. Return ToolDecision to Inner Harness
```

---

## 4. Data Minimization

Khi forward data qua network (Dev -> Gateway), can can nhac privacy:

```yaml
# Gateway config
awocp:
  dataMinimization:
    enabled: true
    # Chi gui metadata, KHONG gui full tool input
    toolRequest:
      sendInput: false           # Default: true
      sendInputHash: true        # SHA-256 hash (de audit, khong doc duoc)
      sendMetadataOnly: true     # Chi gui: toolName, isReadOnly, isDestructive
    # Chi gui metadata ve output, khong gui content
    outputReady:
      sendContent: false
      sendContentHash: true
      sendMetrics: true          # length, token count, cost
```

**Khi `sendInput: false`:**
- Gateway chi nhan toolName + metadata
- Permission Engine chi co the match tren toolName pattern (khong match tren input args)
- Trade-off: bao mat cao hon nhung governance han che hon

**Khi `sendInput: true` (default):**
- Gateway nhan full tool input
- Permission Engine match tren ca toolName + input args
- Data duoc encrypt in-transit (TLS) nhung visible tren Gateway

---

## 5. Error Handling & Reconnection

### 5.1 Connection Loss

```
Scenario                         Hanh vi
-------------------------------  ------------------------------------------------
Gateway unreachable (connect)    Retry voi exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
                                 Sau 5 retries: fallback ve local-only mode (warn user)

Connection drop (mid-session)    Auto-reconnect voi same session ID
                                 Pending intercepts: timeout -> use local fallback
                                 Events in queue: buffer (max 1000), replay on reconnect

Gateway returns error            Log error, fallback ve local decision
                                 Emit event: 'gateway:error'

Gateway overloaded (429)         Respect Retry-After header
                                 Fallback ve local cho pending requests
```

### 5.2 Intercept Timeout

```
Config:
  interceptTimeout:
    tool_request: 5000     # ms — default 5s (permission check)
    output_ready: 10000    # ms — default 10s (output pipeline)
    input_received: 3000   # ms — default 3s (input gate)

On timeout:
  - Use local fallback decision (configurable: fail-open or fail-closed)
  - Emit event: 'gateway:intercept_timeout'
  - Increment metrics: awocp_intercept_timeout_total
```

### 5.3 Version Mismatch

```
Dev Node v0.2.0 connects to Gateway v0.1.0

Handshake response:
{
  status: 'version_mismatch',
  minClientVersion: '0.1.0',
  maxClientVersion: '0.1.5',
  message: 'Client version 0.2.0 not supported. Please downgrade or upgrade Gateway.'
}

Policy: Gateway define [minVersion, maxVersion] range.
Dev Node ngoai range --> reject connection voi clear error message.
```

---

## 6. Security

### 6.1 Authentication

| Topology | Auth Method | Details |
|---|---|---|
| Team | Bearer Token (JWT) | Issued by Gateway admin, expires 24h, refresh via `auth:refresh` |
| Enterprise | mTLS | Client certificate issued by company CA, validated by Gateway |
| CI/CD | Service Account Token | Long-lived, scoped to project, stored in CI secrets |

### 6.2 Authorization (per connection)

```typescript
type ConnectionScope = {
  userId: string
  role: 'developer' | 'team_lead' | 'admin' | 'ci_bot'
  teams: string[]
  projects: string[]             // Restricted to these projects
  permissions: {
    canReadOtherSessions: boolean  // Default: false
    canModifyTeamRules: boolean    // Default: false (true for team_lead+)
    canModifyPolicyRules: boolean  // Default: false (true for admin)
    canViewDashboard: boolean      // Default: true
    budgetOverride: number | null  // null = use team default
  }
}
```

### 6.3 Encryption

- In-transit: TLS 1.3 (bat buoc)
- At-rest (audit logs): AES-256-GCM (configurable)
- Tool input forwarding: encrypted in TLS, optionally hashed (data minimization)

---

## 7. Metrics & Observability

Gateway expose cac metrics sau (Prometheus format):

```
# Connection metrics
awocp_connections_active{node_type="dev"}        gauge
awocp_connections_total{node_type="dev"}         counter
awocp_connection_errors_total{reason="..."}      counter

# Intercept metrics
awocp_intercept_duration_seconds{type="tool_request"}     histogram
awocp_intercept_total{type="...", result="allow|deny"}    counter
awocp_intercept_timeout_total{type="..."}                 counter

# Message metrics
awocp_messages_sent_total{type="..."}          counter
awocp_messages_received_total{type="..."}      counter
awocp_message_size_bytes{type="..."}           histogram

# Health
awocp_heartbeat_latency_seconds                histogram
```

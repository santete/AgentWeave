# AgentWeave — Multi-Agent Communication Protocol

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia cach nhieu agents giao tiep, chia se state, va xu ly conflict

---

## 1. Multi-Agent Topologies

### 1.1 Coordinator Pattern (Mac dinh)

```
                    Coordinator Agent (Opus)
                    model: opus, full permissions
                    budget: $20 total
                          |
            +-------------+-------------+
            |             |             |
        Worker 1      Worker 2      Worker 3
        (Research)    (Implement)   (Test)
        model: haiku  model: sonnet model: sonnet
        perms: read   perms: full   perms: read+bash
        budget: $2    budget: $10   budget: $5
```

### 1.2 Pipeline Pattern

```
Agent A (Research) --> Agent B (Plan) --> Agent C (Implement) --> Agent D (Review)
     |                    |                    |                      |
     +-- result A ------->+-- result B ------->+-- result C -------->+
```

### 1.3 Parallel Workers Pattern

```
              Spawner
                |
    +-----------+-----------+
    |           |           |
 Worker 1   Worker 2   Worker 3    (chay song song)
    |           |           |
    +-----------+-----------+
                |
            Aggregator
```

---

## 2. Agent Lifecycle

### 2.1 Spawn

```typescript
// Coordinator spawn worker
const worker = await orchestrator.spawn({
  name: 'research-auth',
  prompt: 'Research authentication patterns in this codebase',

  // Model & resource limits
  model: 'claude-haiku-4-5',
  maxTurns: 20,
  budgetUsd: 2.00,
  timeoutMs: 120_000,

  // Permission scope (KHONG the vuot qua parent)
  permissions: {
    mode: 'plan',               // read-only
    rules: [
      { pattern: 'FileRead(**)', behavior: 'allow' },
      { pattern: 'Grep(**)', behavior: 'allow' },
      { pattern: 'Glob(**)', behavior: 'allow' },
      { pattern: '*', behavior: 'deny' },
    ],
  },

  // Tools subset
  tools: ['FileRead', 'Grep', 'Glob'],

  // Communication
  reportTo: 'coordinator',      // Ai nhan ket qua
  shareContext: false,           // Co chia se conversation history voi parent?
})
```

### 2.2 Agent States

```
        spawn()
          |
          v
     +---------+    timeout/error     +---------+
     | PENDING  |-------------------->| FAILED  |
     +----+----+                      +---------+
          |
          | resources ready
          v
     +---------+    abort()           +---------+
     | RUNNING  |-------------------->| ABORTED |
     +----+----+                      +---------+
          |
          | no more tool_use
          v
     +-----------+
     | COMPLETED |
     +-----------+
```

---

## 3. Communication Patterns

### 3.1 Message Passing (Mac dinh)

Agents giao tiep qua **message queue** (khong shared memory):

```typescript
// Worker gui ket qua ve Coordinator
orchestrator.send({
  from: 'worker-1',
  to: 'coordinator',
  type: 'result',
  payload: {
    summary: 'Found 3 auth patterns: JWT, session cookie, API key',
    files: ['src/auth/jwt.ts', 'src/auth/session.ts', 'src/auth/apikey.ts'],
    confidence: 0.9,
  },
})

// Coordinator gui instruction cho Worker
orchestrator.send({
  from: 'coordinator',
  to: 'worker-2',
  type: 'instruction',
  payload: {
    context: 'Based on research, implement JWT auth pattern.',
    files: ['src/auth/jwt.ts'],   // Hint: focus on these files
  },
})
```

### 3.2 Shared Artifact Store

Agents co the chia se artifacts (files, data) qua shared store:

```typescript
// Worker 1 luu artifact
await orchestrator.artifacts.put('auth-research', {
  type: 'research-result',
  data: { patterns: [...], recommendations: [...] },
  createdBy: 'worker-1',
})

// Worker 2 doc artifact
const research = await orchestrator.artifacts.get('auth-research')
```

**Artifact Store:**
- In-memory (default, nhanh, mat khi session ket thuc)
- File-based (persistent, `.agentweave/artifacts/`)
- Artifacts co TTL (default: session lifetime)
- Artifacts immutable sau khi tao (append-only)

### 3.3 Event Broadcasting

```typescript
// Subscribe all agent events (monitoring)
orchestrator.onAgentEvent('*', (event) => {
  console.log(`[${event.agentId}] ${event.type}: ${JSON.stringify(event.data)}`)
})

// Subscribe specific agent
orchestrator.onAgentEvent('worker-1', (event) => {
  if (event.type === 'tool:completed') {
    // Worker 1 vua chay xong tool
  }
})
```

---

## 4. Conflict Resolution

### 4.1 File Edit Conflicts

Khi 2+ agents edit cung 1 file:

```
Strategy                Config key              Hanh vi
----------------------  ----------------------  ----------------------------------------
SEQUENTIAL (default)    conflictStrategy:        Chi 1 agent co write lock tren 1 file
                        'sequential'             tai 1 thoi diem. Agent khac doi.

OPTIMISTIC_LOCK         conflictStrategy:        Agent doc file + ghi version. Khi ghi,
                        'optimistic'             check version. Neu stale --> retry.

PARTITION               conflictStrategy:        Moi agent chi duoc edit files trong
                        'partition'              assigned partition (dirs/globs).

COORDINATOR_MERGE       conflictStrategy:        Ca 2 agent ghi. Coordinator merge
                        'coordinator_merge'      conflicts (nhu git merge).
```

### 4.2 Sequential Lock (Default — Chi tiet)

```
Agent A wants FileEdit("src/auth.ts")
  |
  v
[LockManager.acquire("src/auth.ts", agentId="A")]
  |-- Lock available? YES --> Grant lock, Agent A edits
  |
Agent B wants FileEdit("src/auth.ts")
  |
  v
[LockManager.acquire("src/auth.ts", agentId="B")]
  |-- Lock available? NO (held by A)
  |-- Wait (max waitTimeoutMs: 30000)
  |
Agent A completes edit
  |
  v
[LockManager.release("src/auth.ts", agentId="A")]
  |
  v
Agent B acquires lock, proceeds to edit
```

### 4.3 Partition Assignment

```yaml
multi_agent:
  conflictStrategy: 'partition'
  partitions:
    worker-frontend:
      include: ["src/components/**", "src/pages/**", "src/styles/**"]
      exclude: ["src/components/shared/**"]
    worker-backend:
      include: ["src/api/**", "src/services/**", "src/models/**"]
    worker-shared:
      include: ["src/components/shared/**", "src/utils/**", "src/types/**"]
```

---

## 5. Budget Inheritance

### 5.1 Rules

```
1. Sub-agent budget KHONG the vuot parent budget con lai
   parent.remainingBudget = parent.totalBudget - parent.usedBudget
   child.maxBudget <= parent.remainingBudget

2. Tong budget cua tat ca children <= parent.totalBudget
   sum(children.maxBudget) <= parent.totalBudget

3. Child khong the tang budget cua minh
   (chi Coordinator hoac user co the thay doi)

4. Khi child het budget --> child dung, bao Coordinator
   Coordinator quyet dinh: reallocate tu child khac, hoac dung
```

### 5.2 Budget Tracking

```typescript
type AgentBudget = {
  agentId: string
  parentId: string | null           // null = root agent
  allocatedUsd: number              // Budget duoc cap
  usedUsd: number                   // Da dung
  remainingUsd: number              // Con lai
  children: AgentBudget[]           // Sub-agents
}

// Vi du
{
  agentId: 'coordinator',
  parentId: null,
  allocatedUsd: 20.00,
  usedUsd: 3.50,
  remainingUsd: 16.50,
  children: [
    { agentId: 'worker-1', allocatedUsd: 2.00, usedUsd: 1.80, remainingUsd: 0.20, children: [] },
    { agentId: 'worker-2', allocatedUsd: 10.00, usedUsd: 4.20, remainingUsd: 5.80, children: [] },
    // worker-3 chua spawn --> chua co trong tree
  ],
}
```

---

## 6. Agent Failure & Recovery

### 6.1 Failure Modes

| Failure | Detection | Recovery |
|---|---|---|
| Agent timeout | timeoutMs exceeded | Abort agent, notify Coordinator, Coordinator decides retry/skip |
| Agent budget exceeded | usedUsd >= allocatedUsd | Agent dung, notify Coordinator |
| Agent error (LLM) | API error unrecoverable | Retry 1 lan voi fallback model, then abort |
| Agent crash (process) | Heartbeat miss (3x) | Restart agent tu last checkpoint |
| Agent loop (>50 turns) | turnCount > maxTurns | Abort agent, inject "wrap up" message truoc |

### 6.2 Coordinator Recovery Actions

```typescript
orchestrator.onAgentFailed('worker-1', async (failure) => {
  switch (failure.reason) {
    case 'timeout':
      // Thu spawn lai voi model nhanh hon
      await orchestrator.spawn({
        ...worker1Config,
        model: 'claude-haiku-4-5',
        timeoutMs: 60_000,
      })
      break

    case 'budget_exceeded':
      // Reallocate budget tu agent chua dung het
      const surplus = orchestrator.getReallocatableBudget()
      if (surplus >= 1.0) {
        await orchestrator.respawn('worker-1', { budgetUsd: surplus })
      } else {
        // Bao Coordinator biet khong du budget
        orchestrator.send({
          from: 'system',
          to: 'coordinator',
          type: 'budget_exhausted',
          payload: { agent: 'worker-1', needed: 2.0, available: surplus },
        })
      }
      break

    case 'error':
      // Skip, bao coordinator
      orchestrator.send({
        from: 'system',
        to: 'coordinator',
        type: 'agent_failed',
        payload: failure,
      })
      break
  }
})
```

---

## 7. Governance per Agent

```yaml
multi_agent:
  maxConcurrentAgents: 5
  totalBudgetUsd: 20.00
  conflictStrategy: 'sequential'

  # Agent type presets
  types:
    research:
      model: "claude-haiku-4-5"
      tools: ["FileRead", "Grep", "Glob"]
      permissions: { mode: "plan" }
      budgetUsd: 2.00
      maxTurns: 20
      timeoutMs: 60000

    implementation:
      model: "claude-sonnet-4-6"
      tools: ["FileRead", "FileWrite", "FileEdit", "Bash", "Grep", "Glob"]
      permissions: { mode: "default" }
      budgetUsd: 10.00
      maxTurns: 50
      timeoutMs: 180000

    review:
      model: "claude-sonnet-4-6"
      tools: ["FileRead", "Grep", "Glob", "Bash"]
      permissions:
        mode: "default"
        rules:
          - { pattern: "Bash(npm test)", behavior: "allow" }
          - { pattern: "Bash(npm run lint)", behavior: "allow" }
          - { pattern: "FileWrite(*)", behavior: "deny" }
      budgetUsd: 3.00
      maxTurns: 30
```

---

## 8. MVP Scope

| Feature | MVP | Post-MVP |
|---|---|---|
| Coordinator spawns workers | Co | |
| Message passing (send/receive) | Co | |
| Per-agent budget | Co | |
| Per-agent permissions | Co | |
| Per-agent model | Co | |
| Sequential file locking | Co | |
| Agent timeout/abort | Co | |
| Artifact store | | Co |
| Partition-based conflict | | Co |
| Pipeline pattern | | Co |
| Coordinator merge | | Co |
| Budget reallocation | | Co |
| Agent checkpoint/restart | | Co |

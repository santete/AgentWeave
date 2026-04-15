# Harness Engineering Blueprint

> Chung cat tu source code Claude Code (`@anthropic-ai/claude-code`).
> Muc dich: lam co so xay dung **Outer Harness Framework** cho AI Agent bat ky.

---

## Muc luc

1. [Tong quan kien truc Harness](#1-tong-quan-kien-truc-harness)
2. [Agent Loop (Vong lap Agent)](#2-agent-loop)
3. [Tool System (He thong Tool)](#3-tool-system)
4. [Permission System (He thong quyen)](#4-permission-system)
5. [Hook System (He thong Hook)](#5-hook-system)
6. [Context Construction (Xay dung Context)](#6-context-construction)
7. [State Management (Quan ly trang thai)](#7-state-management)
8. [Session Persistence (Luu tru phien)](#8-session-persistence)
9. [Context Window Management (Nen context)](#9-context-window-management)
10. [Streaming Infrastructure](#10-streaming-infrastructure)
11. [Retry & Fallback](#11-retry-va-fallback)
12. [Multi-Agent Coordination](#12-multi-agent-coordination)
13. [Command & Skill System](#13-command-va-skill-system)
14. [Bootstrap Sequence](#14-bootstrap-sequence)
15. [Framework Blueprint tong hop](#15-framework-blueprint-tong-hop)

---

## 1. Tong quan kien truc Harness

### Harness la gi?

Harness (outer harness) la **lop vo ben ngoai boc quanh LLM**, bien 1 model ngon ngu thanh 1 **agent co kha nang hanh dong**. LLM chi biet tao text; harness cho phep no:

- Goi tools (doc file, chay code, search web...)
- Tu quyet dinh goi tool nao, voi tham so gi
- Nhan ket qua tool va tiep tuc suy nghi
- Lap lai cho den khi hoan thanh nhiem vu

### So do kien truc tong the

```
+------------------------------------------------------------------+
|                        OUTER HARNESS                              |
|                                                                   |
|  +------------------+    +------------------+    +--------------+ |
|  | Bootstrap &      |    | State Management |    | Session      | |
|  | Configuration    |    | (AppState/Store) |    | Persistence  | |
|  +--------+---------+    +--------+---------+    +------+-------+ |
|           |                       |                      |        |
|  +--------v-----------------------v----------------------v------+ |
|  |                    AGENT LOOP (Core)                         | |
|  |                                                              | |
|  |  User Input --> System Prompt Builder --> API Call (stream)   | |
|  |       ^              |                        |              | |
|  |       |              v                        v              | |
|  |       |         Context Window           Parse Response      | |
|  |       |         Management                    |              | |
|  |       |         (compaction)                  v              | |
|  |       |                              tool_use blocks?        | |
|  |       |                              /              \        | |
|  |       |                           NO                YES      | |
|  |       |                            |                 |       | |
|  |       |                        TERMINAL         +---------+  | |
|  |       |                                         |Permission|  | |
|  |       |                                         | Check   |  | |
|  |       |                                         +----+----+  | |
|  |       |                                              |       | |
|  |       |                                         +----v----+  | |
|  |       |                                         | Hook:   |  | |
|  |       |                                         |PreTool  |  | |
|  |       |                                         +----+----+  | |
|  |       |                                              |       | |
|  |       |                                         +----v----+  | |
|  |       |                                         | Execute |  | |
|  |       |                                         | Tool    |  | |
|  |       |                                         +----+----+  | |
|  |       |                                              |       | |
|  |       |                                         +----v----+  | |
|  |       |                                         | Hook:   |  | |
|  |       +--------- tool_result messages <---------+PostTool |  | |
|  |                                                 +---------+  | |
|  +--------------------------------------------------------------+ |
|                                                                   |
|  +--------------+  +----------+  +-----------+  +--------------+  |
|  | Tool Registry|  | Hook     |  | Permission|  | Multi-Agent  |  |
|  | (40+ tools)  |  | Engine   |  | Engine    |  | Coordinator  |  |
|  +--------------+  +----------+  +-----------+  +--------------+  |
+------------------------------------------------------------------+
```

### Nguyen tac thiet ke cot loi

| Nguyen tac | Mo ta | Vi du trong Claude Code |
|---|---|---|
| **State Machine Loop** | Agent loop la 1 while(true) voi cac trang thai ro rang | `query()` function trong `query.ts` |
| **Tool as First-Class** | Moi tool la 1 module doc lap voi schema, permission, execution | `src/tools/*.ts` |
| **Permission Before Execution** | Moi tool call phai qua permission check truoc khi chay | `hasPermissionsToUseTool()` |
| **Hook at Every Seam** | Moi diem noi trong pipeline deu co hook | PreToolUse, PostToolUse, Stop... |
| **Streaming First** | Moi API call deu streaming, khong bao gio blocking | `stream: true` luon bat |
| **Context Budget Aware** | Tu dong quan ly context window, nen khi can | Auto-compact, snip, microcompact |
| **Graceful Degradation** | Retry, fallback model, recovery paths | withRetry, fallbackModel, PTL recovery |
| **Multi-Agent Native** | Sub-agent la tool, khong phai hack | AgentTool, fork, coordinator mode |

---

## 2. Agent Loop

Day la **trai tim cua harness** — vong lap cho phep LLM suy nghi va hanh dong lien tuc.

### 2.1 Kien truc tong the

```
QueryEngine.submitMessage(prompt)
  |
  v
processUserInput()     -- Xu ly slash commands, build initial messages
  |
  v
query() {              -- Main loop (async generator)
  while (true) {
    1. Prepare messages  (compaction, snip, context collapse)
    2. Build system prompt
    3. Call LLM API (streaming)
    4. Parse response
    5. If no tool_use --> RETURN (terminal)
    6. Permission check cho moi tool_use block
    7. Execute hooks (PreToolUse)
    8. Execute tools (concurrent/serial)
    9. Execute hooks (PostToolUse)
    10. Append tool_result vao messages
    11. Check budgets, stop hooks
    12. CONTINUE (loop lai buoc 1)
  }
}
  |
  v
Yield SDKMessage to caller (streaming)
```

### 2.2 State cua moi iteration

```typescript
type LoopState = {
  messages: Message[]                    // Lich su hoi thoai (tich luy qua cac turn)
  toolUseContext: ToolUseContext          // Context thuc thi tools
  autoCompactTracking: TrackingState     // Theo doi context window
  maxOutputTokensRecoveryCount: number   // So lan retry khi bi max_output_tokens
  hasAttemptedReactiveCompact: boolean   // Da thu nen chua (tranh lap vo han)
  maxOutputTokensOverride: number | undefined  // Override max tokens
  stopHookActive: boolean | undefined    // Stop hook dang chay?
  turnCount: number                      // So turn da chay
  transition: Continue | undefined       // Ly do continue (debug)
}
```

### 2.3 Dieu kien ket thuc (Terminal Conditions)

| Dieu kien | Reason | Hanh dong |
|---|---|---|
| Khong co tool_use trong response | `completed` | Return binh thuong |
| Abort signal triggered | `aborted_streaming` hoac `aborted_tools` | Return ngay |
| Max turns reached | `completed` | Yield attachment, return |
| USD budget exceeded | error | Yield error result, return |
| Token budget exceeded | `stop` | Log event, return |
| Stop hook prevent | `stop_hook_prevented` | Return |
| API error khong recovery duoc | `completed` | Return |

### 2.4 Recovery Paths (Tu dong phuc hoi)

Khi gap loi, loop **khong ket thuc ngay** ma thu recovery:

```
1. Prompt Too Long (413)
   --> Reactive Compact (nen conversation)
   --> Guard: hasAttemptedReactiveCompact (chi thu 1 lan)

2. Max Output Tokens (hit limit 8k)
   --> Escalate len 64k
   --> Guard: maxOutputTokensOverride (chi escalate 1 lan)

3. Van bi Max Output Tokens sau escalate
   --> Inject "pick up mid-thought" message
   --> Guard: MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3 lan

4. Stop Hook co blocking errors
   --> Inject errors vao messages, retry
   --> Guard: stopHookActive (tranh re-entrance)

5. Token budget gan het (90%+)
   --> Inject nudge message "please continue"
   --> Guard: feature gate + decision logic
```

### 2.5 Message Threading Pattern

```
Turn 1:
  messages = [user_initial]
  --> API call --> assistant_1 (co tool_use)
  --> Execute tools --> tool_result_1
  messages = [user_initial, assistant_1, tool_result_1]

Turn 2:
  messages = [user_initial, assistant_1, tool_result_1]
  --> API call --> assistant_2 (co tool_use)
  --> Execute tools --> tool_result_2
  messages = [user_initial, assistant_1, tool_result_1, assistant_2, tool_result_2]

Turn 3:
  messages = [user_initial, ..., assistant_2, tool_result_2]
  --> API call --> assistant_3 (KHONG co tool_use)
  --> TERMINAL: return { reason: 'completed' }
```

### 2.6 Code Pattern (Pseudocode)

```typescript
async function* agentLoop(params: {
  systemPrompt: string
  messages: Message[]
  tools: Tool[]
  model: string
  abortSignal: AbortSignal
}): AsyncGenerator<Event, TerminalResult> {

  let state: LoopState = initializeState(params)

  while (true) {
    // 1. Prepare (compaction neu can)
    let messagesForQuery = maybeCompact(state.messages)

    // 2. Call LLM
    const response = await callLLM({
      model: params.model,
      system: params.systemPrompt,
      messages: messagesForQuery,
      tools: params.tools.map(t => t.schema),
      stream: true,
    })

    // 3. Consume streaming response
    const assistantMessage = await consumeStream(response)
    const toolUseBlocks = extractToolUseBlocks(assistantMessage)

    yield { type: 'assistant', message: assistantMessage }

    // 4. Terminal check
    if (toolUseBlocks.length === 0) {
      return { reason: 'completed' }
    }

    // 5. Execute tools
    const toolResults = []
    for (const block of toolUseBlocks) {
      // 5a. Permission check
      const permission = await checkPermission(block, params.tools)
      if (permission.behavior === 'deny') {
        toolResults.push(createDeniedResult(block, permission.message))
        continue
      }

      // 5b. Pre-hook
      const preHook = await executeHooks('PreToolUse', block)
      if (preHook.blocked) {
        toolResults.push(createBlockedResult(block, preHook.message))
        continue
      }

      // 5c. Execute
      const result = await executeTool(block, params.tools)
      toolResults.push(result)

      // 5d. Post-hook
      await executeHooks('PostToolUse', block, result)

      yield { type: 'tool_result', result }
    }

    // 6. Append to messages
    state.messages = [
      ...messagesForQuery,
      assistantMessage,
      ...toolResults,
    ]

    // 7. Budget/abort check
    if (params.abortSignal.aborted) {
      return { reason: 'aborted' }
    }

    state.turnCount++
  }
}
```

---

## 3. Tool System

### 3.1 Tool Interface (Dinh nghia tool)

Moi tool phai implement interface nay:

```typescript
type Tool<Input, Output> = {
  // === IDENTITY ===
  name: string                    // Ten duy nhat (e.g. "Bash", "FileRead")
  aliases?: string[]              // Ten phu
  searchHint?: string             // Goi y tim kiem

  // === SCHEMA & VALIDATION ===
  inputSchema: ZodSchema<Input>   // Schema input (Zod) -- tu dong chuyen thanh JSON Schema cho LLM
  inputJSONSchema?: JSONSchema    // Override JSON Schema neu can
  outputSchema?: ZodSchema        // Schema output (optional)
  validateInput?(input: Input, context: Context): Promise<ValidationResult>

  // === CORE EXECUTION ===
  call(
    args: Input,
    context: ToolUseContext,
    canUseTool: CanUseToolFn,
    parentMessage: AssistantMessage,
    onProgress?: (progress: ProgressData) => void,
  ): Promise<ToolResult<Output>>

  // === SAFETY & PERMISSIONS ===
  checkPermissions(input: Input, context: Context): Promise<PermissionResult>
  isConcurrencySafe(input: Input): boolean      // Co the chay song song?
  isReadOnly(input: Input): boolean             // Chi doc, khong ghi?
  isDestructive?(input: Input): boolean         // Co pha huy du lieu?
  isEnabled(): boolean                          // Dang bat?

  // === BEHAVIOR ===
  interruptBehavior?(): 'cancel' | 'block'      // Khi user interrupt
  requiresUserInteraction?(): boolean            // Can user tuong tac?

  // === RENDERING (UI) ===
  description(input: Input): Promise<string>     // Mo ta cho LLM
  prompt(): Promise<string>                      // System prompt section
  userFacingName(input: Input): string           // Hien thi cho user
  renderToolUseMessage(input: Input): ReactNode  // Render tren terminal
  renderToolResultMessage?(output: Output): ReactNode

  // === OUTPUT SERIALIZATION ===
  maxResultSizeChars: number                     // Gioi han kich thuoc output
  mapToolResultToToolResultBlockParam(           // Chuyen output -> API format
    content: Output,
    toolUseID: string
  ): ToolResultBlockParam
}
```

### 3.2 Tool Result Structure

```typescript
type ToolResult<T> = {
  data: T                          // Ket qua chinh
  newMessages?: Message[]          // Messages phu (inject vao conversation)
  contextModifier?: (ctx: ToolUseContext) => ToolUseContext  // Thay doi context
}
```

### 3.3 Tool Execution Strategy

```
Nhan danh sach tool_use blocks tu LLM response
  |
  v
Partition thanh batches:
  +-- Batch 1: [ReadOnly_A, ReadOnly_B, ReadOnly_C]  --> CONCURRENT (max 10)
  +-- Batch 2: [Write_D]                               --> SERIAL
  +-- Batch 3: [ReadOnly_E, ReadOnly_F]               --> CONCURRENT
  +-- Batch 4: [Write_G]                               --> SERIAL
  |
  v
Chay tung batch theo thu tu:
  Batch 1: Promise.all([A, B, C])  -- song song
  Batch 2: await D                  -- tuan tu
  Batch 3: Promise.all([E, F])     -- song song
  Batch 4: await G                  -- tuan tu
```

**Logic phan loai:**

```typescript
function partitionToolCalls(blocks: ToolUseBlock[]): Batch[] {
  return blocks.reduce((batches, block) => {
    const tool = findTool(block.name)
    const isSafe = tool.isConcurrencySafe(block.input)

    if (isSafe && lastBatch(batches)?.isConcurrencySafe) {
      lastBatch(batches).blocks.push(block)  // Gop vao batch cu
    } else {
      batches.push({ isConcurrencySafe: isSafe, blocks: [block] })  // Batch moi
    }
    return batches
  }, [])
}
```

### 3.4 Streaming Tool Executor

Tools co the **bat dau chay ngay khi LLM van dang streaming**:

```typescript
class StreamingToolExecutor {
  addTool(block: ToolUseBlock, message: AssistantMessage)  // Them tool ngay khi nhan
  getCompletedResults(): MessageUpdate[]       // Lay ket qua da xong
  getRemainingResults(): AsyncGenerator<MessageUpdate>  // Doi ket qua con lai
  discard()                                    // Huy tat ca
}
```

**Flow:**
```
LLM Streaming:  [text...] [tool_use_A...] [text...] [tool_use_B...]
                              |                          |
                              v                          v
                        Start exec A               Start exec B
                              |                          |
LLM Stream ends ------+      |                          |
                      |       v                          v
                      +-- getRemainingResults() --> [result_A, result_B]
```

### 3.5 Vi du tao 1 Tool moi

```typescript
const MyCustomTool: Tool<MyInput, MyOutput> = {
  name: 'MyCustomTool',

  inputSchema: z.object({
    query: z.string().describe('The search query'),
    limit: z.number().optional().describe('Max results'),
  }),

  async call(args, context) {
    const results = await doSomething(args.query, args.limit)
    return { data: results }
  },

  async checkPermissions(input, context) {
    return { behavior: 'allow' }  // Hoac 'ask', 'deny'
  },

  isConcurrencySafe: () => true,   // Read-only, chay song song OK
  isReadOnly: () => true,
  isEnabled: () => true,

  async description(input) {
    return `Search for "${input.query}"`
  },

  async prompt() {
    return 'Use this tool to search for information.'
  },

  userFacingName: () => 'Custom Search',
  maxResultSizeChars: 50_000,

  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: JSON.stringify(content),
    }
  },

  renderToolUseMessage: (input) => <Text>Searching: {input.query}</Text>,
}
```

---

## 4. Permission System

### 4.1 Kien truc tong the

```
Tool Call tu LLM
  |
  v
hasPermissionsToUseTool(tool, input, context)
  |
  v
+-- Check config rules (settings.json: allow/deny/ask)
|     match: "Bash(git *)", "FileRead(*)", "FileWrite(.env)"
|
+-- Check permission mode
|     default: hoi user
|     bypassPermissions: cho qua het
|     plan: chi cho phep read-only
|     auto: ML classifier quyet dinh
|
+-- Return: PermissionDecision
      |
      +-- { behavior: 'allow' }   --> Chay tool
      +-- { behavior: 'deny', message }  --> Tra loi LLM "denied"
      +-- { behavior: 'ask', message }   --> Hoi user
```

### 4.2 Permission Decision Types

```typescript
// Cho phep
type AllowDecision = {
  behavior: 'allow'
  updatedInput?: Input        // Input co the bi modify boi hook/user
  userModified?: boolean      // User da sua input?
  decisionReason?: string     // Ly do (config, classifier, user...)
  acceptFeedback?: string     // Feedback tu user khi accept
}

// Hoi user
type AskDecision = {
  behavior: 'ask'
  message: string             // Hien thi cho user
  updatedInput?: Input
  suggestions?: PermissionUpdate[]  // Goi y rule moi
}

// Tu choi
type DenyDecision = {
  behavior: 'deny'
  message: string             // Ly do tu choi
  decisionReason: string
}
```

### 4.3 Permission Modes

| Mode | Hanh vi | Use case |
|---|---|---|
| `default` | Hoi user cho moi tool nguy hiem | Interactive CLI |
| `plan` | Chi cho phep read-only tools | Planning phase |
| `bypassPermissions` | Auto-approve tat ca | Trusted environment |
| `auto` | ML classifier quyet dinh | Advanced auto-mode |
| `dontAsk` | Tu choi tat ca | Locked down |
| `bubble` | Day len parent agent | Sub-agent mode |

### 4.4 Permission Rules Syntax

```json
{
  "permissions": {
    "allow": [
      "Bash(git *)",              // Bash commands bat dau bang "git"
      "Bash(npm test)",           // Chi npm test
      "FileRead(*)",              // Doc bat ky file nao
      "FileEdit(/src/**/*.ts)"    // Edit chi trong src/, chi file .ts
    ],
    "deny": [
      "Bash(sudo *)",            // Cam tat ca sudo
      "Bash(rm -rf *)",          // Cam rm -rf
      "FileWrite(.env)"          // Cam ghi .env
    ],
    "ask": [
      "FileEdit(/src/security/*)"  // Luon hoi khi edit security files
    ]
  }
}
```

### 4.5 Racing Pattern cho Permission

Khi hoi user, **nhieu nguon** co the tra loi dong thoi:

```
Permission Request
  |
  +-- Race 1: User Input (terminal dialog)
  +-- Race 2: Bridge Response (IDE remote approval)
  +-- Race 3: Channel Response (Telegram/iMessage)
  +-- Race 4: Hook Decision (PermissionRequest hook)
  +-- Race 5: Classifier Check (ML auto-approval)
  |
  v
ResolveOnce Guard:  Ai tra loi truoc thang
  |
  v
  const { resolve, claim } = createResolveOnce(resolve)
  // Moi racer goi claim() truoc khi resolve
  // Chi racer dau tien claim() thanh cong moi duoc resolve
  if (!claim()) return  // Da co nguoi khac resolve roi
  resolve(decision)
```

---

## 5. Hook System

### 5.1 Hook la gi?

Hooks la **automation scripts** chay tu dong tai cac diem noi trong pipeline. Tuong tu middleware trong web framework.

### 5.2 Hook Events

| Event | Khi nao fire | Use case |
|---|---|---|
| `PreToolUse` | Truoc khi tool chay | Validate, block, modify input |
| `PostToolUse` | Sau khi tool chay thanh cong | Log, audit, auto-commit |
| `PostToolUseFailure` | Sau khi tool loi | Alert, retry logic |
| `UserPromptSubmit` | User gui prompt | Filter, transform input |
| `PermissionRequest` | Dang hoi permission | Auto-approve/deny |
| `SessionStart` | Bat dau session | Init environment |
| `SessionEnd` | Ket thuc session | Cleanup, report |
| `Stop` | Agent dung lai | Verify, run tests |
| `SubagentStart` | Sub-agent duoc tao | Track, configure |
| `SubagentStop` | Sub-agent xong | Collect results |
| `TaskCreated` | Task moi | Notify, track |
| `TaskCompleted` | Task xong | Verify, chain |
| `PreCompact` | Truoc khi nen context | Save important info |
| `PostCompact` | Sau khi nen context | Restore info |
| `CwdChanged` | Doi thu muc | Re-init environment |
| `FileChanged` | File thay doi | Re-validate, rebuild |
| `ConfigChange` | Settings thay doi | Reload, re-apply |
| `InstructionsLoaded` | CLAUDE.md duoc load | Process instructions |

### 5.3 Hook Types

**Type 1: Command Hook** (chay shell command)
```json
{
  "type": "command",
  "command": "npm test",
  "shell": "bash",
  "timeout": 60,
  "if": "FileWrite(src/**/*.ts)",
  "statusMessage": "Running tests...",
  "async": false,
  "once": false
}
```

**Type 2: Prompt Hook** (LLM danh gia)
```json
{
  "type": "prompt",
  "prompt": "Is this bash command safe? $ARGUMENTS",
  "model": "claude-haiku-4-5",
  "timeout": 30
}
```

**Type 3: Agent Hook** (spawn agent de verify)
```json
{
  "type": "agent",
  "prompt": "Run the test suite and verify all tests pass after this change.",
  "model": "claude-sonnet-4-6",
  "timeout": 120
}
```

**Type 4: HTTP Hook** (goi webhook)
```json
{
  "type": "http",
  "url": "https://api.example.com/webhook",
  "headers": { "Authorization": "Bearer $TOKEN" },
  "allowedEnvVars": ["TOKEN"],
  "timeout": 10
}
```

**Type 5: Function Hook** (inline JS/TS — zero-overhead, in-process)
```json
{
  "type": "function",
  "handler": "./hooks/validate-bash.ts",
  "timeout": 5
}
```
Hoac inline:
```json
{
  "type": "function",
  "inline": "if (input.command.includes('sudo')) return { decision: 'deny' }; return { decision: 'pass' }",
  "timeout": 5
}
```

> **Canonical hook types (5):** command, prompt, agent, http, function.
> Pipeline (chain hooks) khong phai type rieng — dung array of hooks trong config.

### 5.4 Hook Execution Pipeline

```
Event fires (e.g. PreToolUse)
  |
  v
Filter hooks by:
  1. Event name match
  2. Matcher pattern match (regex/string)
  3. "if" condition match (permission rule syntax)
  |
  v
Execute matched hooks (async generator - yield ngay khi co ket qua):
  |
  v
Parse output:
  +-- Plain text --> message/context
  +-- JSON --> structured decision
  |
  v
Aggregate results:
  {
    message?: string                     // Message hien thi
    blockingError?: string               // Loi chan tool
    preventContinuation?: boolean        // Dung agent loop
    permissionBehavior?: 'allow' | 'deny' | 'ask'  // Quyet dinh permission
    updatedInput?: Record<string, any>   // Input da modify
    additionalContexts?: string[]        // Context bo sung
    stopReason?: string                  // Ly do dung
  }
```

### 5.5 Hook JSON Output Schema

Hook co the tra ve JSON de dieu khien harness:

```typescript
// Output chung
{
  "continue": true,               // false = dung agent loop
  "suppressOutput": false,         // An output
  "stopReason": "tests failed",   // Ly do dung
  "decision": "approve",           // "approve" | "block"
  "reason": "command is safe",
  "systemMessage": "Note: ...",    // Inject vao system context
}

// Output cho PreToolUse
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",        // "allow" | "deny" | "ask"
    "permissionDecisionReason": "...",
    "updatedInput": { "command": "..." }, // Modify tool input
    "additionalContext": "..."
  }
}

// Output cho PostToolUse
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Tests passed.",
    "updatedMCPToolOutput": { ... }       // Modify tool result
  }
}

// Output cho PermissionRequest
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": { ... },
      "updatedPermissions": [...]
    }
  }
}
```

### 5.6 Trust Gate

```typescript
// TAT CA hooks bi block cho den khi user accept trust dialog
function shouldSkipHookDueToTrust(): boolean {
  if (isNonInteractiveSession()) return false   // SDK: implicit trust
  return !checkHasTrustDialogAccepted()         // Interactive: phai accept
}
```

---

## 6. Context Construction

### 6.1 Cau truc System Prompt

```
System Prompt = [
  Default System Prompt           // Core instructions, tool descriptions
    |-- Cached sections           // Khong doi giua cac turn
    |-- Volatile sections         // Tinh lai moi turn (e.g. AFK mode)
  + Memory Mechanics Prompt       // CLAUDE.md instructions (SDK only)
  + Append System Prompt          // Policy injection (caller-provided)
]

User Context = {
  claudeMd: string                // Noi dung CLAUDE.md files
  currentDate: string             // "Today's date is 2026-04-14"
}

System Context = {
  gitStatus: string               // Branch, recent commits, status
  cacheBreaker?: string           // Break prompt cache khi can
}
```

### 6.2 System Prompt Section Caching

```typescript
// Cached (tinh 1 lan, dung cho den khi /clear hoac /compact)
systemPromptSection('environment', () => {
  return `Platform: ${os.platform()}, Shell: bash, CWD: ${cwd}`
})

// Volatile (tinh lai MOI turn -- break prompt cache)
DANGEROUS_uncachedSystemPromptSection('afk_mode', () => {
  return isAfkMode() ? 'User is AFK, proceed autonomously' : null
}, 'AFK mode can change between turns')
```

**Cache lifecycle:**
```
Session start --> compute all sections --> cache
  |
  v
Turn 1: dung cache (prompt cache hit)
Turn 2: dung cache (prompt cache hit)
  |
  v
/compact hoac /clear --> clearSystemPromptSections() --> re-compute
  |
  v
Turn 3: compute lai (prompt cache miss, nhung cap nhat)
Turn 4: dung cache moi (prompt cache hit)
```

### 6.3 CLAUDE.md Loading

```
Scan hierarchy:
  ~/.claude/CLAUDE.md                 (global user)
  <project>/.claude/CLAUDE.md         (project)
  <project>/.claude/memory/*.md       (extracted memories)
  |
  v
Filter:
  - .claude-ignore patterns
  - Injected memory files excluded
  - Max 200 lines, 25KB per file
  |
  v
Concat --> setCachedClaudeMdContent() --> inject vao userContext.claudeMd
```

### 6.4 Assembly Point

```typescript
async function fetchSystemPromptParts(params) {
  const [systemPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(tools, model, mcpClients),  // Tool descriptions, instructions
    getUserContext(),                             // CLAUDE.md, date
    getSystemContext(),                           // Git status
  ])
  return { systemPrompt, userContext, systemContext }
}

// Final API call:
callLLM({
  system: asSystemPrompt(
    appendSystemContext(systemPrompt, systemContext)  // System + git
  ),
  messages: prependUserContext(messages, userContext), // CLAUDE.md prepended
  tools: [...],
  ...
})
```

---

## 7. State Management

### 7.1 2 lop state

```
Layer 1: AppState (React-like, UI + session state)
  - Immutable snapshot
  - Updated qua setState(updater)
  - Subscribers duoc notify khi thay doi
  - Chua: settings, tasks, MCP, plugins, permissions, agents, UI state

Layer 2: Bootstrap State (Module-level singleton)
  - Mutable globals
  - Session identity (sessionId, cwd, projectRoot)
  - Telemetry counters
  - System prompt cache
  - Auth state
```

### 7.2 Store Pattern

```typescript
type Store<T> = {
  getState: () => T
  setState: (updater: (prev: T) => T) => void
  subscribe: (listener: () => void) => () => void  // Returns unsubscribe
}

function createStore<T>(initialState: T, onChange?: OnChange<T>): Store<T> {
  let state = initialState
  const listeners = new Set<() => void>()

  return {
    getState: () => state,
    setState: (updater) => {
      const prev = state
      const next = updater(prev)
      if (Object.is(next, prev)) return     // Identity check: skip no-op
      state = next
      onChange?.({ newState: next, oldState: prev })
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
```

**Key:** Dung `Object.is()` de check identity — neu updater return cung object thi khong trigger re-render.

### 7.3 State Change Side Effects

```typescript
function onChangeAppState({ newState, oldState }) {
  // Permission mode changed --> notify IDE, notify SDK
  if (newState.permissionMode !== oldState.permissionMode) {
    notifySessionMetadataChanged()
    notifyPermissionModeChanged()
  }

  // Model changed --> update settings file
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    updateSettingsForSource('model', newState.mainLoopModel)
  }

  // Settings changed --> clear auth caches, re-apply env vars
  if (newState.settings !== oldState.settings) {
    clearApiKeyHelperCache()
    applyConfigEnvironmentVariables()
  }
}
```

### 7.4 AppState Shape (key fields)

```typescript
type AppState = {
  // Settings & config
  settings: SettingsJson

  // Model & thinking
  mainLoopModel: string | undefined
  thinkingEnabled: boolean

  // Permission
  toolPermissionContext: {
    mode: PermissionMode
    denials: Map<string, Denial>
    permissions: PermissionRule[]
  }

  // Tasks
  tasks: { [taskId: string]: TaskState }

  // MCP
  mcp: {
    clients: MCPConnection[]
    tools: Tool[]
    commands: Command[]
    resources: Record<string, Resource>
  }

  // Plugins
  plugins: {
    enabled: Plugin[]
    disabled: Plugin[]
    commands: Command[]
    errors: Error[]
  }

  // Agents
  agentNameRegistry: Map<string, AgentId>
  agentDefinitions: AgentDefinition[]

  // Session
  sessionHooks: Map<string, Hook>
  fileHistory: FileHistory
  notifications: Notification[]
}
```

---

## 8. Session Persistence

### 8.1 Transcript Storage

```
~/.claude/projects/<project-hash>/
  ├── <session-id>.jsonl            # Main conversation transcript
  ├── <session-id>/
  │   └── subagents/
  │       ├── agent-<id-1>.jsonl    # Sub-agent 1 transcript
  │       └── agent-<id-2>.jsonl    # Sub-agent 2 transcript
  └── ...
```

**Format:** JSONL (1 JSON object per line), moi line la 1 Message.

### 8.2 Transcript Entry Types

```typescript
// Conversation messages (persist & replay)
type TranscriptMessage =
  | UserMessage          // User input, tool_result
  | AssistantMessage     // LLM response
  | AttachmentMessage    // File attachments
  | SystemMessage        // System info, compact boundary

// Ephemeral progress (persist nhung KHONG replay)
type ProgressEntry =
  | BashProgress         // Bash output streaming
  | PowerShellProgress
  | MCPProgress
  | SleepProgress        // KAIROS only
```

### 8.3 Agent Metadata

```typescript
type AgentMetadata = {
  agentType: string           // Loai agent (fork, coordinator, custom...)
  worktreePath?: string       // Neu agent dung worktree isolation
  description?: string        // Mo ta task ban dau
}

// Luu kem transcript de co the resume
await writeAgentMetadata(agentId, metadata)
const meta = await readAgentMetadata(agentId)
```

---

## 9. Context Window Management

### 9.1 Van de

LLM co context window gioi han (e.g. 200K tokens). Khi conversation dai, phai **nen lai** de khong vuot qua.

### 9.2 Cac chien luoc nen

```
1. Auto-Compact (tu dong)
   - Threshold: contextWindow - maxOutputTokens - 13,000 buffer
   - Khi input tokens vuot threshold --> summarize conversation
   - Guard: khong compact khi dang compact (tranh recursion)

2. Reactive Compact (phan ung)
   - Khi API tra ve 413 (prompt too long)
   - Aggressive hon auto-compact
   - Chi thu 1 lan (hasAttemptedReactiveCompact)

3. Snip (cat bot)
   - Cat bot tool results qua lon
   - Giu lai summary thay vi full output

4. Microcompact (API-level)
   - Gui context_management params cho API
   - API tu quyet dinh cat gi

5. Context Collapse (marble_origami)
   - Agent chuyen dung de nen context
   - Dung model nhe hon
```

### 9.3 Compaction Process

```
Conversation messages (200K tokens)
  |
  v
Strip images --> [image] placeholders
Strip reinjected attachments
  |
  v
Summarize qua LLM (model nhe)
  |
  v
Insert compact_boundary SystemMessage
  |
  v
Post-compact cleanup:
  +-- Re-inject 5 most-accessed files (truncated)
  +-- Re-inject recent skills (max 25K tokens, 5K per skill)
  +-- Re-discover tools (ToolSearchTool)
  +-- Re-enumerate agents
  |
  v
New messages: [compact_boundary, restored_context, ...]
(~20K tokens thay vi 200K)
```

### 9.4 Thresholds

```typescript
const AUTOCOMPACT_BUFFER_TOKENS = 13_000
const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
const POST_COMPACT_MAX_FILES_TO_RESTORE = 5
const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000
const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000

function getAutoCompactThreshold(model: string): number {
  const effective = getContextWindowSize(model) - getMaxOutputTokens(model)
  return effective - AUTOCOMPACT_BUFFER_TOKENS
}
```

---

## 10. Streaming Infrastructure

### 10.1 Tai sao Streaming?

- User thay response ngay (UX tot hon)
- Tools bat dau chay ngay khi LLM van dang suy nghi
- Token tracking real-time
- Cancel bat ky luc nao

### 10.2 Streaming Event Types

```typescript
type StreamEvent =
  | { type: 'message_start', usage: Usage }
  | { type: 'content_block_start', content_block: ContentBlock }
  | { type: 'content_block_delta', delta: Delta }
  | { type: 'content_block_stop' }
  | { type: 'message_delta', usage: Usage, delta: { stop_reason } }
  | { type: 'message_stop' }

type RequestStartEvent = { type: 'request_start' }  // Synthetic
```

### 10.3 Consumption Pattern

```typescript
async function* consumeStream(stream) {
  let currentUsage = { input_tokens: 0, output_tokens: 0 }
  let toolUseBlocks = []

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start':
        currentUsage = updateUsage(currentUsage, event.usage)
        break

      case 'content_block_start':
        if (event.content_block.type === 'tool_use') {
          // Tool bat dau --> co the start execution ngay
          yield { type: 'tool_use_start', block: event.content_block }
        }
        break

      case 'content_block_delta':
        yield { type: 'text_delta', text: event.delta.text }
        break

      case 'message_delta':
        currentUsage = updateUsage(currentUsage, event.usage)
        if (event.delta.stop_reason) {
          yield { type: 'stop', reason: event.delta.stop_reason }
        }
        break

      case 'message_stop':
        totalUsage = accumulateUsage(totalUsage, currentUsage)
        break
    }
  }
}
```

### 10.4 API Call Pattern

```typescript
const result = await anthropic.beta.messages
  .create({
    model: normalizedModel,
    messages: messages,
    system: systemPrompt,
    tools: toolSchemas,
    stream: true,              // LUON bat
    max_tokens: maxOutputTokens,
    temperature: thinkingEnabled ? undefined : 1,
    thinking: thinkingConfig,
    speed: fastMode ? 'fast' : undefined,
    betas: ['thinking-2025-04-15', 'prompt-caching-2024-07-31'],
    metadata: { user_id },
  }, {
    signal: abortController.signal,
    headers: { 'X-Client-Request-Id': requestId },
  })
  .withResponse()
```

---

## 11. Retry va Fallback

### 11.1 Retry Strategy

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries: number
    fallbackModel?: string
    onRetry?: (error, attempt) => void
  }
): Promise<T> {
  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (isRetryable(error) && attempt < options.maxRetries) {
        await backoff(attempt)
        options.onRetry?.(error, attempt)
        continue
      }
      throw error
    }
  }
}
```

### 11.2 Error Handling Matrix

| Error | Status | Action | Max Retries |
|---|---|---|---|
| Rate limit | 429 | Retry with exponential backoff | 3 |
| Overloaded | 529 | Retry with backoff | 3 (MAX_529_RETRIES) |
| Auth expired | 401 | Refresh OAuth token, retry | 1 |
| Prompt too long | 413 | Reactive compact, retry | 1 |
| Capacity | 503 | Switch to fallbackModel | 1 |
| Max output tokens | - | Escalate 8k->64k, inject continue msg | 3 |
| Fast mode fail | - | Cooldown, disable fast mode | 1 |
| Bedrock auth | - | Refresh AWS credentials | 1 |
| Network | - | Retry with backoff | 3 |

### 11.3 Fallback Model Pattern

```typescript
try {
  await callAPI({ model: 'claude-opus-4-6' })
} catch (error) {
  if (isCapacityError(error) && fallbackModel) {
    throw new FallbackTriggeredError(fallbackModel)
    // Caller catches va retry voi fallbackModel
  }
  throw error
}
```

---

## 12. Multi-Agent Coordination

### 12.1 Agent Types

```
1. Fork Agent (implicit delegation)
   - Ke thua context tu parent
   - Tools giong het parent
   - Permission mode: 'bubble' (day len parent)
   - Cache-friendly (dung placeholder giong nhau)

2. Named Agent (teammate)
   - Co ten rieng, co the nhan tin qua SendMessage
   - Tools rieng, system prompt rieng
   - Permission mode rieng

3. Coordinator Agent
   - Khong tu thuc thi, chi dieu phoi workers
   - Spawn workers qua AgentTool
   - Thu thap ket qua va tong hop
   - Workers chay parallel (research) hoac serial (edit cung files)

4. Worktree Agent (isolated)
   - Git worktree rieng (code isolation)
   - Khong anh huong working directory chinh
   - Tu dong cleanup neu khong co thay doi
```

### 12.2 Agent Tool Input

```typescript
const agentInput = z.object({
  description: z.string(),          // Mo ta ngan (3-5 tu)
  prompt: z.string(),               // Task chi tiet
  subagent_type: z.string().optional(),  // Loai agent
  model: z.enum(['sonnet', 'opus', 'haiku']).optional(),
  run_in_background: z.boolean().optional(),
  isolation: z.enum(['worktree', 'remote']).optional(),
  name: z.string().optional(),      // Ten (cho teammate)
  team_name: z.string().optional(),
  mode: z.string().optional(),      // Permission mode
})
```

### 12.3 Fork Pattern (Cache-Friendly)

```
Parent conversation: [msg1, msg2, ..., assistant(tool_use_A, tool_use_B)]
  |
  v
Fork child A:
  messages = [
    msg1, msg2, ...,
    assistant(tool_use_A, tool_use_B),     // GIU NGUYEN tat ca tool_use
    user([
      tool_result_A: "Fork started — processing in background",  // PLACEHOLDER
      tool_result_B: "Fork started — processing in background",  // PLACEHOLDER
      directive: "Execute task A..."
    ])
  ]

Fork child B:
  messages = [
    msg1, msg2, ...,
    assistant(tool_use_A, tool_use_B),     // GIONG HET child A
    user([
      tool_result_A: "Fork started — processing in background",  // GIONG HET
      tool_result_B: "Fork started — processing in background",  // GIONG HET
      directive: "Execute task B..."         // CHI KHAC directive
    ])
  ]

--> Prompt cache hit: ca 2 fork share ~95% prefix
```

### 12.4 Coordinator Mode

```
Coordinator (main agent)
  |
  |-- spawn Worker 1: "Research authentication patterns"
  |-- spawn Worker 2: "Research database schema"
  |     (parallel: research khong conflict)
  |
  |-- wait for results
  |
  |-- spawn Worker 3: "Implement auth module" (based on Worker 1 results)
  |-- spawn Worker 4: "Implement db module" (based on Worker 2 results)
  |     (serial per file set: edit co the conflict)
  |
  |-- verify all changes
  +-- synthesize final response

Task Notification Format (worker -> coordinator):
  <task-notification>
    <task-id>agent-123</task-id>
    <status>completed</status>
    <summary>Implemented auth module with JWT tokens</summary>
    <result>Full text response from worker</result>
    <usage>
      <total_tokens>15000</total_tokens>
      <tool_uses>8</tool_uses>
      <duration_ms>45000</duration_ms>
    </usage>
  </task-notification>
```

---

## 13. Command va Skill System

### 13.1 Command Types

```typescript
// Type 1: Prompt Command (expand thanh LLM prompt)
type PromptCommand = {
  type: 'prompt'
  name: string
  description: string
  getPromptForCommand(args: string, context: Context): Promise<ContentBlock[]>
  context?: 'inline' | 'fork'    // inline: expand ngay, fork: sub-agent
  agent?: string                  // Agent type khi fork
}

// Type 2: Local Command (chay JS logic truc tiep)
type LocalCommand = {
  type: 'local'
  name: string
  load(): Promise<{ call: (args, context) => Promise<Result> }>
}

// Type 3: Local JSX Command (render React component)
type LocalJSXCommand = {
  type: 'local-jsx'
  name: string
  load(): Promise<{ call: (args, context) => JSX.Element }>
}
```

### 13.2 Command Loading Pipeline

```
Sources (loaded in parallel):
  1. Bundled skills (shipped with harness)
  2. Built-in plugin skills
  3. Disk-based skills (~/.claude/skills/)
  4. Workflow commands
  5. Plugin commands
  6. Plugin skills
  7. Built-in commands (COMMANDS array)
  |
  v
Merge & Dedupe
  |
  v
Filter by:
  - isEnabled()
  - meetsAvailabilityRequirement() (subscription tier)
  - Feature gates
  |
  v
Final command list (available for /command invocation)
```

### 13.3 Skill Definition

```typescript
type BundledSkillDefinition = {
  name: string
  description: string
  aliases?: string[]
  whenToUse?: string             // Khi nao LLM nen goi skill nay
  argumentHint?: string          // Goi y args cho user
  allowedTools?: string[]        // Gioi han tools cho skill
  model?: string                 // Override model
  hooks?: HooksSettings          // Hooks rieng cho skill
  context?: 'inline' | 'fork'
  agent?: string
  files?: Record<string, string> // Reference files

  getPromptForCommand(
    args: string,
    context: ToolUseContext
  ): Promise<ContentBlock[]>
}
```

### 13.4 Skill Tool (LLM-invocable)

Khi LLM muon goi 1 skill, no dung `SkillTool`:
```
LLM --> SkillTool({ skill: "commit", args: "-m 'fix bug'" })
  |
  v
findCommand("commit") --> getPromptForCommand("-m 'fix bug'", context)
  |
  v
Expand prompt --> inject vao conversation
  |
  v
LLM tiep tuc xu ly voi prompt da expand
```

---

## 14. Bootstrap Sequence

### 14.1 Startup Order

```
Phase 1: Pre-import (parallel I/O)
  |-- startMdmRawRead()          // macOS MDM / Windows Registry
  |-- startKeychainPrefetch()    // OAuth + API key
  |-- (module imports ~135ms)
  |
  v
Phase 2: Parse & Load
  |-- Parse CLI args (--model, --settings, --remote...)
  |-- Load settings from disk (5-level merge)
  |-- Init GrowthBook (feature flags)
  |-- Init telemetry (Statsig)
  |
  v
Phase 3: Trust & Auth
  |-- Check trust dialog (interactive mode only)
  |-- Load API key / OAuth token
  |
  v
Phase 4: Extensions
  |-- Load managed plugins
  |-- Load MCP servers (official + user + plugins)
  |-- Load skills (bundled + disk + plugins)
  |
  v
Phase 5: Assembly
  |-- Assemble tool pool (built-in + MCP + plugin + dynamic)
  |-- Load agent definitions
  |-- Initialize permission system
  |
  v
Phase 6: State & Render
  |-- Create AppState + Store
  |-- Render REPL (interactive) or run headless/SDK
  |
  v
Phase 7: Deferred (non-blocking, parallel)
  |-- initUser()
  |-- getUserContext() (CLAUDE.md, date)
  |-- prefetchSystemContextIfSafe() (git status)
  |-- getRelevantTips()
  |-- countFilesRoundedRg()
  |-- settingsChangeDetector.initialize()
```

### 14.2 Settings Hierarchy

```
Priority (thap -> cao):
  1. userSettings        ~/.claude/settings.json
  2. projectSettings     <project>/.claude/settings.json
  3. localSettings       <project>/.claude/settings.local.json
  4. flagSettings        --settings CLI flag
  5. policySettings      MDM / enterprise (read-only, cao nhat)
```

### 14.3 Tool Registration

```
Tool Pool = [
  ...builtInTools,       // Bash, FileRead, FileWrite, Grep, Glob...
  ...mcpTools,           // Tu MCP servers
  ...pluginTools,        // Tu plugins
  ...dynamicTools,       // Agent, SendMessage, REPL...
]

Filter by:
  - Permission mode (plan mode --> chi read-only tools)
  - User --tools allowlist
  - Policy limits
  - Feature gates
```

---

## 15. Framework Blueprint tong hop

### 15.1 Minimum Viable Harness

De xay 1 outer harness co ban, can cac thanh phan sau:

```
Layer 1: Core Loop
  [x] Agent Loop (while true + tool execution)
  [x] Message Threading (user -> assistant -> tool_result -> ...)
  [x] Terminal Detection (khong co tool_use = done)
  [x] Streaming Consumption

Layer 2: Tool System
  [x] Tool Interface (name, schema, call, permissions)
  [x] Tool Registry (dang ky va tim tool theo ten)
  [x] Tool Execution (serial + concurrent batching)
  [x] Tool Result Serialization

Layer 3: Safety
  [x] Permission Engine (allow/deny/ask rules)
  [x] Permission Modes (default, plan, bypass)
  [x] Input Validation (Zod schemas)

Layer 4: Context
  [x] System Prompt Builder
  [x] Context Window Tracking
  [x] Auto-Compaction (summarize khi qua dai)
```

### 15.2 Production Harness (full)

Them cac thanh phan nang cao:

```
Layer 5: Hooks & Automation
  [ ] Hook Engine (event -> filter -> execute -> aggregate)
  [ ] 5 hook types (command, prompt, agent, http, function)
  [ ] Hook Events (PreToolUse, PostToolUse, Stop...)

Layer 6: State & Persistence
  [ ] State Store (immutable, identity-based change detection)
  [ ] Session Transcript (JSONL)
  [ ] Session Resume

Layer 7: Recovery
  [ ] Retry with backoff (429, 529)
  [ ] Fallback model
  [ ] Auth refresh
  [ ] Max output tokens escalation
  [ ] Prompt too long recovery

Layer 8: Multi-Agent
  [ ] Sub-agent spawning (AgentTool)
  [ ] Fork pattern (cache-friendly)
  [ ] Coordinator mode
  [ ] Task distribution & result collection

Layer 9: Extensions
  [ ] Plugin system
  [ ] Skill system
  [ ] MCP integration
  [ ] Custom commands

Layer 10: Configuration
  [ ] Settings hierarchy (user > project > policy)
  [ ] Environment variables
  [ ] CLAUDE.md memory files
  [ ] Keybindings
  [ ] Themes & output styles
```

### 15.3 Implementation Roadmap

```
Phase 1: Core (MVP)
  1. Implement Tool interface + registry
  2. Implement Agent Loop (while true)
  3. Implement LLM API caller (streaming)
  4. Implement basic permission check
  5. Implement message threading
  --> Co the chay agent don gian

Phase 2: Safety & UX
  6. Implement permission rules engine
  7. Implement context window tracking
  8. Implement auto-compaction
  9. Implement retry + fallback
  10. Implement session persistence
  --> Agent an toan, co the resume

Phase 3: Extensibility
  11. Implement hook engine
  12. Implement skill/command system
  13. Implement settings hierarchy
  14. Implement MCP integration
  --> Agent co the mo rong

Phase 4: Scale
  15. Implement sub-agent spawning
  16. Implement fork pattern
  17. Implement coordinator mode
  18. Implement plugin system
  --> Multi-agent system
```

### 15.4 Key Design Decisions

| Decision | Claude Code chon | Ly do | Thay the |
|---|---|---|---|
| **Loop pattern** | Async Generator (yield) | Stream events ra ngoai tu nhien | Callback, EventEmitter |
| **State** | Immutable + identity check | Don gian, hieu qua | Redux, MobX |
| **Tool concurrency** | Partition batches | Read-only song song, write tuan tu | Tat ca tuan tu, tat ca song song |
| **Compaction** | LLM summarize | Giu context quan trong | Truncate dau, sliding window |
| **Permission** | Rule-based + classifier | Flexible, co the auto | Chi hoi user, chi config |
| **Hooks** | JSON output schema | Structured decisions | Plain text, exit codes |
| **Multi-agent** | Fork with shared prefix | Prompt cache hit | Full copy, shared memory |
| **Persistence** | JSONL transcript | Append-only, streamable | SQLite, JSON file |
| **Config** | 7-level merge hierarchy | Enterprise + personal + project + CLI | Single file, env only |

### 15.5 Anti-Patterns can tranh

```
1. KHONG dung blocking API call --> Luon streaming
2. KHONG chay tat ca tools song song --> Partition read-only vs write
3. KHONG compact recursion --> Guard voi hasAttemptedReactiveCompact
4. KHONG retry vo han --> Max retries + backoff
5. KHONG trust tool input --> Validate truoc khi execute
6. KHONG hardcode model --> Config hierarchy + env var + CLI flag
7. KHONG single-agent only --> Thiet ke multi-agent tu dau
8. KHONG ignore context window --> Track tokens, compact truoc khi overflow
9. KHONG luu state trong memory --> Persist transcript, co the resume
10. KHONG monolithic hooks --> Separate event types, separate handlers
```

---

## Appendix A: File Reference

### Core Loop
| File | Vai tro |
|---|---|
| `src/QueryEngine.ts` | Entry point cho queries, manages message history |
| `src/query.ts` | Main agent loop (while true), state machine |
| `src/Tool.ts` | Tool interface definition |
| `src/services/api/claude.ts` | API call builder, streaming consumer |

### Tool System
| File | Vai tro |
|---|---|
| `src/tools/*.ts` | 40+ tool implementations |
| `src/services/tools/toolOrchestration.ts` | Concurrent/serial tool execution |

### Permission System
| File | Vai tro |
|---|---|
| `src/hooks/toolPermission/` | Permission handlers (interactive, coordinator, swarm) |
| `src/utils/permissions/permissions.ts` | Core permission decision logic |
| `src/types/permissions.ts` | Permission types & modes |

### Hook System
| File | Vai tro |
|---|---|
| `src/utils/hooks.ts` | Hook execution engine (5,023 dong) |
| `src/schemas/hooks.ts` | Hook schemas (Zod) |

### Context & Prompt
| File | Vai tro |
|---|---|
| `src/context.ts` | getUserContext, getSystemContext |
| `src/utils/queryContext.ts` | fetchSystemPromptParts assembly |
| `src/constants/systemPromptSections.ts` | Cached/volatile prompt sections |

### State & Persistence
| File | Vai tro |
|---|---|
| `src/state/store.ts` | Generic store implementation |
| `src/state/AppStateStore.ts` | AppState type + default |
| `src/state/onChangeAppState.ts` | State change side effects |
| `src/utils/sessionStorage.ts` | Transcript persistence |
| `src/bootstrap/state.ts` | Module-level singleton state |

### Context Window
| File | Vai tro |
|---|---|
| `src/services/compact/autoCompact.ts` | Auto-compact thresholds & decisions |
| `src/services/compact/compact.ts` | Compaction process |
| `src/services/compact/postCompactCleanup.ts` | Post-compact context restoration |

### Multi-Agent
| File | Vai tro |
|---|---|
| `src/tools/AgentTool/AgentTool.tsx` | Agent spawning tool |
| `src/tools/AgentTool/forkSubagent.ts` | Fork pattern implementation |
| `src/tools/AgentTool/runAgent.ts` | Agent execution |
| `src/coordinator/coordinatorMode.ts` | Coordinator mode logic |

### Retry & Fallback
| File | Vai tro |
|---|---|
| `src/services/api/withRetry.ts` | Retry logic, fallback model |
| `src/services/api/client.ts` | API client creation (4 providers) |

### Config & Bootstrap
| File | Vai tro |
|---|---|
| `src/main.tsx` | Bootstrap sequence |
| `src/utils/settings/settings.ts` | Settings hierarchy merge |
| `src/utils/settings/types.ts` | Settings schema (Zod) |
| `src/utils/auth.ts` | Auth loading priority |
| `src/utils/model/model.ts` | Model selection priority |
| `src/utils/model/configs.ts` | Model definitions |
| `src/utils/model/providers.ts` | Provider selection |

### Command & Skill
| File | Vai tro |
|---|---|
| `src/commands.ts` | Command registry & dispatch |
| `src/skills/bundledSkills.ts` | Bundled skill registry |
| `src/types/command.ts` | Command type hierarchy |

# Knowledge Base: Claude Code Source Code

## 1. Tong quan

**Claude Code** (`@anthropic-ai/claude-code`) la CLI agent AI chinh thuc cua Anthropic, chay tren terminal, cho phep nguoi dung tuong tac voi Claude de thuc hien cac tac vu lap trinh: sua bug, viet code, refactor, review, quan ly git, va nhieu hon nua.

| Thong so | Chi tiet |
|---|---|
| **Ngon ngu** | TypeScript (strict mode, ESM) |
| **Runtime** | Bun >= 1.1.0 |
| **UI Terminal** | React 19 + Ink (render React trong terminal) |
| **CLI Parser** | Commander.js |
| **API** | `@anthropic-ai/sdk` (goi Claude API) |
| **Protocol** | MCP (Model Context Protocol) |
| **Validation** | Zod v4 |
| **Feature Flags** | GrowthBook |
| **Code Quality** | Biome (linter + formatter) |
| **Bundling** | esbuild (qua Bun scripts) |
| **Telemetry** | OpenTelemetry + gRPC |
| **Auth** | OAuth 2.0, JWT, macOS Keychain |
| **Shells** | Bash, PowerShell, Node REPL |
| **Quy mo** | ~1,916 file TS/TSX, ~512,000+ dong code |

### Chuc nang chinh

- **Agent AI trong terminal**: gui prompt, Claude tra loi va tu dong goi tools (doc/ghi file, chay bash, search code...)
- **40+ tools**: FileRead, FileWrite, FileEdit, Bash, Grep, Glob, WebSearch, AgentTool (sub-agent), TaskCreate...
- **50+ slash commands**: `/commit`, `/review`, `/refactor`, `/diff`, `/bughunter`, `/memory`, `/config`...
- **IDE Integration**: tich hop VS Code, JetBrains qua he thong Bridge (giao tiep bidirectional qua JWT)
- **Multi-agent**: spawn sub-agents, team management, task coordination
- **Voice mode**: nhap lieu bang giong noi
- **Plugin & Skill system**: mo rong chuc nang qua plugin/skill

---

## 2. Kien truc & Cach trien khai

### 2.1 Entry Points

| File | Vai tro |
|---|---|
| `src/entrypoints/cli.tsx` | Main CLI entrypoint (39KB). Fast-path cho `--version`, `--dump-system-prompt`. Conditional feature flags (KAIROS, COORDINATOR_MODE...) |
| `src/main.tsx` | Commander.js setup, React/Ink init, bootstrap (4,684 dong) |
| `src/QueryEngine.ts` | Core: goi LLM API, streaming, tool loops (1,297 dong) |
| `src/query.ts` | Query pipeline orchestration (1,730 dong) |
| `src/commands.ts` | Command registry and execution (758 dong) |

### 2.2 Startup Sequence (trong `main.tsx`)

```
1.  Profile checkpoint
2.  Parallel prefetch: MDM settings, keychain, API preconnect
3.  Load GrowthBook feature flags
4.  Init telemetry & analytics
5.  Register commands + tools
6.  Load plugins + skills
7.  Fetch bootstrap data
8.  Load policy limits & settings
9.  Init bridge (neu IDE mode)
10. Start REPL loop
```

### 2.3 Cau truc thu muc chinh

```
src/
├── entrypoints/       # CLI entry point
├── tools/             # 40+ tools (Bash, FileRead, Grep, Agent...)
│   ├── BashTool.ts
│   ├── FileReadTool.ts
│   ├── FileWriteTool.ts
│   ├── FileEditTool.ts
│   ├── GlobTool.ts
│   ├── GrepTool.ts
│   ├── AgentTool.ts
│   ├── WebSearchTool.ts
│   ├── WebFetchTool.ts
│   ├── TaskCreateTool.ts
│   ├── SkillTool.ts
│   ├── MCPTool.ts
│   ├── NotebookEditTool.ts
│   ├── EnterPlanModeTool.ts
│   ├── ExitPlanModeTool.ts
│   ├── EnterWorktreeTool.ts
│   ├── ExitWorktreeTool.ts
│   ├── SendMessageTool.ts
│   ├── TeamCreateTool.ts
│   ├── AskUserQuestionTool.ts
│   ├── LSPTool.ts
│   ├── BriefTool.ts
│   ├── ConfigTool.ts
│   └── ...
├── commands/          # 50+ slash commands (/commit, /review...)
│   ├── commit/
│   ├── review/
│   ├── refactor/
│   ├── diff/
│   ├── bughunter/
│   ├── config/
│   ├── init/
│   ├── doctor/
│   ├── memory/
│   ├── context/
│   ├── mcp/
│   ├── ide/
│   ├── login/
│   ├── logout/
│   ├── cost/
│   ├── compact/
│   ├── export/
│   ├── effort/
│   └── ... (209 files tong cong)
├── components/        # 140+ React/Ink UI components
│   ├── Spinner.tsx
│   ├── Loading.tsx
│   ├── Success.tsx
│   ├── Error.tsx
│   ├── ApproveApiKey.tsx
│   ├── BridgeDialog.tsx
│   ├── ExportDialog.tsx
│   ├── HighlightedCode.tsx
│   ├── FileEditToolDiff.tsx
│   ├── CompactSummary.tsx
│   ├── BaseTextInput.tsx
│   ├── GlobalSearchDialog.tsx
│   ├── AgentProgressLine.tsx
│   └── IdeStatusIndicator.tsx
├── services/          # API, MCP, OAuth, LSP, Analytics, Plugins...
│   ├── api/           # Anthropic API client, files API, bootstrap, error handling
│   │   ├── client.ts        # getAnthropicClient() - tao API client
│   │   ├── claude.ts        # callAnthropicAPI() - goi API thuc te
│   │   └── withRetry.ts     # Retry & fallback logic
│   ├── mcp/           # MCP connection management, config, channel auth
│   ├── oauth/         # OAuth 2.0 authentication flows
│   ├── lsp/           # Language Server Protocol integration
│   ├── analytics/     # GrowthBook feature flags
│   ├── compact/       # Conversation context compression
│   ├── extractMemories/ # Memory extraction
│   ├── plugins/       # Plugin loading system
│   ├── policyLimits/  # Organization policy enforcement
│   └── remoteManagedSettings/ # Remote settings sync
├── hooks/             # React hooks (permissions, keybindings, input...)
│   ├── useCanUseTool.ts
│   ├── toolPermission/
│   ├── useGlobalKeybindings.ts
│   ├── useCommandKeybindings.ts
│   ├── useArrowKeyHistory.ts
│   ├── fileSuggestions/
│   ├── useIDEIntegration.ts
│   ├── useDiffInIDE.ts
│   └── useDirectConnect.ts
├── utils/             # 300+ utility files (88K+ dong)
│   ├── messages.ts          # Message creation and serialization (5,513 dong)
│   ├── sessionStorage.ts    # Session persistence (5,106 dong)
│   ├── hooks.ts             # Hook utilities (5,023 dong)
│   ├── attachments.ts       # File attachment handling (3,998 dong)
│   ├── config.ts            # Settings management (1,818 dong)
│   ├── Cursor.ts            # Shell cursor management (1,531 dong)
│   ├── auth.ts              # Authentication & API key loading
│   ├── theme.ts             # Theme definitions
│   ├── thinking.ts          # Thinking configuration
│   └── model/               # Model selection & configuration
│       ├── model.ts         # Model selection logic (priority)
│       ├── configs.ts       # Model definitions (all models, all providers)
│       ├── providers.ts     # Provider selection (Bedrock/Vertex/Foundry/Anthropic)
│       └── modelStrings.ts  # Model ID normalization per provider
├── bridge/            # IDE integration (VS Code, JetBrains)
│   ├── bridgeMain.ts        # Main loop (118KB)
│   ├── replBridge.ts        # REPL session bridge (103KB)
│   └── remoteBridgeCore.ts  # Remote bridge logic (40KB)
├── skills/            # Skill system (bundled + custom)
│   ├── bundledSkills.ts     # Skill registry
│   └── loadSkillsDir.ts     # Skill loader
├── plugins/           # Plugin system
│   └── builtinPlugins.ts    # Built-in plugin registry
├── memdir/            # CLAUDE.md memory system
│   ├── memdir.ts
│   └── memoryTypes.ts
├── state/             # App state management (React Context)
│   ├── AppState.tsx
│   ├── AppStateStore.ts
│   └── onChangeAppState.ts
├── keybindings/       # Keybinding customization
│   ├── schema.ts
│   └── loadUserBindings.ts
├── coordinator/       # Multi-agent coordination
├── tasks/             # Task management system
├── voice/             # Voice input
├── vim/               # Vim mode
├── screens/           # Full-screen UIs (Doctor, REPL)
├── context/           # React context providers
├── remote/            # Remote session management
├── types/             # TypeScript types
│   ├── message.ts
│   ├── permissions.ts
│   ├── tools.ts
│   ├── hooks.ts
│   └── command.ts
└── schemas/           # Zod schemas
    └── hooks.ts
```

### 2.4 Kien truc core - Query Pipeline

```
User Input
  |
  v
CLI Parser (Commander.js)
  |
  v
Settings Loader (plugins -> user -> project -> policy -> flags)
  |
  v
QueryEngine.ts
  |-- Gui messages den Claude API (streaming)
  |-- Claude tra ve tool_use -> Permission Check
  |-- Hook Execution (PreToolUse)
  |-- Tool Execution (Bash, FileRead, etc.)
  |-- Hook Execution (PostToolUse)
  +-- Loop cho den khi Claude ket thuc (khong con tool_use)
  |
  v
Output Styling & Theme
  |
  v
Terminal Rendering (Ink/React)
```

### 2.5 Tool System

Moi tool la mot module tu chua trong `src/tools/`:

```typescript
// Cau truc 1 tool
{
  name: string                        // Ten tool (e.g. "Bash")
  description: string                 // Mo ta cho LLM
  inputSchema: ZodSchema              // Schema input (Zod)
  isEnabled: () => boolean            // Co enable khong
  isReadOnly: () => boolean           // Co read-only khong
  needsPermission: () => boolean      // Can permission?
  call: (input, context) => Promise<Result>  // Logic thuc thi
}
```

### 2.6 Bridge System (IDE Integration)

```
IDE (VS Code / JetBrains)
  <-> JWT Authentication
  <-> JSON-RPC Protocol
  <-> bridgeMain.ts (118KB)
  <-> Permission callbacks
  <-> Claude Code CLI
```

---

## 3. Ket noi va Cau hinh Model LLM

### 3.1 Dinh nghia Model — `src/utils/model/configs.ts`

Noi khai bao tat ca model duoc ho tro, moi model co ID rieng theo tung provider:

| Model | Anthropic (firstParty) | AWS Bedrock | Google Vertex | Azure Foundry |
|---|---|---|---|---|
| Opus 4.6 | `claude-opus-4-6` | `us.anthropic.claude-opus-4-6-v1:0` | `claude-opus-4-6@version` | `claude-opus-4-6` |
| Sonnet 4.6 | `claude-sonnet-4-6` | `us.anthropic.claude-sonnet-4-6-v1:0` | `claude-sonnet-4-6@version` | `claude-sonnet-4-6` |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | ... | ... | ... |
| + cac model cu hon | | | | |

### 3.2 Chon Provider — `src/utils/model/providers.ts`

Dua vao bien moi truong, chon 1 trong 4 providers:

```
CLAUDE_CODE_USE_BEDROCK=true   -> AWS Bedrock
CLAUDE_CODE_USE_VERTEX=true    -> Google Vertex AI
CLAUDE_CODE_USE_FOUNDRY=true   -> Azure Foundry
(mac dinh)                     -> Anthropic first-party API
```

### 3.3 Chon Model — `src/utils/model/model.ts`

Thu tu uu tien (cao -> thap):

```
1. Session override   ->  /model command (AppState.mainLoopModel)
2. CLI flag           ->  --model claude-opus-4-6
3. Env var            ->  ANTHROPIC_MODEL=claude-sonnet-4-6
4. Settings           ->  settings.json -> model
5. Subscription tier  ->  Max/Team Premium -> Opus 4.6
                          Pro/Enterprise/PAYG -> Sonnet 4.6
```

Env var override cho tung tier:

| Env var | Muc dich |
|---|---|
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override model Opus |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override model Sonnet |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override model Haiku |
| `ANTHROPIC_SMALL_FAST_MODEL` | Model nhe dung cho sub-tasks |

### 3.4 Xac thuc API Key — `src/utils/auth.ts`

Thu tu uu tien tim API key:

```
1. Claude AI OAuth tokens      -> dang nhap qua /login
2. ANTHROPIC_API_KEY            -> env var truc tiep
3. ANTHROPIC_AUTH_TOKEN         -> bearer token
4. CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR -> doc tu file descriptor
5. apiKeyHelper                 -> script custom trong settings.json
6. macOS Keychain               -> stored credentials
7. Console/managed OAuth        -> enterprise
```

Voi Bedrock/Vertex/Foundry -> dung auth rieng cua cloud provider (AWS creds, GCP creds, Azure AD).

### 3.5 Tao Client — `src/services/api/client.ts`

Ham `getAnthropicClient()` tao client tuy provider:

```typescript
// AWS Bedrock
new AnthropicBedrock({ region: AWS_REGION })

// Google Vertex
new AnthropicVertex({ region: VERTEX_REGION_* || CLOUD_ML_REGION })

// Azure Foundry
new AnthropicFoundry({ resource: ANTHROPIC_FOUNDRY_RESOURCE })

// First-party (mac dinh)
new Anthropic({
  apiKey: ...,
  baseURL: ANTHROPIC_BASE_URL,        // custom endpoint neu can
  defaultHeaders: {
    'x-app': 'claude-code',
    'User-Agent': '...',
    'X-Claude-Code-Session-Id': sessionId,
    ...ANTHROPIC_CUSTOM_HEADERS        // headers tuy chinh
  }
})
```

### 3.6 Core Query Flow — `src/QueryEngine.ts` + `src/query.ts`

```
QueryEngine.ts
  |
  |-- parseUserSpecifiedModel(override) || getMainLoopModel()
  |     -> resolve model ID cuoi cung
  |
  |-- normalizeModelStringForAPI(model)
  |     -> chuyen thanh ID dung format cho provider
  |
  +-- goi callAnthropicAPI() voi model da resolve
```

### 3.7 Goi API thuc te — `src/services/api/claude.ts`

Ham `callAnthropicAPI()` build params va goi streaming:

```typescript
anthropic.beta.messages.create({
  model: normalizeModelStringForAPI(options.model),
  messages: [...],
  system: "system prompt...",
  tools: [...],
  tool_choice: "auto" | "disabled" | specific,
  max_tokens: getModelMaxOutputTokens(model),
  temperature: 1,              // tat khi thinking enabled
  stream: true,                // LUON streaming

  // Thinking (extended thinking)
  thinking: {
    type: "adaptive" | "enabled",
    budget_tokens?: number
  },

  // Fast mode
  speed?: "fast",

  // Effort level
  output_config?: { effort: "low" | "medium" | "high" },

  // Beta features
  betas: ["thinking-2025-04-15", "prompt-caching-2024-07-31", ...],

  // Context management (microcompact)
  context_management?: {...},

  metadata: { user_id: ... }
}, {
  signal: abortController,
  headers: { "X-Client-Request-Id": requestId }
}).withResponse()
```

### 3.8 Thinking Configuration — `src/utils/thinking.ts`

```
Model 4.6+ (Opus/Sonnet 4.6)  ->  adaptive thinking (khong can budget co dinh)
Model cu hon                   ->  fixed budget thinking

Env vars:
  MAX_THINKING_TOKENS=10000              -> enable thinking voi budget
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING  -> ep dung fixed budget
```

### 3.9 Retry & Fallback — `src/services/api/withRetry.ts`

```
Loi 429 (rate limit)  -> retry voi backoff
Loi 529 (overloaded)  -> retry toi da 3 lan (MAX_529_RETRIES = 3)
Loi 401               -> refresh OAuth token roi retry
Loi capacity          -> neu co fallbackModel -> chuyen sang model do
Fast mode loi         -> cooldown, tat fast mode
Bedrock auth loi      -> refresh AWS credentials
```

### 3.10 Model String Resolution — `src/utils/model/modelStrings.ts`

Chuyen doi ten model logic -> ID thuc te theo provider:

```
"claude-opus-4-6"
  |-- firstParty -> "claude-opus-4-6"
  |-- bedrock    -> "us.anthropic.claude-opus-4-6-v1:0"
  |-- vertex     -> "claude-opus-4-6@20250415"
  +-- foundry    -> "claude-opus-4-6"
```

Bedrock con ho tro inference profile auto-discovery qua AWS API.

### 3.11 Tong hop env vars lien quan den Model/LLM

| Env var | Muc dich |
|---|---|
| `ANTHROPIC_API_KEY` | API key truc tiep |
| `ANTHROPIC_AUTH_TOKEN` | Bearer token |
| `ANTHROPIC_BASE_URL` | Custom API endpoint |
| `ANTHROPIC_MODEL` | Chon model |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override model Opus |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override model Sonnet |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override model Haiku |
| `ANTHROPIC_SMALL_FAST_MODEL` | Model nhe cho sub-tasks |
| `ANTHROPIC_CUSTOM_HEADERS` | Headers tuy chinh |
| `CLAUDE_CODE_USE_BEDROCK` | Dung AWS Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Dung Google Vertex |
| `CLAUDE_CODE_USE_FOUNDRY` | Dung Azure Foundry |
| `MAX_THINKING_TOKENS` | Budget thinking tokens |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Tat adaptive thinking |
| `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR` | Key tu file descriptor |

### 3.12 So do tong the flow ket noi LLM

```
User config (settings.json / env vars / CLI flags / /model command)
  |
  v
Model Selection (src/utils/model/model.ts)
  |  resolve theo priority: session > CLI > env > settings > subscription
  |
  v
Provider Selection (src/utils/model/providers.ts)
  |  Bedrock / Vertex / Foundry / Anthropic
  |
  v
Auth Loading (src/utils/auth.ts)
  |  OAuth / API key / Keychain / cloud creds
  |
  v
Client Creation (src/services/api/client.ts)
  |  new Anthropic() / AnthropicBedrock() / AnthropicVertex() / AnthropicFoundry()
  |
  v
Model String Normalization (src/utils/model/modelStrings.ts)
  |  logical ID -> provider-specific API ID
  |
  v
QueryEngine (src/QueryEngine.ts)
  |
  v
API Call (src/services/api/claude.ts)
  |  anthropic.beta.messages.create({ stream: true, ... })
  |
  v
Retry/Fallback (src/services/api/withRetry.ts)
  |  429/529 retry, model fallback, auth refresh
  |
  v
Streaming Response -> Tool Loop -> Render UI
```

---

## 4. Cach Custom & Mo rong

### 4.1 Settings (`~/.claude/settings.json` + `.claude/settings.json`)

Thu tu uu tien (cao -> thap):

```
1. .claude/settings.local.json   (local, khong commit)
2. Enterprise Policy              (MDM, remote sync)
3. .claude/settings.json          (project, commit duoc)
4. ~/.claude/settings.json        (global user)
5. Plugin settings
6. SDK flags
```

Vi du settings.json:

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(git *)", "FileRead(*)"],
    "deny": ["Bash(sudo *)", "Bash(rm -rf *)"],
    "additionalDirectories": ["/shared/libs"]
  },
  "environment": {
    "NODE_ENV": "development"
  },
  "model": "claude-sonnet-4-6",
  "effort": "high",
  "mcpServers": {},
  "hooks": {}
}
```

Cac categories trong settings:

- **Permissions**: defaultMode, allow[], deny[], ask[], disableBypassPermissionsMode, additionalDirectories
- **MCP**: mcpServers, allowedMcpServers[], deniedMcpServers[]
- **Plugins**: enabledPlugins, extraKnownMarketplaces
- **Hooks**: event-triggered automation
- **Environment**: env vars inject vao shell
- **Sandbox**: enabled, network, filesystem
- **Agent**: agent-specific configuration
- **Model**: default LLM model
- **Effort**: response effort level ("low", "medium", "high")

File schema: `src/utils/settings/types.ts` (300+ dong, Zod schema)

### 4.2 Hooks (Automation)

Hooks chay shell commands/prompts/agents tu dong khi co events.

**Events co san**:

| Event | Khi nao |
|---|---|
| `PreToolUse` | Truoc khi tool chay |
| `PostToolUse` | Sau khi tool chay |
| `UserPromptSubmit` | Khi user gui prompt |
| `SessionStart` | Bat dau session |
| `SessionEnd` | Ket thuc session |
| `Notification` | Khi co notification |
| `TaskCreated` | Khi task duoc tao |
| `TaskCompleted` | Khi task hoan thanh |
| `TeammateIdle` | Khi teammate agent idle |
| `Stop` / `SubagentStop` | Khi stop |
| `PreCompact` / `PostCompact` | Truoc/sau nen context |

**4 loai hook**:

1. **command** — Chay shell command:
```json
{
  "type": "command",
  "command": "git status",
  "shell": "bash",
  "timeout": 30,
  "if": "Bash(git *)",
  "statusMessage": "Checking git status...",
  "async": true,
  "once": false
}
```

2. **prompt** — LLM danh gia (dung model nhe hon):
```json
{
  "type": "prompt",
  "prompt": "Is this a safe operation? $ARGUMENTS",
  "timeout": 60,
  "model": "claude-haiku-4-5-20241022"
}
```

3. **agent** — Agent day du verify:
```json
{
  "type": "agent",
  "prompt": "Verify that unit tests pass. $ARGUMENTS",
  "timeout": 120,
  "model": "claude-sonnet-4-6"
}
```

4. **http** — Goi webhook ben ngoai:
```json
{
  "type": "http",
  "url": "https://webhook.example.com/hook",
  "headers": {
    "Authorization": "Bearer $AUTH_TOKEN"
  },
  "allowedEnvVars": ["AUTH_TOKEN"]
}
```

Vi du cau hinh hooks:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Is this safe to run? $ARGUMENTS",
            "if": "Bash(sudo *)"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "FileWrite",
        "hooks": [
          {
            "type": "command",
            "command": "git add {{file}}",
            "async": true
          }
        ]
      }
    ]
  }
}
```

File schema: `src/schemas/hooks.ts`

### 4.3 CLAUDE.md (Persistent Memory)

File markdown luu context/quy uoc cho project, duoc load vao moi conversation:

```
~/.claude/CLAUDE.md     -> Global (user-level)
.claude/CLAUDE.md       -> Project-level (commit duoc)
```

Vi du:

```markdown
# Project Conventions

- Use TypeScript strict mode
- All components use functional style with hooks
- Run `bun test` before committing
- API endpoints are in src/api/

## Architecture
- Frontend: React + Vite
- Backend: Express + PostgreSQL
```

Dac diem:
- Line va byte truncation warnings (max 200 dong, 25KB)
- Auto-memory extraction tu conversations
- Team memory sync cho collaborative work
- Quan ly qua `/memory` command

Files: `src/memdir/memdir.ts`, `src/memdir/memoryTypes.ts`

### 4.4 Skills (Reusable Workflows)

16 built-in skills: `batch`, `claudeApi`, `debug`, `loop`, `simplify`, `verify`, `keybindings`, `remember`, `stuck`, `updateConfig`, `verifyContent`...

Dinh nghia 1 skill:

```typescript
{
  name: 'my-skill',
  description: 'What this skill does',
  aliases: ['ms'],
  allowedTools: ['Bash', 'FileRead'],
  model?: string,
  hooks?: HooksSettings,
  context?: 'inline' | 'fork',
  files?: Record<string, string>,
  async getPromptForCommand(args, context) {
    return [{ type: 'text', text: `Execute: ${args}` }]
  }
}
```

Goi bang: `/skill-name` hoac qua `SkillTool`

Files: `src/skills/bundledSkills.ts`, `src/skills/loadSkillsDir.ts`

### 4.5 Plugins

Mo rong bang npm packages hoac git repos:

```bash
claude plugin install @scope/my-plugin
claude plugin install github:user/repo
claude plugin enable my-plugin
claude plugin disable my-plugin
claude plugin uninstall my-plugin
```

Plugin co the cung cap: skills, hooks, MCP servers, settings.

Scopes: `user` (global `~/.claude/plugins/`), `project` (`.claude/plugins/`), `local`, `managed` (enterprise)

Cau hinh:

```json
{
  "enabledPlugins": {
    "plugin-name@npm": true,
    "git-plugin@github:user/repo": false,
    "local-plugin@builtin": true
  },
  "extraKnownMarketplaces": [
    {
      "source": {
        "type": "npm",
        "registryUrl": "https://registry.npmjs.org/"
      },
      "autoUpdate": true
    }
  ]
}
```

Files: `src/plugins/builtinPlugins.ts`, `src/services/plugins/pluginOperations.ts`, `src/utils/plugins/schemas.ts`

### 4.6 MCP Servers (Model Context Protocol)

Ket noi external tools qua MCP:

```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "db_mcp_server"],
      "env": { "DB_URL": "$DATABASE_URL" }
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com"
    }
  }
}
```

Features:
- Tool discovery va execution
- Resource browsing
- Dynamic tool loading qua `ToolSearchTool`
- Authentication qua `McpAuthTool`
- Enterprise allowlist/denylist support

File: `src/services/mcp/config.ts`

### 4.7 Keybindings (`~/.claude/keybindings.json`)

Custom phim tat theo context:

```json
{
  "bindings": [
    {
      "context": "Global",
      "bindings": {
        "ctrl+c": "app:interrupt",
        "ctrl+d": "app:exit",
        "ctrl+r": "history:search",
        "alt+p": "command:config"
      }
    },
    {
      "context": "Chat",
      "bindings": {
        "enter": "chat:submit",
        "shift+enter": "chat:newline",
        "ctrl+k": "chat:cancel",
        "alt+m": "chat:modelPicker"
      }
    }
  ]
}
```

70+ actions co san, 15+ contexts: Global, Chat, Autocomplete, Confirmation, Transcript, Task, Help, HistorySearch, Settings, DiffDialog...

Files: `src/keybindings/schema.ts`, `src/keybindings/loadUserBindings.ts`

### 4.8 Themes & Output Styles

Themes co san: `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`, `auto`

Custom Output Styles (`.claude/output-styles/concise.md`):

```markdown
---
name: Concise
description: Brief, bullet-point responses
---

Respond in short bullet points. Focus on actionable information.
```

Files: `src/utils/theme.ts`, `src/outputStyles/loadOutputStylesDir.ts`

### 4.9 Permission System

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Bash(git *)", "FileRead(*)"],
    "deny": ["Bash(sudo *)"],
    "ask": ["FileEdit(/src/security/*)"]
  }
}
```

Modes:
- `default` — hoi tung cai
- `plan` — hoi theo batch
- `bypassPermissions` — auto-approve tat ca (nguy hiem)
- `auto` — ML classifier quyet dinh (experimental)
- `dontAsk` — silent auto-approve

Rule syntax:
- `Bash(pattern)` — Bash commands
- `FileRead(path)` — File reads
- `FileWrite(path)` — File writes
- `FileEdit(path)` — File edits
- Wildcards: `*` matches anything
- Globbing: `/src/**/*.ts` cho recursive paths

File: `src/types/permissions.ts`

### 4.10 Project-level Customization

Cau truc thu muc `.claude/`:

```
.claude/
├── settings.json              # Project settings (commit duoc)
├── settings.local.json        # Machine-local overrides (khong commit)
├── CLAUDE.md                  # Project memory
├── output-styles/             # Custom output formats
│   ├── concise.md
│   └── detailed.md
├── keybindings/               # Project-specific keybindings
├── plugins/                   # Local plugins
└── memory/                    # Extracted memories
```

Git best practices:
- Commit: `settings.json`, `CLAUDE.md`, `output-styles/`
- .gitignore: `settings.local.json`, `memory/`, `plugins/`

### 4.11 Environment Variables trong settings

```json
{
  "environment": {
    "MY_VAR": "value",
    "API_KEY": "${MY_API_KEY}",
    "PROJECT_ROOT": "/path/to/project"
  }
}
```

Shell integration:
- `apiKeyHelper` — script de fetch auth values
- `awsCredentialExport` — AWS credential script
- `gcpAuthRefresh` — GCP auth refresh command

---

## 5. Bang tong hop cach Custom

| Cach custom | File/Location | Format | Pham vi |
|---|---|---|---|
| **Settings** | `settings.json` | JSON | User / Project |
| **Hooks** | `settings.json` -> `hooks` | JSON | User / Project |
| **Memory** | `CLAUDE.md` | Markdown | User / Project |
| **Skills** | Code / bundled | TS/JSON | Global |
| **Plugins** | `~/.claude/plugins/` | npm/git | User / Project |
| **MCP Servers** | `settings.json` -> `mcpServers` | JSON | User / Project |
| **Keybindings** | `keybindings.json` | JSON | User |
| **Themes** | Setting `theme` | Enum | User |
| **Output Styles** | `.claude/output-styles/` | Markdown | User / Project |
| **Permissions** | `settings.json` -> `permissions` | JSON rules | User / Project |
| **Environment** | `settings.json` -> `environment` | JSON | User / Project |
| **Model** | `settings.json` / env var / CLI flag | Multiple | User / Session |

---

## 6. Cac file quan trong nhat can doc

### Core
| File | Vai tro | Kich thuoc |
|---|---|---|
| `src/entrypoints/cli.tsx` | CLI entrypoint | 39KB |
| `src/main.tsx` | Bootstrap, Commander.js setup | 4,684 dong |
| `src/QueryEngine.ts` | Core LLM caller | 1,297 dong |
| `src/query.ts` | Query pipeline | 1,730 dong |
| `src/Tool.ts` | Tool type definitions | 794 dong |
| `src/commands.ts` | Command registry | 758 dong |

### Model & API
| File | Vai tro |
|---|---|
| `src/utils/model/configs.ts` | Danh sach model |
| `src/utils/model/model.ts` | Logic chon model |
| `src/utils/model/providers.ts` | Chon provider |
| `src/utils/model/modelStrings.ts` | Normalize model ID |
| `src/services/api/client.ts` | Tao API client |
| `src/services/api/claude.ts` | Goi API voi params |
| `src/services/api/withRetry.ts` | Retry & fallback |
| `src/utils/auth.ts` | Xac thuc |
| `src/utils/thinking.ts` | Thinking config |

### Customization
| File | Vai tro |
|---|---|
| `src/utils/config.ts` | Main config loader |
| `src/utils/settings/settings.ts` | Settings merge & loading |
| `src/utils/settings/types.ts` | Settings schema (Zod) |
| `src/schemas/hooks.ts` | Hook schema |
| `src/keybindings/schema.ts` | Keybinding schema |
| `src/memdir/memdir.ts` | Memory system |
| `src/plugins/builtinPlugins.ts` | Plugin registry |
| `src/skills/bundledSkills.ts` | Skill registry |
| `src/outputStyles/loadOutputStylesDir.ts` | Output styles |
| `src/services/plugins/pluginOperations.ts` | Plugin lifecycle |
| `src/services/mcp/config.ts` | MCP configuration |
| `src/types/permissions.ts` | Permission models |

### Bridge & IDE
| File | Vai tro | Kich thuoc |
|---|---|---|
| `src/bridge/bridgeMain.ts` | IDE main loop | 118KB |
| `src/bridge/replBridge.ts` | REPL bridge | 103KB |
| `src/bridge/remoteBridgeCore.ts` | Remote bridge | 40KB |

### Documentation
| File | Vai tro |
|---|---|
| `README.md` | Main overview |
| `docs/architecture.md` | Core pipeline, startup, state |
| `docs/bridge.md` | IDE integration |
| `docs/commands.md` | All commands reference |
| `docs/subsystems.md` | Deep dives (Bridge, MCP, Permissions...) |
| `docs/tools.md` | Tool catalog reference |
| `docs/exploration-guide.md` | Codebase navigation |

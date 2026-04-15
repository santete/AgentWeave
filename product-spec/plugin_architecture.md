# AgentWeave — Plugin Architecture

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia he thong plugin cho AgentWeave

---

## 1. Plugin la gi?

Plugin la **goi mo rong** cho AgentWeave, cho phep:
- Dang ky **custom tools** (them tool moi cho Inner Harness)
- Dang ky **custom hooks** (them automation cho Outer Harness)
- Dang ky **output interceptors** (them filter/transform cho Output Pipeline)
- Cung cap **config presets** (thiet lap san cho use case cu the)

```
Plugin = {
  tools?: ToolDefinition[]
  hooks?: HookDefinition[]
  outputInterceptors?: OutputInterceptor[]
  configPreset?: Partial<HarnessConfig>
  activate(context: PluginContext): Promise<void>
  deactivate?(): Promise<void>
}
```

---

## 2. Plugin Interface

```typescript
import type { ToolDefinition, HookDefinition, HarnessConfig } from '@agentweave/types'

/**
 * Moi plugin PHAI export default 1 object implement PluginManifest.
 */
export interface PluginManifest {
  /** Ten duy nhat (scoped: @org/plugin-name hoac plugin-name) */
  name: string

  /** Version (semver) */
  version: string

  /** Mo ta ngan */
  description: string

  /** Author */
  author?: string

  /** AgentWeave version range tuong thich */
  agentweaveVersion: string    // e.g. ">=0.1.0 <1.0.0"

  /** Khai bao quyen plugin can */
  permissions?: PluginPermissions

  /** Entry point */
  activate(context: PluginContext): Promise<PluginRegistration>

  /** Cleanup khi plugin bi tat */
  deactivate?(): Promise<void>
}

export interface PluginPermissions {
  /** Tools plugin muon dang ky */
  tools?: {
    register: string[]           // ["MyTool", "AnotherTool"]
    builtinAccess?: string[]     // Built-in tools plugin can truy cap ["Bash", "FileRead"]
  }
  /** Hook events plugin muon listen */
  hooks?: {
    events: string[]             // ["PreToolUse", "PostToolUse", "SessionEnd"]
  }
  /** Output stages plugin muon intercept */
  output?: {
    stages: string[]             // ["filter", "transform"]
  }
  /** Network access */
  network?: {
    domains: string[]            // ["api.example.com"]
  }
  /** File system access (ngoai project root) */
  filesystem?: {
    read?: string[]              // ["/etc/hosts"]
    write?: string[]             // Thuong khong cho phep
  }
}

export interface PluginContext {
  /** AgentWeave version */
  version: string
  /** Project root */
  projectRoot: string
  /** Plugin data directory (persistent) */
  dataDir: string                // ~/.agentweave/plugins/<plugin-name>/
  /** Logger (scoped to plugin) */
  logger: PluginLogger
  /** Config (read-only, plugin co the doc config cua project) */
  config: Readonly<HarnessConfig>
  /** Event bus (subscribe only — plugin khong emit events cua Inner) */
  events: {
    subscribe(type: string, handler: (event: unknown) => void): () => void
  }
}

export interface PluginRegistration {
  tools?: ToolDefinition[]
  hooks?: Array<{
    event: string
    matcher?: string
    definition: HookDefinition
  }>
  outputInterceptors?: Array<{
    stage: 'validate' | 'filter' | 'transform'
    handler: (output: unknown, context: unknown) => Promise<unknown>
  }>
  configOverrides?: Partial<HarnessConfig>
}
```

---

## 3. Plugin Discovery & Installation

### 3.1 Installation Methods

```bash
# Tu npm
agentweave plugin add @agentweave/plugin-eslint

# Tu git
agentweave plugin add github:user/plugin-repo

# Tu local path (development)
agentweave plugin add ./my-plugin

# Tu agentweave registry (tuong lai)
agentweave plugin add eslint-autofix
```

### 3.2 Plugin Config

```yaml
# .agentweave/config.yaml
plugins:
  # Enable/disable
  "@agentweave/plugin-eslint":
    enabled: true
    config:
      rules: "recommended"
      autoFix: true

  "my-custom-plugin":
    enabled: true
    source: "./plugins/my-custom-plugin"  # Local path

  "@company/security-scanner":
    enabled: true
    config:
      scanLevel: "strict"
```

### 3.3 Plugin Resolution Order

```
1. Built-in plugins (shipped voi AgentWeave)
2. Project plugins (.agentweave/plugins/)
3. User plugins (~/.agentweave/plugins/)
4. npm plugins (node_modules/)

Conflict resolution: plugin co priority cao hon override thap hon.
Neu 2 plugins dang ky tool cung ten --> error (plugin load fail).
```

---

## 4. Plugin Isolation & Trust

### 4.1 Trust Model

```
Level          Isolation        Trust        Use case
-------------- ---------------  -----------  ----------------------------
built-in       None (in-proc)   Full trust   Shipped voi AgentWeave
project        Sandboxed        Review req   Team plugins (committed to repo)
user           Sandboxed        User trust   Personal plugins
npm            Sandboxed        Verify req   Third-party plugins
```

### 4.2 Sandbox Constraints

Plugins chay trong **restricted context**:

```
CHO PHEP:
  - Dang ky tools, hooks, interceptors (qua PluginRegistration)
  - Doc config (read-only)
  - Subscribe events (listen-only)
  - Ghi file trong plugin data dir (~/.agentweave/plugins/<name>/)
  - Network access toi declared domains (permissions.network.domains)
  - Import tu node_modules (cua plugin)

KHONG CHO PHEP:
  - Modify core AgentWeave config
  - Access file system ngoai project root + plugin data dir
  - Spawn processes (tru khi khai bao trong permissions)
  - Override Permission Engine rules (chi bo sung)
  - Override Policy rules (immutable)
  - Emit gia Inner events
  - Access other plugin's data dir
```

### 4.3 Trust Dialog

Khi plugin moi duoc add, user thay trust dialog:

```
Plugin "@company/security-scanner" v1.2.0 requests:
  Tools:    Register "SecurityScan" tool
  Hooks:    Listen to PostToolUse, SessionEnd
  Network:  api.company.com
  Files:    Read /etc/ssl/certs (ngoai project)

[Trust & Enable] [Review Source] [Deny]
```

---

## 5. Plugin Lifecycle

```
1. DISCOVER    agentweave plugin add <source>
                 |
                 v
2. INSTALL     Download, validate manifest, check version compat
                 |
                 v
3. TRUST       Show trust dialog (first time only)
                 |
                 v
4. LOAD        Import plugin module, validate permissions
                 |
                 v
5. ACTIVATE    Call plugin.activate(context) --> PluginRegistration
                 |-- Register tools with ToolRegistry
                 |-- Register hooks with HookEngine
                 |-- Register interceptors with OutputPipeline
                 |
                 v
6. RUNNING     Plugin active, receiving events, tools available
                 |
                 v
7. DEACTIVATE  Call plugin.deactivate() (on session end or plugin disable)
                 |-- Unregister all tools, hooks, interceptors
                 |-- Cleanup resources
```

---

## 6. Vi du Plugin

### 6.1 ESLint Auto-fix Plugin

```typescript
// @agentweave/plugin-eslint/index.ts
import type { PluginManifest, PluginContext } from '@agentweave/types'

const plugin: PluginManifest = {
  name: '@agentweave/plugin-eslint',
  version: '0.1.0',
  description: 'Auto-run ESLint after agent writes TypeScript files',
  agentweaveVersion: '>=0.1.0',

  permissions: {
    hooks: { events: ['PostToolUse'] },
  },

  async activate(ctx: PluginContext) {
    return {
      hooks: [{
        event: 'PostToolUse',
        matcher: 'FileWrite|FileEdit',
        definition: {
          type: 'command',
          command: "jq -r '.tool_input.file_path // .tool_response.filePath' | { read -r f; [[ \"$f\" == *.ts ]] && npx eslint --fix \"$f\" || true; }",
          timeout: 15,
          async: true,
        },
      }],
    }
  },
}

export default plugin
```

### 6.2 Cost Alert Plugin

```typescript
const plugin: PluginManifest = {
  name: 'cost-alert',
  version: '0.1.0',
  description: 'Send Slack alert when session cost exceeds threshold',
  agentweaveVersion: '>=0.1.0',

  permissions: {
    hooks: { events: ['BudgetWarning'] },
    network: { domains: ['hooks.slack.com'] },
  },

  async activate(ctx) {
    const webhookUrl = ctx.config.plugins?.['cost-alert']?.config?.slackWebhook

    return {
      hooks: [{
        event: 'BudgetWarning',
        definition: {
          type: 'http',
          url: webhookUrl,
          method: 'POST',
          body: '{"text": "Agent budget warning: session cost approaching limit"}',
          timeout: 5,
        },
      }],
    }
  },
}

export default plugin
```

---

## 7. MVP Scope

Cho MVP, plugin system chi can:

| Feature | MVP | Post-MVP |
|---|---|---|
| Plugin manifest interface | Co | |
| activate/deactivate lifecycle | Co | |
| Register tools | Co | |
| Register hooks | Co | |
| Register output interceptors | | Co |
| Plugin from local path | Co | |
| Plugin from npm | Co | |
| Plugin from git | | Co |
| Trust dialog | Don gian (terminal) | Rich UI |
| Sandbox isolation | Basic (permission check) | Full sandbox (VM) |
| Plugin registry (marketplace) | | Co |
| Plugin versioning & update | | Co |
| Plugin config UI | | Co |

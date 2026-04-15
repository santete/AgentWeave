# AgentWeave — Gateway Authentication & RBAC

> Version: 0.1 Draft
> Date: 2026-04-15
> Muc dich: Dinh nghia auth, authorization, va data privacy cho Gateway Node

---

## 1. Authentication

### 1.1 Auth Methods (theo topology)

| Topology | Method | Token Type | Lifetime | Refresh |
|---|---|---|---|---|
| Team | API Key hoac JWT | Bearer token | 24h | auth:refresh message |
| Enterprise | mTLS | Client certificate | 1 year | CA re-issue |
| CI/CD | Service Account | API Key | Configurable | Manual rotate |

### 1.2 JWT Token Structure

```json
{
  "sub": "user_456",
  "iss": "agentweave-gateway",
  "aud": "agentweave-client",
  "iat": 1713100800,
  "exp": 1713187200,
  "scope": {
    "role": "developer",
    "teams": ["frontend", "platform"],
    "projects": ["proj_web", "proj_api"]
  }
}
```

### 1.3 Auth Flow

```
Developer                    Gateway                      Auth Provider
    |                           |                              |
    |--- agentweave login ----->|                              |
    |                           |--- validate credentials ---->|
    |                           |<--- JWT token ---------------|
    |<--- token stored locally--|                              |
    |    (~/.agentweave/auth)   |                              |
    |                           |                              |
    |--- AWOCP connect ------->|                              |
    |    (Bearer token)         |                              |
    |                           |--- verify JWT ----+          |
    |                           |<--- valid --------+          |
    |<--- auth:response --------|                              |
```

---

## 2. RBAC (Role-Based Access Control)

### 2.1 Roles

```
Role            Permission Level    Typical User
--------------  ------------------  --------------------------------
viewer          Read-only dashboard Stakeholder, PM
developer       Full agent access   IC developer
team_lead       Team config mgmt    Tech lead
admin           Full governance     Platform engineer, security
ci_bot          Automated access    CI/CD pipeline
```

### 2.2 Permission Matrix

```
Action                          viewer  developer  team_lead  admin  ci_bot
------------------------------  ------  ---------  ---------  -----  ------
View own sessions                        X          X          X
View team sessions               X       (*)        X          X
View all sessions                                              X
Run agent                                X          X          X      X
Modify own config (user level)           X          X          X
Modify project config                               X          X
Modify team policy rules                            X          X
Modify enterprise policy rules                                 X
View dashboard                   X       X          X          X
View team cost/usage             X       X          X          X
Manage team budgets                                 X          X
Create/delete API keys                              X          X
Manage Gateway config                                          X

(*) developer co the thay session listing cua team nhung KHONG doc transcript
```

### 2.3 RBAC Config

```yaml
# gateway-config.yaml
rbac:
  roles:
    developer:
      permissions:
        - "session:own:*"
        - "session:team:list"
        - "agent:run"
        - "config:user:*"
        - "dashboard:view"
        - "cost:team:view"

    team_lead:
      extends: "developer"
      permissions:
        - "session:team:*"
        - "config:project:*"
        - "config:team_policy:*"
        - "budget:team:*"
        - "apikey:*"

    admin:
      extends: "team_lead"
      permissions:
        - "session:all:*"
        - "config:enterprise_policy:*"
        - "gateway:*"

    ci_bot:
      permissions:
        - "agent:run"
        - "session:own:*"
        - "config:project:read"

  # User -> Role assignments
  assignments:
    - user: "user_456"
      role: "developer"
      teams: ["frontend"]
    - user: "user_789"
      role: "team_lead"
      teams: ["frontend", "backend"]
    - user: "ci_pipeline"
      role: "ci_bot"
      projects: ["proj_web"]
```

---

## 3. Data Privacy

### 3.1 Data Classification

```
Level    Label           Examples                         Ai thay duoc
-------  --------------  ------------------------------   ---------------------------
PUBLIC   Session stats   Token count, cost, duration      Viewer+
TEAM     Session list    Session IDs, user IDs, tools     Developer (team scope)
PRIVATE  Transcript      Full conversation, tool inputs   Session owner + admin
SECRET   Credentials     API keys, tokens in output       KHONG AI (auto-redacted)
```

### 3.2 Data Flow Privacy

```
DEV NODE ----[AWOCP]----> GATEWAY

What Gateway sees (configurable):

dataPrivacy:
  # Option A: Minimal (privacy-first)
  minimal:
    toolRequest: metadata_only     # toolName, isReadOnly, isDestructive
    outputContent: hash_only       # SHA-256 hash, length, token count
    transcripts: never_store       # Gateway khong luu transcript

  # Option B: Standard (default)
  standard:
    toolRequest: full_input        # Full tool input (for pattern matching)
    outputContent: filtered_only   # Output sau khi filter (secrets removed)
    transcripts: store_encrypted   # Encrypted at rest, access controlled

  # Option C: Full (compliance)
  full:
    toolRequest: full_input
    outputContent: full_content
    transcripts: store_plain       # Cho audit, searchable
    retention: 90d                 # Auto-delete sau 90 ngay
```

### 3.3 Audit Log Access

```
Audit logs chua: who, what, when, decision, source

Access control:
  - Developer: chi thay audit log cua OWN sessions
  - Team Lead: thay audit log cua TEAM sessions
  - Admin: thay TAT CA audit logs
  - Audit logs KHONG the xoa (immutable, append-only)
  - Retention policy: configurable (default 90 days, enterprise: unlimited)

Redaction trong audit logs:
  - Tool input co chua secrets --> auto-redact truoc khi luu
  - Full transcript --> khong luu trong audit log (reference session ID)
```

---

## 4. Token Management

### 4.1 API Key Lifecycle

```
Create:     team_lead+ tao API key cho developer/CI
Scope:      key bind vao user + projects + expiry
Rotate:     team_lead+ rotate key (old key valid 1h after rotate)
Revoke:     team_lead+ revoke key (immediate disconnect)
Audit:      moi key usage duoc log (connection, intercepts)
```

### 4.2 Key Storage

```
Developer:  ~/.agentweave/auth.json (encrypted voi OS keychain)
CI/CD:      CI secrets (GitHub Secrets, GitLab CI Variables)
Gateway:    Database (hashed, salted — bcrypt hoac argon2)
```

---

## 5. MVP Scope

| Feature | MVP | Post-MVP |
|---|---|---|
| JWT auth (team) | Co | |
| 3 roles (developer, team_lead, admin) | Co | |
| Session access control (own only) | Co | |
| Audit log (append-only) | Co | |
| Data minimization option | Co | |
| mTLS (enterprise) | | Co |
| Full RBAC with custom roles | | Co |
| SSO/SAML integration | | Co |
| Key rotation automation | | Co |
| Data retention policies | | Co |

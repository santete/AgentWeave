/**
 * Guard — shared types + Zod schemas for the `.claude/hooks/` governance layer.
 *
 * Claude Code invokes pre-/post-tool-use hooks, passing a JSON payload on stdin
 * and expecting a JSON decision on stdout (or exit code 2 = block).
 *
 * AgentWeave's `guard` CLI implements that contract and routes the request
 * through Outer Harness (PermissionEngine + BudgetManager + audit log).
 */

import { z } from "zod";

// ─── Claude Code hook input ──────────────────────────────────────

/**
 * Payload Claude Code writes to the hook's stdin.
 * Only the fields we care about are typed; extras are preserved via passthrough.
 */
export const HookInputSchema = z
	.object({
		session_id: z.string().optional(),
		transcript_path: z.string().optional(),
		cwd: z.string().optional(),
		hook_event_name: z.enum(["PreToolUse", "PostToolUse"]).optional(),
		tool_name: z.string(),
		tool_input: z.record(z.unknown()).default({}),
		tool_response: z.unknown().optional(),
	})
	.passthrough();

export type HookInput = z.infer<typeof HookInputSchema>;

// ─── Guard decision (our output) ─────────────────────────────────

/**
 * Decision payload written to stdout.
 * `approve` / `block` match Claude Code's expected PreToolUse contract.
 * `ask` is surfaced as a block with a reason so the user is prompted.
 */
export const GuardDecisionSchema = z.object({
	decision: z.enum(["approve", "block"]),
	reason: z.string().optional(),
	continue: z.boolean().optional(),
	stopReason: z.string().optional(),
});

export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

// ─── Guard config file ───────────────────────────────────────────

const PermissionRuleSchema = z.object({
	pattern: z.string(),
	behavior: z.enum(["allow", "deny", "ask"]),
	priority: z.number().default(100),
	message: z.string().optional(),
	group: z.string().optional(),
});

const BudgetSchema = z.object({
	maxPerSession: z.number().positive().optional(),
	maxPerDay: z.number().positive().optional(),
	warningThreshold: z.number().min(0).max(1).default(0.8),
	costPerToolCall: z.number().nonnegative().default(0),
	persistPath: z.string().default(".agentweave/budget.json"),
});

const AuditSchema = z.object({
	enabled: z.boolean().default(true),
	path: z.string().default(".agentweave/audit.log"),
});

export const GuardConfigSchema = z.object({
	mode: z.enum(["default", "strict", "permissive", "plan"]).default("default"),
	permissions: z.array(PermissionRuleSchema).default([]),
	budget: BudgetSchema.optional(),
	audit: AuditSchema.default({ enabled: true, path: ".agentweave/audit.log" }),
	/**
	 * Env var names exposed to rule conditions via `env.*`. Any var NOT in this
	 * list resolves to `undefined` inside conditions (fail-closed; prevents
	 * accidental secret reads in audit trail). Default: `[]` (no env access).
	 */
	envAllowlist: z.array(z.string()).default([]),
});

export type GuardConfig = z.infer<typeof GuardConfigSchema>;
export type GuardPermissionRule = z.infer<typeof PermissionRuleSchema>;
export type GuardBudgetConfig = z.infer<typeof BudgetSchema>;
export type GuardAuditConfig = z.infer<typeof AuditSchema>;

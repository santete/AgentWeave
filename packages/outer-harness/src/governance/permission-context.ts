/**
 * PermissionContext — ambient + per-request fields exposed to rule conditions.
 *
 * Built fresh on every `PermissionEngine.evaluate()` call. The four namespaces
 * (`request`, `session`, `time`, `env`) are the surface area the condition DSL
 * can read via dot-paths like `time.hour` or `session.projectId`.
 *
 * Hard invariants:
 *  - `session.*` comes from OuterHarness's captured SessionInfo, NEVER from
 *    agent/tool input — prevents privilege-escalation via session spoofing.
 *  - `env.*` only exposes vars listed in `envAllowlist`; everything else is
 *    `undefined` — prevents secret leakage into audit trails.
 *  - `time.*` uses the server clock; air-gapped deployments must have NTP.
 */
import type { SessionInfo, ToolRequest } from "@agentweave/types";

export interface PermissionContext {
	request: {
		toolName: string;
		toolInput: Record<string, unknown>;
		isReadOnly: boolean;
		isDestructive: boolean;
		turnIndex: number;
		toolUseId: string;
	};
	session: {
		sessionId?: string;
		agentId?: string;
		userId?: string;
		projectId?: string;
		model?: string;
		cwd?: string;
	};
	time: {
		hour: number;
		minute: number;
		weekday: number;
		iso: string;
		epochMs: number;
	};
	env: Record<string, string | undefined>;
}

export interface PermissionContextOptions {
	/** Session info captured at the last `onSessionStart`. Empty if no session. */
	session?: Partial<PermissionContext["session"]>;
	/** Env var names to expose. Default: empty (no env access). */
	envAllowlist?: readonly string[];
	/** Clock override — tests only. */
	now?: () => Date;
}

export function buildPermissionContext(
	request: ToolRequest,
	opts: PermissionContextOptions = {},
): PermissionContext {
	const now = (opts.now ?? (() => new Date()))();

	const env: Record<string, string | undefined> = {};
	for (const key of opts.envAllowlist ?? []) {
		env[key] = process.env[key];
	}

	return {
		request: {
			toolName: request.toolName,
			toolInput: request.toolInput,
			isReadOnly: request.isReadOnly,
			isDestructive: request.isDestructive,
			turnIndex: request.turnIndex,
			toolUseId: request.toolUseId,
		},
		session: {
			sessionId: opts.session?.sessionId,
			agentId: opts.session?.agentId,
			userId: opts.session?.userId,
			projectId: opts.session?.projectId,
			model: opts.session?.model,
			cwd: opts.session?.cwd,
		},
		time: {
			hour: now.getHours(),
			minute: now.getMinutes(),
			weekday: now.getDay(),
			iso: now.toISOString(),
			epochMs: now.getTime(),
		},
		env,
	};
}

/** Convenience — extract session fields the context cares about. */
export function sessionContextFromInfo(
	info: SessionInfo,
): Partial<PermissionContext["session"]> {
	return {
		sessionId: info.sessionId,
		agentId: info.agentId,
		userId: info.userId,
		projectId: info.projectId,
		model: info.model,
		cwd: info.cwd,
	};
}

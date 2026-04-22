/**
 * AdapterGovernance — Minimal governance wrapper for `pipeline run --agent X`.
 *
 * Why: when CLI pipeline spawns a ProcessAdapter (Cursor/Aider/Claude headless),
 * the adapter is a black-box process — no tool-call events, so PermissionEngine
 * and HookEngine tool-* hooks don't apply. What DOES apply to adapter stdout:
 *   - OutputPipeline filters (secret/PII redaction before UI/persist)
 *   - AuditLogger (spawn, each assistant message, exit)
 *
 * Wall-clock budget is already enforced via ProcessAdapter.processTimeoutMs.
 *
 * This module composes those two pieces into one small interface the CLI
 * pipeline event loop can call without pulling full OuterHarness into the CLI.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OutputPipeline, AuditLogger } from "@agentweave/outer-harness";
import type { AuditEntry } from "@agentweave/outer-harness";
import type { OutputFilter } from "@agentweave/types";

export interface AdapterGovernanceConfig {
	/** Session ID for audit log tagging. */
	sessionId: string;
	/** Directory where audit log is persisted. Default: <cwd>/.agentweave/. */
	auditDir?: string;
	/** Disable PII/secret redaction. Escape hatch for trusted contexts. Default: false. */
	disableRedaction?: boolean;
	/** Extra filters appended to the defaults. */
	extraFilters?: OutputFilter[];
	/** Persist audit to disk on each log call. Default: true. */
	persist?: boolean;
}

export interface AdapterGovernance {
	filterText(text: string): { text: string; redacted: boolean };
	logSpawn(command: string, args: string[], envKeys?: string[]): void;
	logMessage(rawText: string, filteredText: string, redacted: boolean): void;
	logExit(reason: string, durationMs: number, exitCode?: number): void;
	getAuditEntries(): ReadonlyArray<AuditEntry>;
	flush(): void;
}

/**
 * Default filters: secrets (built-in patterns engaged by passing type: "secret")
 * + PII (email/SSN/phone/credit card). Additional user-provided patterns are
 * appended — the "secret" type already merges BUILT_IN_SECRET_PATTERNS inside
 * OutputPipeline, so callers don't need to re-list them.
 */
const DEFAULT_FILTERS: OutputFilter[] = [
	{ name: "secrets", type: "secret", patterns: [], replacement: "[REDACTED:SECRET]" },
	{ name: "pii", type: "pii", entities: ["email", "ssn", "phone", "credit_card"], replacement: "[REDACTED:PII]" },
];

export function createAdapterGovernance(config: AdapterGovernanceConfig): AdapterGovernance {
	const filters = config.disableRedaction
		? []
		: [...DEFAULT_FILTERS, ...(config.extraFilters ?? [])];

	const pipeline = new OutputPipeline({ gateMode: "batch", filters });
	const audit = new AuditLogger();
	audit.setSessionId(config.sessionId);

	const persist = config.persist !== false;
	const auditDir = config.auditDir ?? join(process.cwd(), ".agentweave");
	const auditPath = join(auditDir, "adapter-audit.jsonl");
	let lastPersistedCount = 0;

	function appendNew(): void {
		if (!persist) return;
		const entries = audit.getEntries();
		if (entries.length <= lastPersistedCount) return;
		try {
			mkdirSync(dirname(auditPath), { recursive: true });
			const toWrite = entries
				.slice(lastPersistedCount)
				.map((e) => JSON.stringify(e))
				.join("\n") + "\n";
			appendFileSync(auditPath, toWrite);
			lastPersistedCount = entries.length;
		} catch {
			// Best-effort — don't break the pipeline on audit-write failure.
		}
	}

	return {
		filterText(text) {
			if (filters.length === 0) return { text, redacted: false };
			const { text: filtered, redactionCount } = pipeline.applyFilters(text);
			return { text: filtered, redacted: redactionCount > 0 };
		},

		logSpawn(command, args, envKeys) {
			audit.log(
				"adapter:spawn",
				{ command, argsCount: args.length, envKeys: envKeys ?? [] },
				"adapter",
			);
			appendNew();
		},

		logMessage(rawText, filteredText, redacted) {
			audit.log(
				"adapter:message",
				{
					length: rawText.length,
					filteredLength: filteredText.length,
					redacted,
					preview: filteredText.slice(0, 120),
				},
				"adapter",
			);
			appendNew();
		},

		logExit(reason, durationMs, exitCode) {
			audit.log("adapter:exit", { reason, durationMs, exitCode }, "adapter");
			appendNew();
		},

		getAuditEntries() {
			return audit.getEntries();
		},

		flush() {
			if (!persist) return;
			try {
				mkdirSync(dirname(auditPath), { recursive: true });
				const all = audit.getEntries().map((e) => JSON.stringify(e)).join("\n") + "\n";
				writeFileSync(auditPath, all);
				lastPersistedCount = audit.getEntries().length;
			} catch {
				// Best-effort.
			}
		},
	};
}

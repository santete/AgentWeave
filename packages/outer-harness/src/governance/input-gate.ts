/**
 * InputGate — Validates, transforms, and filters user input before it reaches the agent.
 * Supports: max length, empty rejection, whitespace trim, denylist patterns, context injection.
 */

export interface InputGateConfig {
	/** Maximum input length in characters (default 100000). */
	maxLength?: number;
	/** Reject empty/whitespace-only input (default true). */
	rejectEmpty?: boolean;
	/** Trim leading/trailing whitespace (default true). */
	trim?: boolean;
	/** Regex patterns that cause rejection (e.g. prompt injection patterns). */
	denyPatterns?: string[];
	/** Context strings to prepend to every input. */
	injectContext?: string[];
}

export interface InputGateResult {
	action: "pass" | "transform" | "reject";
	transformedInput?: string;
	injectedContext?: string[];
	reason?: string;
}

export class InputGate {
	private config: Required<Pick<InputGateConfig, "maxLength" | "rejectEmpty" | "trim">> & InputGateConfig;
	private compiledDeny: RegExp[];

	constructor(config?: InputGateConfig) {
		this.config = {
			maxLength: 100_000,
			rejectEmpty: true,
			trim: true,
			...config,
		};

		this.compiledDeny = (config?.denyPatterns ?? [])
			.map((p) => {
				try { return new RegExp(p, "i"); }
				catch { return null; }
			})
			.filter((r): r is RegExp => r !== null);
	}

	process(input: string): InputGateResult {
		let text = input;

		// Trim
		if (this.config.trim) {
			text = text.trim();
		}

		// Reject empty
		if (this.config.rejectEmpty && text.length === 0) {
			return { action: "reject", reason: "Empty input" };
		}

		// Max length
		if (text.length > this.config.maxLength) {
			return {
				action: "reject",
				reason: `Input exceeds max length (${text.length} > ${this.config.maxLength})`,
			};
		}

		// Deny patterns
		for (const pattern of this.compiledDeny) {
			pattern.lastIndex = 0;
			if (pattern.test(text)) {
				return {
					action: "reject",
					reason: `Input matches denied pattern: ${pattern.source}`,
				};
			}
		}

		// Context injection
		const injected = this.config.injectContext;
		const transformed = text !== input;

		if (injected && injected.length > 0) {
			return {
				action: "transform",
				transformedInput: text,
				injectedContext: injected,
			};
		}

		if (transformed) {
			return { action: "transform", transformedInput: text };
		}

		return { action: "pass" };
	}
}

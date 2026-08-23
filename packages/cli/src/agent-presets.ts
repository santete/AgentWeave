/**
 * Agent Presets — Pre-configured settings for popular AI CLI agents.
 *
 * Each preset defines: command, args, promptMode, and how to parse output.
 * Users can use `--agent claude` instead of manually configuring ProcessAdapter.
 */

export interface AgentPreset {
	/** Display name */
	name: string;
	/** Shell command to run */
	command: string;
	/** Default args for this agent */
	args: string[];
	/** How to send prompt: stdin or as final arg */
	promptMode: "stdin" | "arg";
	/** Parse stdout as JSON events? */
	parseJson: boolean;
	/** Capture stderr? */
	stderr: { capture: boolean; asEvents: boolean };
	/** Install instructions */
	install: string;
	/** How to verify agent is installed */
	verifyCommand: string;
	/** Notes for user */
	notes: string;
}

/**
 * Built-in presets for popular AI agent CLIs.
 * Key = what user types after --agent (e.g. --agent claude)
 */
export const AGENT_PRESETS: Record<string, AgentPreset> = {
	claude: {
		name: "Claude Code",
		command: "claude",
		args: ["--print", "--output-format", "text"],
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		install: "npm install -g @anthropic-ai/claude-code",
		verifyCommand: "claude --version",
		notes: "Requires ANTHROPIC_API_KEY env var. Uses --print for non-interactive mode.",
	},

	"claude-json": {
		name: "Claude Code (JSON stream)",
		command: "claude",
		args: ["--print", "--output-format", "stream-json"],
		promptMode: "arg",
		parseJson: true,
		stderr: { capture: true, asEvents: false },
		install: "npm install -g @anthropic-ai/claude-code",
		verifyCommand: "claude --version",
		notes: "JSON streaming mode — richer event data but requires JSON parsing.",
	},

	aider: {
		name: "Aider",
		command: "aider",
		args: ["--no-pretty", "--yes-always", "--no-git", "--message"],
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		install: "pip install aider-chat",
		verifyCommand: "aider --version",
		notes: "Requires API key for your chosen model (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.).",
	},

	codex: {
		name: "OpenAI Codex CLI",
		command: "codex",
		args: ["--approval-mode", "full-auto"],
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		install: "npm install -g @openai/codex",
		verifyCommand: "codex --version",
		notes: "Requires OPENAI_API_KEY env var.",
	},

	cursor: {
		name: "Cursor Agent",
		command: "cursor-agent",
		args: ["--force", "-p"],
		promptMode: "arg",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		install: "curl https://cursor.com/install -fsS | bash",
		verifyCommand: "cursor-agent --version",
		notes:
			"Requires Cursor login or CURSOR_API_KEY env var. `-p` headless mode can hang on some prompts — pipeline timeout catches it.",
	},

	custom: {
		name: "Custom Agent",
		command: "",
		args: [],
		promptMode: "stdin",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		install: "N/A",
		verifyCommand: "",
		notes:
			"Use --agent-cmd to specify command, --agent-args for args, --prompt-mode for stdin/arg.",
	},
};

/**
 * Resolve agent name to preset config.
 * If name matches a preset, return it.
 * Otherwise, treat it as a raw command.
 */
export function resolveAgent(name: string): {
	command: string;
	args: string[];
	promptMode: "stdin" | "arg";
	parseJson: boolean;
	stderr: { capture: boolean; asEvents: boolean };
	presetName: string | null;
} {
	const preset = AGENT_PRESETS[name.toLowerCase()];
	if (preset) {
		return {
			command: preset.command,
			args: [...preset.args],
			promptMode: preset.promptMode,
			parseJson: preset.parseJson,
			stderr: preset.stderr,
			presetName: preset.name,
		};
	}

	// Not a preset — treat as raw command
	return {
		command: name,
		args: [],
		promptMode: "stdin",
		parseJson: false,
		stderr: { capture: true, asEvents: false },
		presetName: null,
	};
}

/** List all available presets for help text */
export function listPresets(): string {
	const lines: string[] = [];
	for (const [key, preset] of Object.entries(AGENT_PRESETS)) {
		if (key === "custom") continue;
		lines.push(`    ${key.padEnd(15)} ${preset.name} (${preset.command} ${preset.args.join(" ")})`);
	}
	return lines.join("\n");
}

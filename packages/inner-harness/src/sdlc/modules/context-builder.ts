/**
 * ContextBuilder — Inject relevant files into task context.
 * Uses glob/grep patterns to find relevant source files.
 *
 * SECURITY: All keywords are sanitized before shell interpolation.
 * Only alphanumeric + underscore characters are allowed in search terms.
 */

import { execFileSync } from "node:child_process";
import type { SDLCModule, SDLCModuleContext, SDLCTask } from "@agentweave/types";

/** Strip all characters except alphanumeric, underscore, hyphen, dot */
function sanitizeKeyword(keyword: string): string {
	return keyword.replace(/[^a-zA-Z0-9_.\-]/g, "");
}

export class ContextBuilderModule implements SDLCModule<SDLCTask, SDLCTask> {
	readonly name = "ContextBuilder";

	async execute(input: SDLCTask, context: SDLCModuleContext): Promise<SDLCTask> {
		const config = context.config.modules.contextBuilder;
		const maxFiles = config.maxFiles ?? 20;

		// Find relevant files based on task context clues
		const discoveredFiles = this.discoverFiles(input, context.cwd, maxFiles);

		// Merge with existing context (deduplicate)
		const allContext = [...new Set([...input.context, ...discoveredFiles])];

		// Record utilization metric
		context.metrics.record("contextFilesInjected", discoveredFiles.length);

		return {
			...input,
			context: allContext,
		};
	}

	private discoverFiles(task: SDLCTask, cwd: string, maxFiles: number): string[] {
		const files: string[] = [];
		const keywords = this.extractKeywords(task);

		for (const keyword of keywords) {
			if (files.length >= maxFiles) break;
			const found = this.grepFiles(keyword, cwd);
			for (const f of found) {
				if (files.length >= maxFiles) break;
				if (!files.includes(f)) files.push(f);
			}
		}

		return files;
	}

	private extractKeywords(task: SDLCTask): string[] {
		const keywords: string[] = [];

		// Extract potential identifiers from goal (CamelCase, snake_case words)
		const identifiers = task.goal.match(/[A-Z][a-zA-Z]+|[a-z]+_[a-z_]+/g) ?? [];
		keywords.push(...identifiers.slice(0, 5));

		// Use file paths from context as search hints
		for (const ctx of task.context) {
			const basename = ctx
				.split("/")
				.pop()
				?.replace(/\.\w+$/, "");
			if (basename && basename.length > 2) keywords.push(basename);
		}

		// SECURITY: sanitize all keywords — strip shell metacharacters
		return [...new Set(keywords)]
			.map(sanitizeKeyword)
			.filter((k) => k.length > 2)
			.slice(0, 8);
	}

	private grepFiles(keyword: string, cwd: string, limit = 5): string[] {
		// keyword is already sanitized by extractKeywords()
		try {
			if (process.platform === "win32") {
				const output = execFileSync("findstr", ["/S", "/M", "/I", keyword, "*.ts", "*.js"], {
					cwd,
					timeout: 5000,
					encoding: "utf-8",
					stdio: ["pipe", "pipe", "pipe"],
				});
				return output.trim().split("\n").filter(Boolean).slice(0, limit);
			}

			const output = execFileSync(
				"grep",
				[
					"-rl",
					`--include=*.ts`,
					`--include=*.js`,
					"--exclude-dir=node_modules",
					"--exclude-dir=dist",
					"-m",
					String(limit),
					keyword,
					".",
				],
				{ cwd, timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
			);
			return output.trim().split("\n").filter(Boolean).slice(0, limit);
		} catch {
			return [];
		}
	}
}

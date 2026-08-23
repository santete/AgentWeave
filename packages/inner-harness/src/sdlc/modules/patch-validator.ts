/**
 * PatchValidator — Validate that changes match expected scope.
 * Compares changedFiles against plan.estimatedFiles.
 */

import type {
	SDLCCheck,
	SDLCExecutionResult,
	SDLCModule,
	SDLCModuleContext,
	SDLCValidationResult,
} from "@agentweave/types";

export interface PatchValidatorInput {
	result: SDLCExecutionResult;
	estimatedFiles: string[];
}

export class PatchValidatorModule implements SDLCModule<PatchValidatorInput, SDLCValidationResult> {
	readonly name = "PatchValidator";

	async execute(
		input: PatchValidatorInput,
		context: SDLCModuleContext,
	): Promise<SDLCValidationResult> {
		const config = context.config.modules.patchValidator;
		const maxFiles = config.maxFilesChanged ?? 30;
		const scopeStrict = config.scopeStrict ?? false;
		const checks: SDLCCheck[] = [];

		// Check 1: File count limit
		const fileCount = input.result.changedFiles.length;
		const fileCountOk = fileCount <= maxFiles;
		checks.push({
			name: "file_count",
			passed: fileCountOk,
			message: fileCountOk
				? `${fileCount} files changed (limit: ${maxFiles})`
				: `Too many files changed: ${fileCount} > ${maxFiles}`,
			severity: fileCountOk ? "info" : scopeStrict ? "error" : "warning",
		});

		// Check 2: Scope accuracy (if estimatedFiles provided)
		if (input.estimatedFiles.length > 0) {
			const outOfScope = input.result.changedFiles.filter(
				(f) => !input.estimatedFiles.some((e) => f.includes(e) || e.includes(f)),
			);
			const scopeOk = outOfScope.length === 0;

			checks.push({
				name: "scope",
				passed: scopeOk,
				message: scopeOk
					? "All changes within expected scope"
					: `Out-of-scope files: ${outOfScope.join(", ")}`,
				severity: scopeOk ? "info" : scopeStrict ? "error" : "warning",
			});

			// Record scope accuracy for M3
			const accuracy =
				input.result.changedFiles.length > 0
					? (input.result.changedFiles.length - outOfScope.length) /
						input.result.changedFiles.length
					: 1;
			context.metrics.record("scopeAccuracy", accuracy);
		}

		// Check 3: Empty changes — LỖI, không phải cảnh báo.
		//
		// `allRequiredPassed` chỉ lọc `severity === "error"`, nên để đây là
		// "warning" tức là cho qua. Đo thật: agent trinh sát ba lượt rồi dừng,
		// đổi 0 file, patchValidator vẫn `passed: true` trong 0ms và pipeline đi
		// tiếp như không có gì. "Chạy xong mà không đổi gì" chính là kiểu hỏng mà
		// cả bộ cổng chất lượng sinh ra để bắt — nó không được phép là cảnh báo.
		if (input.result.changedFiles.length === 0 && input.result.success) {
			checks.push({
				name: "empty_patch",
				passed: false,
				message:
					"Execution reported success but NOT ONE file was changed. " +
					"Either the task needed no change (say so explicitly) or the agent did not do the work.",
				severity: "error",
			});
		}

		const allRequiredPassed = checks.filter((c) => c.severity === "error").every((c) => c.passed);

		return {
			passed: allRequiredPassed,
			checks,
			score: checks.length > 0 ? checks.filter((c) => c.passed).length / checks.length : 1,
		};
	}
}

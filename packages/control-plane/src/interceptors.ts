/**
 * InterceptorRegistry — Blocking gates for tool_request, output_ready, input_received.
 * Each intercept type can have one handler. Supports timeout and fail-open/closed modes.
 */

import type {
	InterceptType,
	InterceptRequest,
	InterceptResponse,
	ToolDecision,
	OutputDecision,
	InputDecision,
} from "@agentweave/types";

type InterceptHandler<T extends InterceptType> = (
	request: InterceptRequest[T],
) => Promise<InterceptResponse[T]>;

const DEFAULT_TIMEOUTS: Record<InterceptType, number> = {
	tool_request: 30_000,
	output_ready: 10_000,
	input_received: 5_000,
};

function getDefaultDecision(
	type: InterceptType,
	failMode: "open" | "closed",
): InterceptResponse[typeof type] {
	switch (type) {
		case "tool_request":
			return {
				behavior: failMode === "open" ? "allow" : "deny",
				reason: failMode === "open" ? "No interceptor (fail-open)" : "No interceptor (fail-closed)",
				source: "default",
			} satisfies ToolDecision as InterceptResponse[typeof type];
		case "output_ready":
			return {
				action: "approve",
				reason: "No interceptor",
				stages: [],
			} satisfies OutputDecision as InterceptResponse[typeof type];
		case "input_received":
			return {
				action: "pass",
				reason: "No interceptor",
			} satisfies InputDecision as InterceptResponse[typeof type];
	}
}

/** Thay lý do trong một quyết định mặc định, giữ nguyên phần còn lại. */
function withReason<T extends { reason?: string }>(quyetDinh: T, lyDo: string): T {
	return { ...quyetDinh, reason: lyDo };
}

export class InterceptorRegistry {
	private handlers = new Map<InterceptType, InterceptHandler<InterceptType>>();
	private failMode: "open" | "closed" = "closed";

	registerInterceptor<T extends InterceptType>(
		type: T,
		handler: InterceptHandler<T>,
	): void {
		// Store as unknown to avoid variance issues; we ensure type safety at call sites
		this.handlers.set(type, handler as unknown as InterceptHandler<InterceptType>);
	}

	async intercept<T extends InterceptType>(
		type: T,
		request: InterceptRequest[T],
		options?: { timeoutMs?: number },
	): Promise<InterceptResponse[T]> {
		const handler = this.handlers.get(type) as InterceptHandler<T> | undefined;
		if (!handler) {
			return getDefaultDecision(type, this.failMode) as InterceptResponse[T];
		}

		const timeout = options?.timeoutMs ?? DEFAULT_TIMEOUTS[type];

		// timeoutMs = 0 → CHỜ VÔ HẠN. Cần cho trường hợp quyết định thuộc về con
		// người: hỏi "cho phép sửa file này không?" rồi tự từ chối sau 30 giây vì
		// người dùng còn đang đọc diff là sai về khái niệm — đó là hạn của máy áp
		// lên việc của người. Lối thoát vẫn có: abort.
		if (timeout === 0) {
			try {
				return await handler(request);
			} catch (err) {
				const lyDo = err instanceof Error ? err.message : String(err);
				return withReason(
					getDefaultDecision(type, this.failMode),
					`Interceptor loi: ${lyDo}`,
				) as InterceptResponse[T];
			}
		}

		let timer: ReturnType<typeof setTimeout> | undefined;

		try {
			const result = await Promise.race([
				handler(request),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Interceptor timeout (${timeout}ms)`)),
						timeout,
					);
				}),
			]);
			return result;
		} catch (err) {
			// Handler CÓ tồn tại nhưng hết giờ hoặc ném lỗi. Bản trước trả về
			// getDefaultDecision với lý do "No interceptor" — sai hoàn toàn so với
			// nguyên nhân thật, khiến người ta đi tìm interceptor bị thiếu trong
			// khi vấn đề là timeout. Nói đúng chuyện gì đã xảy ra.
			const lyDo = err instanceof Error ? err.message : String(err);
			return withReason(
				getDefaultDecision(type, this.failMode),
				`Interceptor loi: ${lyDo}`,
			) as InterceptResponse[T];
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	hasInterceptor(type: InterceptType): boolean {
		return this.handlers.has(type);
	}

	setFailMode(mode: "open" | "closed"): void {
		this.failMode = mode;
	}

	getFailMode(): "open" | "closed" {
		return this.failMode;
	}

	destroy(): void {
		this.handlers.clear();
	}
}

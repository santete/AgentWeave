/**
 * fetchWithRetry — shared HTTP retry+backoff utility.
 *
 * Extracted from HookEngine.executeHttpHook() so every outer-harness HTTP
 * consumer (HookEngine, WebhookSink, future exporters) applies identical
 * backoff semantics. Keeping this logic in one place is the only way to
 * avoid drift between `retries`, `timeoutMs`, and status-based retry rules.
 */

export interface HttpRetryOptions {
	/** Max retry attempts AFTER the initial request. Default 0 (single attempt). */
	maxRetries?: number;
	/** Per-attempt timeout in ms (AbortSignal.timeout). Default 10_000. */
	timeoutMs?: number;
	/** Predicate: should this response status trigger a retry? Default: status >= 500. */
	shouldRetry?: (status: number) => boolean;
	/** Base delay for exponential backoff (ms). Default 1000. */
	baseDelayMs?: number;
	/** Max delay cap (ms). Default 5000. */
	maxDelayMs?: number;
}

export type HttpRetryResult =
	| { ok: true; response: Response; attempts: number }
	| { ok: false; error: string; attempts: number; lastStatus?: number };

const DEFAULT_SHOULD_RETRY = (status: number) => status >= 500;

export async function fetchWithRetry(
	url: string,
	init: RequestInit = {},
	opts: HttpRetryOptions = {},
	signal?: AbortSignal,
): Promise<HttpRetryResult> {
	const maxRetries = opts.maxRetries ?? 0;
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const shouldRetry = opts.shouldRetry ?? DEFAULT_SHOULD_RETRY;
	const baseDelayMs = opts.baseDelayMs ?? 1000;
	const maxDelayMs = opts.maxDelayMs ?? 5000;

	let lastError = "";
	let lastStatus: number | undefined;
	let attempts = 0;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		attempts = attempt + 1;

		if (signal?.aborted) {
			return { ok: false, error: "aborted", attempts, lastStatus };
		}

		try {
			const attemptSignal = composeSignals(signal, AbortSignal.timeout(timeoutMs));
			const response = await fetch(url, { ...init, signal: attemptSignal });

			if (response.ok) {
				return { ok: true, response, attempts };
			}

			lastStatus = response.status;

			if (shouldRetry(response.status) && attempt < maxRetries) {
				await backoff(attempt, baseDelayMs, maxDelayMs);
				continue;
			}

			return {
				ok: false,
				error: `HTTP ${response.status}: ${response.statusText}`,
				attempts,
				lastStatus: response.status,
			};
		} catch (err) {
			lastError = err instanceof Error ? err.message : "Fetch failed";
			if (attempt < maxRetries) {
				await backoff(attempt, baseDelayMs, maxDelayMs);
				continue;
			}
		}
	}

	return { ok: false, error: lastError || "Fetch failed", attempts, lastStatus };
}

function backoff(attempt: number, baseMs: number, maxMs: number): Promise<void> {
	const ms = Math.min(baseMs * Math.pow(2, attempt), maxMs);
	return new Promise((r) => setTimeout(r, ms));
}

function composeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
	if (!a) return b;
	// Prefer native AbortSignal.any (Node 20.3+, Bun 1.0+).
	if (typeof (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any === "function") {
		return (AbortSignal as unknown as { any: (s: AbortSignal[]) => AbortSignal }).any([a, b]);
	}
	const controller = new AbortController();
	if (a.aborted || b.aborted) controller.abort();
	else {
		const onAbort = () => controller.abort();
		a.addEventListener("abort", onAbort, { once: true });
		b.addEventListener("abort", onAbort, { once: true });
	}
	return controller.signal;
}

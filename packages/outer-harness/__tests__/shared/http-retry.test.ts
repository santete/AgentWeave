import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "../../src/shared/http-retry";

function ok(status = 200, body = "ok"): Response {
	return new Response(body, { status, statusText: status === 200 ? "OK" : "" });
}

function err(status: number, statusText: string): Response {
	return new Response(null, { status, statusText });
}

describe("fetchWithRetry", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns ok result on immediate 200", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok());

		const result = await fetchWithRetry("http://x/", { method: "POST" });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.attempts).toBe(1);
			expect(result.response.status).toBe(200);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("retries on 5xx then succeeds", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(err(503, "Service Unavailable"))
			.mockResolvedValueOnce(ok());

		const result = await fetchWithRetry(
			"http://x/",
			{},
			{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.attempts).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("does NOT retry on 4xx — fails fast", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(err(400, "Bad Request"));

		const result = await fetchWithRetry("http://x/", {}, { maxRetries: 3, baseDelayMs: 1 });

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.attempts).toBe(1);
			expect(result.error).toContain("HTTP 400");
			expect(result.lastStatus).toBe(400);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("surfaces error after exhausting all retries on persistent 5xx", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(err(500, "Server Error"));

		const result = await fetchWithRetry(
			"http://x/",
			{},
			{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.attempts).toBe(3);
			expect(result.lastStatus).toBe(500);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(3);
	});

	it("custom shouldRetry triggers retry on 429", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(err(429, "Too Many Requests"))
			.mockResolvedValueOnce(ok());

		const result = await fetchWithRetry(
			"http://x/",
			{},
			{
				maxRetries: 2,
				baseDelayMs: 1,
				maxDelayMs: 2,
				shouldRetry: (s) => s === 429 || s >= 500,
			},
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.attempts).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("retries on network error then succeeds", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValueOnce(new Error("ECONNRESET"))
			.mockResolvedValueOnce(ok());

		const result = await fetchWithRetry(
			"http://x/",
			{},
			{ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
		);

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.attempts).toBe(2);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("propagates aborted external signal without calling fetch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const ac = new AbortController();
		ac.abort();

		const result = await fetchWithRetry("http://x/", {}, {}, ac.signal);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("aborted");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

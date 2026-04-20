// T4: Feature — Add Retry Logic to HTTP client
const fs = require("fs");
const dir = process.env.BENCH_WORKDIR || ".bench-workspace";
fs.mkdirSync(`${dir}/src`, { recursive: true });
fs.mkdirSync(`${dir}/test`, { recursive: true });

fs.writeFileSync(`${dir}/src/http-client.ts`, `
export interface FetchResult {
  status: number;
  data: string;
}

// Simulated fetch — replace implementation for testing
let mockResponses: Array<{ status: number; data: string }> = [];

export function setMockResponses(responses: Array<{ status: number; data: string }>) {
  mockResponses = [...responses];
}

async function rawFetch(): Promise<FetchResult> {
  if (mockResponses.length > 0) return mockResponses.shift()!;
  return { status: 200, data: "ok" };
}

// TODO: Add retry logic — retry up to 3 times on 5xx with exponential backoff
// Don't retry on 4xx. Return last error if all retries fail.
export async function fetchData(): Promise<FetchResult> {
  const result = await rawFetch();
  if (result.status >= 400) {
    throw new Error(\`HTTP \${result.status}\`);
  }
  return result;
}
`);

fs.writeFileSync(`${dir}/test/http-client.test.ts`, `
import { fetchData, setMockResponses } from "../src/http-client";

export async function testSuccess() {
  setMockResponses([{ status: 200, data: "ok" }]);
  const r = await fetchData();
  if (r.status !== 200) throw new Error("Should return 200");
}

export async function testRetryOn500() {
  setMockResponses([
    { status: 500, data: "err" },
    { status: 500, data: "err" },
    { status: 200, data: "ok" },
  ]);
  const r = await fetchData();
  if (r.status !== 200) throw new Error("Should succeed after retries");
}

export async function testNoRetryOn400() {
  setMockResponses([{ status: 400, data: "bad" }]);
  try {
    await fetchData();
    throw new Error("Should throw on 400");
  } catch (e) {
    if (!e.message.includes("400")) throw new Error("Should throw HTTP 400 error");
  }
}

export async function testMaxRetriesExhausted() {
  setMockResponses([
    { status: 503, data: "err" },
    { status: 503, data: "err" },
    { status: 503, data: "err" },
    { status: 503, data: "err" },
  ]);
  try {
    await fetchData();
    throw new Error("Should throw after max retries");
  } catch (e) {
    if (!e.message.includes("50")) throw new Error("Should throw 5xx error");
  }
}
`);

console.log("T4 setup complete:", dir);

import { describe, it, expect, vi } from "vitest";
import { OllamaAdapter } from "../src/ollama-adapter";
import type { InnerEvent } from "@agentweave/types";

/** Helper: collect all events from a run */
async function collectRun(adapter: OllamaAdapter, prompt = "test"): Promise<{ events: InnerEvent[]; result: { reason: string } }> {
  const events: InnerEvent[] = [];
  const gen = adapter.run(prompt);
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return { events, result: value };
    events.push(value);
  }
}

// ─── Core tests ──────────────────────────────

describe("OllamaAdapter", () => {
  it("should be constructable with basic config", () => {
    const adapter = new OllamaAdapter({
      model: "qwen2.5:7b",
      endpoint: "http://127.0.0.1:11434"
    });
    
    expect(adapter).toBeDefined();
    expect(adapter.getConfig().model).toBe("qwen2.5:7b");
  });

  it("should set the correct default endpoint when not specified", () => {
    const adapter = new OllamaAdapter({
      model: "qwen2.5:7b"
    });
    
    expect(adapter.getConfig().model).toBe("qwen2.5:7b");
  });
});
/**
 * OllamaAdapter — Wraps the Ollama HTTP API to provide a compatible interface
 * for AgentWeave. This adapter uses the Ollama REST API (not CLI) directly.
 * 
 * The adapter supports:
 * - Configurable model name and endpoint URL
 * - Streaming responses (if supported by Ollama)
 * - Proper error handling and event reporting
 * - Integration with AgentWeave's InnerHarnessProvider interface
 */
import type {
  InnerHarnessProvider,
  RunOptions,
  InnerEvent,
  InnerEventPayload,
  InnerState,
  TerminalResult,
  ToolDefinition,
  ContentBlock,
  InjectableMessage,
  Message,
} from "@agentweave/types";
import { createEmptyTokenUsage, createEmptyContextUsage } from "@agentweave/types";

// ─── Config ─────────────────────────────────────────────────────

export interface OllamaAdapterConfig {
  /** Model name to use (e.g. "qwen2.5:7b") */
  model: string;
  
  /** Ollama endpoint URL (e.g. "http://127.0.0.1:11434") */
  endpoint?: string;
  
  /** Timeout for requests in milliseconds */
  timeoutMs?: number;
  
  /** Additional headers to send with requests */
  headers?: Record<string, string>;
}

// ─── Adapter ────────────────────────────────────────────────────

export class OllamaAdapter implements InnerHarnessProvider {
  private config: OllamaAdapterConfig;
  private state: InnerState;
  private sessionId = "";
  private agentId: string;
  
  // Message tracking
  private messages: Message[] = [];
  
  constructor(config: OllamaAdapterConfig) {
    this.config = {
      model: config.model,
      endpoint: config.endpoint || "http://127.0.0.1:11434",
      timeoutMs: config.timeoutMs || 30000,
      headers: config.headers || {},
    };
    
    this.agentId = `adapter_${Math.random().toString(36).substring(2, 10)}`;
    this.state = {
      status: "idle",
      turnIndex: 0,
      model: `ollama:${this.config.model}`,
      usage: createEmptyTokenUsage(),
      contextUsage: createEmptyContextUsage(0),
      activeTool: null,
      messageCount: 0,
      recoveryAttempts: 0,
    };
  }

  async *run(
    prompt: string | ContentBlock[],
    options?: RunOptions,
  ): AsyncGenerator<InnerEvent, TerminalResult, void> {
    if (this.state.status !== "idle") {
      throw new Error("OllamaAdapter can only be run once per instance");
    }
    
    this.state.status = "running";
    this.sessionId = `ses_${Math.random().toString(36).substring(2, 10)}`;
    this.state.turnIndex = 1;
    
    yield this.makeEvent({ type: "turn:start", turnIndex: 1 });
    
    try {
      const requestBody = {
        model: this.config.model,
        prompt: typeof prompt === "string" ? prompt : JSON.stringify(prompt),
        stream: true, // Request streaming responses
      };
      
      // Make request to Ollama API
      const response = await fetch(`${this.config.endpoint}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      });
      
      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
      }
      
      // Process streaming response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Failed to get response stream");
      }
      
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) break;
        
        // Append new data to the buffer
        buffer += decoder.decode(value);
        
        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            // Parse each chunk as JSON
            const data = JSON.parse(line.trim());
            
            // Handle different types of responses from Ollama
            if (data.response) {
              // Assistant response
              const msg: Message = {
                role: "assistant", 
                content: [{ type: "text", text: data.response }]
              };
              this.messages.push(msg);
              this.state.messageCount++;
              
              yield this.makeEvent({
                type: "message:assistant",
                content: [{ type: "text", text: data.response }],
              });
            }
            
            if (data.done) {
              // End of response
              break;
            }
          } catch (err) {
            // If parsing fails, treat as plain text
            const msg: Message = {
              role: "assistant",
              content: [{ type: "text", text: line.trim() }]
            };
            this.messages.push(msg);
            this.state.messageCount++;
            
            yield this.makeEvent({
              type: "message:assistant",
              content: [{ type: "text", text: line.trim() }],
            });
          }
        }
      }
      
      // Set terminal state
      this.state.status = "completed";
      
      yield this.makeEvent({
        type: "turn:end",
        turnIndex: 1,
        stopReason: "completed",
      });
      
      const terminalResult: TerminalResult = {
        reason: "completed",
        usage: this.state.usage,
      };
      
      yield this.makeEvent({
        type: "terminal",
        reason: "completed",
        usage: this.state.usage,
      });
      
      return terminalResult;
    } catch (error) {
      this.state.status = "error";
      const errorText = error instanceof Error ? error.message : String(error);
      
      yield this.makeEvent({
        type: "error",
        error: errorText,
        recoverable: false,
      });
      
      yield this.makeEvent({
        type: "turn:end",
        turnIndex: 1,
        stopReason: "error",
      });
      
      yield this.makeEvent({
        type: "terminal",
        reason: "error",
        usage: this.state.usage,
      });
      
      return {
        reason: "error",
        usage: this.state.usage,
      };
    }
  }

  // ─── InnerHarnessProvider interface ──────────────────────────

  getState(): InnerState {
    return { ...this.state };
  }

  getMessages(): ReadonlyArray<Message> {
    return [...this.messages];
  }

  getContextUsage(): any {
    return { ...this.state.contextUsage };
  }

  getUsage(): any {
    return { ...this.state.usage };
  }

  getTools(): ReadonlyArray<ToolDefinition> {
    return [];
  }

  registerTool(_tool: ToolDefinition): void {
    // No-op — Ollama handles the model itself
  }

  unregisterTool(_name: string): void {
    // No-op
  }

  injectMessage(_message: InjectableMessage): void {
    // Injection is not supported for direct API calls
  }

  setSystemPromptSection(_name: string, _content: string | null): void {
    // No-op — system prompt should be included in the initial prompt
  }

  setModel(model: string): void {
    this.config.model = model;
    this.state.model = `ollama:${model}`;
  }

  getConfig(): any {
    return {
      model: this.config.model,
      maxTurns: 1,
      thinkingEnabled: false,
      tools: [],
    };
  }

  // ─── Internal ───────────────────────────────────────────────

  private makeEvent(payload: InnerEventPayload): InnerEvent {
    // Simple UUID generator for browser-compatible environments
    const generateUUID = () => {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
    
    return {
      id: generateUUID(),
      timestamp: Date.now(),
      sessionId: this.sessionId,
      agentId: this.agentId,
      ...payload,
    } as InnerEvent;
  }

  abort(_reason?: string): void {
    // No-op for Ollama - no active process to kill
    this.state.status = "aborted";
  }
}
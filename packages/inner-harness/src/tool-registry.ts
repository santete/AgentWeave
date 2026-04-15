/**
 * ToolRegistry — Manages available tools for the agent.
 * Tools can be registered/unregistered at runtime.
 */

import type { ToolDefinition } from "@agentweave/types";

export class ToolRegistry {
	private tools = new Map<string, ToolDefinition>();

	register(tool: ToolDefinition): void {
		if (this.tools.has(tool.name)) {
			throw new Error(`Tool "${tool.name}" is already registered`);
		}
		this.tools.set(tool.name, tool);
	}

	unregister(name: string): void {
		if (!this.tools.has(name)) {
			throw new Error(`Tool "${name}" is not registered`);
		}
		this.tools.delete(name);
	}

	get(name: string): ToolDefinition | undefined {
		return this.tools.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	getAll(): ReadonlyArray<ToolDefinition> {
		return [...this.tools.values()];
	}

	names(): string[] {
		return [...this.tools.keys()];
	}

	size(): number {
		return this.tools.size;
	}

	clear(): void {
		this.tools.clear();
	}
}

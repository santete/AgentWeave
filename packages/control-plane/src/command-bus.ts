/**
 * CommandBus — Async request/ack for Outer -> Inner command flow.
 * Only one command handler can be registered at a time.
 */

import type { OuterCommand, CommandAck } from "@agentweave/types";

type CommandHandler = (command: OuterCommand) => Promise<CommandAck>;

export class CommandBus {
	private handler: CommandHandler | null = null;

	async send(command: OuterCommand): Promise<CommandAck> {
		if (!this.handler) {
			return { accepted: false, reason: "No command handler registered" };
		}
		try {
			return await this.handler(command);
		} catch (err) {
			return {
				accepted: false,
				reason: err instanceof Error ? err.message : "Command handler error",
			};
		}
	}

	setHandler(handler: CommandHandler): void {
		this.handler = handler;
	}

	hasHandler(): boolean {
		return this.handler !== null;
	}

	destroy(): void {
		this.handler = null;
	}
}

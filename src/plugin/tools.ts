import { type ToolContext, tool } from "@opencode-ai/plugin"
import type { ReadDelegationArgs } from "./types"
import type { DelegationManager } from "./manager"

// ---- Arg interfaces ----

interface DelegateArgs {
	prompt: string
	agent: string
	model?: string
}

interface CancelArgs {
	id?: string
	all?: boolean
}

interface ResumeArgs {
	id: string
	prompt?: string
}

// ---- Tool creators ----

export function createDelegate(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Delegate a task to an agent. Returns immediately with the session ID.

Use this for:
- Research tasks (will be auto-saved)
- Parallel work that can run in background
- Any task where you want persistent, retrievable output

On completion, a notification will arrive with the session ID, status, duration.
Use \`delegation_read\` with the session ID to retrieve the result.`,
		args: {
			prompt: tool.schema
				.string()
				.describe("The full detailed prompt for the agent. Must be in English."),
			agent: tool.schema
				.string()
				.describe(
					'Agent to delegate to: "explore" (codebase search), "researcher" (external research), etc.',
				),
			model: tool.schema
				.string()
				.optional()
				.describe(
					'Override model for this delegation. Format: "provider/model" (e.g. "minimax/MiniMax-M2.5"). If not set, uses the agent default.',
				),
		},
		async execute(args: DelegateArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegate requires sessionID. This is a system error."
			}
			if (!toolCtx?.messageID) {
				return "❌ delegate requires messageID. This is a system error."
			}

			try {
				const delegation = await manager.delegate({
					parentSessionID: toolCtx.sessionID,
					parentMessageID: toolCtx.messageID,
					parentAgent: toolCtx.agent,
					prompt: args.prompt,
					agent: args.agent,
					model: args.model,
				})

				const pendingCount = manager.getPendingCount(toolCtx.sessionID)

				let response = `Delegation started: ${delegation.id}\nAgent: ${args.agent}`
				if (pendingCount > 1) {
					response += `\n\n${pendingCount} delegations now active.`
				}
				response += `\n\nYou WILL be notified via <system-reminder> when complete. Do NOT poll delegation_list().`

				return response
			} catch (error) {
				return `❌ Delegation failed:\n\n${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

export function createDelegationRead(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Read the output of a delegation by its ID.

Modes:
- simple (default): Returns just the final result
- full: Returns all messages in the session with timestamps

Use filters to get specific parts of the conversation.`,
		args: {
			id: tool.schema.string().describe("The delegation session ID"),
			mode: tool.schema
				.enum(["simple", "full"])
				.optional()
				.describe("Output mode: 'simple' for result only, 'full' for all messages"),
			include_thinking: tool.schema
				.boolean()
				.optional()
				.describe("Include thinking/reasoning blocks in full mode"),
			include_tools: tool.schema
				.boolean()
				.optional()
				.describe("Include tool results in full mode"),
			since_message_id: tool.schema
				.string()
				.optional()
				.describe("Return only messages after this message ID (full mode only)"),
			limit: tool.schema
				.number()
				.optional()
				.describe("Max messages to return, capped at 100 (full mode only)"),
		},
		async execute(args: ReadDelegationArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_read requires sessionID. This is a system error."
			}

			try {
				return await manager.readDelegation(args)
			} catch (error) {
				return `❌ Error reading delegation: ${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

export function createDelegationList(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `List all delegations for the current session.
Shows running, completed, cancelled, and error tasks with metadata.`,
		args: {},
		async execute(_args: Record<string, never>, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_list requires sessionID. This is a system error."
			}

			const delegations = await manager.listDelegations(toolCtx.sessionID)

			if (delegations.length === 0) {
				return "No delegations found for this session."
			}

			const lines = delegations.map((d) => {
				const titlePart = d.title ? ` | ${d.title}` : ""
				const durationPart = d.duration ? ` (${d.duration})` : ""
				const descPart = d.description ? `\n  → ${d.description.slice(0, 100)}${d.description.length > 100 ? "..." : ""}` : ""
				return `- **${d.id}**${titlePart} [${d.status}]${durationPart}${descPart}`
			})

			return `## Delegations\n\n${lines.join("\n")}`
		},
	})
}

export function createDelegationCancel(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Cancel a running delegation by ID, or cancel all running delegations.

Cancelled tasks can be resumed later with delegation_resume().`,
		args: {
			id: tool.schema.string().optional().describe("Task ID to cancel"),
			all: tool.schema.boolean().optional().describe("Cancel ALL running delegations"),
		},
		async execute(args: CancelArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_cancel requires sessionID. This is a system error."
			}

			try {
				if (args.all) {
					const cancelled = await manager.cancelAll(toolCtx.sessionID)
					if (cancelled.length === 0) {
						return "No running delegations to cancel."
					}
					return `Cancelled ${cancelled.length} delegation(s):\n${cancelled.map(id => `- ${id}`).join("\n")}`
				}

				if (!args.id) {
					return "❌ Must provide either 'id' or 'all=true'"
				}

				const success = await manager.cancel(args.id)
				if (!success) {
					return `❌ Could not cancel "${args.id}". Task may not exist or is not running.`
				}

				return `✅ Cancelled delegation: ${args.id}\n\nYou can resume it later with delegation_resume(id="${args.id}")`
			} catch (error) {
				return `❌ Error cancelling: ${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

export function createDelegationResume(manager: DelegationManager): ReturnType<typeof tool> {
	return tool({
		description: `Resume a cancelled or errored delegation by sending a new prompt to the same session.

The agent will have access to the previous conversation context.`,
		args: {
			id: tool.schema.string().describe("Task ID to resume"),
			prompt: tool.schema
				.string()
				.optional()
				.describe("Optional prompt to send (default: 'Continue from where you left off.')"),
		},
		async execute(args: ResumeArgs, toolCtx: ToolContext): Promise<string> {
			if (!toolCtx?.sessionID) {
				return "❌ delegation_resume requires sessionID. This is a system error."
			}

			try {
				const delegation = await manager.resume(args.id, args.prompt)
				return `✅ Resumed delegation: ${delegation.id}\nAgent: ${delegation.agent}\nStatus: ${delegation.status}`
			} catch (error) {
				return `❌ Error resuming: ${error instanceof Error ? error.message : "Unknown error"}`
			}
		},
	})
}

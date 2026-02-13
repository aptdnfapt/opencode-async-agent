/**
 * async-agent
 * Unified delegation system for OpenCode
 *
 * Based on oh-my-opencode by @code-yeongyu (MIT License)
 * https://github.com/code-yeongyu/oh-my-opencode
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { Event } from "@opencode-ai/sdk"
import type { OpencodeClient } from "./types"
import { createLogger } from "./utils"
import { DelegationManager } from "./manager"
import {
	createDelegate,
	createDelegationRead,
	createDelegationList,
	createDelegationCancel,
	createDelegationResume,
} from "./tools"
import { DELEGATION_RULES, formatDelegationContext, readBgAgentsConfig } from "./rules"

// Slash command name — user types /delegation in chat
const delegationCommand = "delegation"

export const AsyncAgentPlugin: Plugin = async (ctx) => {
	const { client } = ctx

	const log = createLogger(client as OpencodeClient)
	const manager = new DelegationManager(client as OpencodeClient, log)

	await manager.debugLog("AsyncAgentPlugin initialized")

	return {
		// Handle /delegation slash command execution
		"command.execute.before": async (input: { command: string; sessionID: string }) => {
			if (input.command !== delegationCommand) return

			const typedClient = client as OpencodeClient

			// Query child sessions of current session from OpenCode API (survives reboots)
			let childSessions: any[] = []
			try {
				const result = await typedClient.session.children({
					path: { id: input.sessionID },
				})
				childSessions = (result.data ?? []) as any[]
			} catch {
				// Fallback to in-memory only if API fails
			}

			// Filter for delegation sessions — created with title "Delegation: <agent>"
			const delegationSessions = childSessions.filter(
				(s: any) => s.title?.startsWith("Delegation:"),
			)

			// Get in-memory state for extra metadata (status, duration, agent)
			const inMemory = manager.listAllDelegations()
			const inMemoryMap = new Map(inMemory.map((d) => [d.id, d]))

			let message: string
			if (delegationSessions.length === 0 && inMemory.length === 0) {
				message = "No delegations found for this session."
			} else {
				const lines: string[] = []
				const seen = new Set<string>()
				const entries: {
					id: string
					title: string
					agent: string
					status: string
					duration: string
					started: string
				}[] = []

				// Persisted child sessions from API — survive reboots
				for (const s of delegationSessions) {
					seen.add(s.id)
					const mem = inMemoryMap.get(s.id)
					// Extract agent name from title "Delegation: <agent>"
					const agent = mem?.agent ?? s.title?.replace("Delegation: ", "") ?? "unknown"
					const status = mem?.status?.toUpperCase() ?? "PERSISTED"
					const duration = mem?.duration ?? "—"
					// time.created is already in ms — do NOT multiply by 1000
					const created = s.time?.created
						? new Date(s.time.created).toISOString()
						: mem?.startedAt?.toISOString() ?? "—"

					entries.push({
						id: s.id,
						title: mem?.title ?? s.title ?? "—",
						agent,
						status,
						duration,
						started: created,
					})
				}

				// In-memory delegations not in API yet (just launched, or API miss)
				for (const d of inMemory) {
					if (seen.has(d.id)) continue
					// Only include delegations belonging to this parent session
					entries.push({
						id: d.id,
						title: d.title ?? d.description?.slice(0, 60) ?? "—",
						agent: d.agent ?? "unknown",
						status: d.status?.toUpperCase() ?? "UNKNOWN",
						duration: d.duration ?? "—",
						started: d.startedAt?.toISOString() ?? "—",
					})
				}

				lines.push(`## Delegations (${entries.length})\n`)

				for (const e of entries) {
					lines.push(`**[${e.id}]** ${e.title}`)
					lines.push(`  Status: ${e.status} | Agent: ${e.agent} | Duration: ${e.duration}`)
					lines.push(`  Started: ${e.started}`)
					lines.push(`  \`opencode -s ${e.id}\``)
					lines.push("")
				}

				message = lines.join("\n")
			}

			// Send output to the user's session
			await typedClient.session.prompt({
				path: { id: input.sessionID },
				body: {
					noReply: true,
					parts: [{ type: "text", text: message }],
				},
			})

			throw new Error("Command handled by async-agent plugin")
		},

		tool: {
			delegate: createDelegate(manager),
			delegation_read: createDelegationRead(manager),
			delegation_list: createDelegationList(manager),
			delegation_cancel: createDelegationCancel(manager),
			delegation_resume: createDelegationResume(manager),
		},

		// Register /delegation slash command
		config: async (input: any) => {
			if (!input.command) input.command = {}
			input.command[delegationCommand] = {
				template: "Show all background delegation sessions with their status, IDs, agents, and metadata.",
				description: "List all background delegations",
			}
		},

		// Inject delegation rules + bg-agents.md config into system prompt
		"experimental.chat.system.transform": async (
			_input: { sessionID?: string; model: any },
			output: { system: string[] },
		): Promise<void> => {
			output.system.push(DELEGATION_RULES)

			// Read user's model config from ~/.config/opencode/bg-agents.md
			const bgConfig = await readBgAgentsConfig()
			if (bgConfig.trim()) {
				output.system.push(`<bg-agents-config>\n${bgConfig}\n</bg-agents-config>`)
			}
		},

		// Inject active delegation context during session compaction
		"experimental.session.compacting": async (
			_input: { sessionID: string },
			output: { context: string[] },
		): Promise<void> => {
			const running = manager.getRunningDelegations().map((d) => ({
				id: d.id,
				agent: d.agent,
				status: d.status,
				startedAt: d.startedAt,
			}))

			// Only inject if there are active delegations
			if (running.length > 0) {
				output.context.push(formatDelegationContext(running, []))
			}
		},

		event: async (input: { event: Event }): Promise<void> => {
			const { event } = input
			if (event.type === "session.idle") {
				const sessionID = (event.properties as any)?.sessionID
				const delegation = manager.findBySession(sessionID)
				if (delegation) {
					await manager.handleSessionIdle(sessionID)
				}
			}
		},
	}
}

export default AsyncAgentPlugin

import type { TextPart } from "@opencode-ai/sdk"
import {
	MAX_RUN_TIME_MS,
	type OpencodeClient,
	type Logger,
	type Delegation,
	type DelegateInput,
	type DelegationListItem,
	type ReadDelegationArgs,
	type SessionMessageItem,
	type AssistantSessionMessageItem,
} from "./types"
import { showToast, formatDuration } from "./utils"

// Same logic as OpenCode's Provider.parseModel() — first "/" splits provider from model
function parseModel(model: string): { providerID: string; modelID: string } {
	const [providerID, ...rest] = model.split("/")
	return { providerID, modelID: rest.join("/") }
}

export class DelegationManager {
	private delegations: Map<string, Delegation> = new Map()
	private client: OpencodeClient
	private log: Logger
	private pendingByParent: Map<string, Set<string>> = new Map()

	constructor(client: OpencodeClient, log: Logger) {
		this.client = client
		this.log = log
	}

	private calculateDuration(delegation: Delegation): string {
		return formatDuration(delegation.startedAt, delegation.completedAt)
	}

	// ---- Core operations ----

	async delegate(input: DelegateInput): Promise<Delegation> {
		await this.debugLog(`delegate() called`)

		// Validate agent exists
		const agentsResult = await this.client.app.agents({})
		const agents = (agentsResult.data ?? []) as {
			name: string
			description?: string
			mode?: string
		}[]
		const validAgent = agents.find((a) => a.name === input.agent)

		if (!validAgent) {
			const available = agents
				.filter((a) => a.mode === "subagent" || a.mode === "all" || !a.mode)
				.map((a) => `• ${a.name}${a.description ? ` - ${a.description}` : ""}`)
				.join("\n")

			throw new Error(
				`Agent "${input.agent}" not found.\n\nAvailable agents:\n${available || "(none)"}`,
			)
		}

		// Create isolated session — its ID becomes the delegation ID
		const sessionResult = await this.client.session.create({
			body: {
				title: `Delegation: ${input.agent}`,
				parentID: input.parentSessionID,
			},
		})

		await this.debugLog(`session.create result: ${JSON.stringify(sessionResult.data)}`)

		if (!sessionResult.data?.id) {
			throw new Error("Failed to create delegation session")
		}

		// Use OpenCode session ID as the delegation ID
		const sessionID = sessionResult.data.id

		const delegation: Delegation = {
			id: sessionID,
			sessionID: sessionID,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			prompt: input.prompt,
			agent: input.agent,
			model: input.model,
			status: "running",
			startedAt: new Date(),
			progress: {
				toolCalls: 0,
				lastUpdate: new Date(),
			},
		}

		await this.debugLog(`Created delegation ${delegation.id}`)
		this.delegations.set(delegation.id, delegation)

		// Track for batched notification
		const parentId = input.parentSessionID
		if (!this.pendingByParent.has(parentId)) {
			this.pendingByParent.set(parentId, new Set())
		}
		this.pendingByParent.get(parentId)?.add(delegation.id)
		await this.debugLog(
			`Tracking delegation ${delegation.id} for parent ${parentId}. Pending count: ${this.pendingByParent.get(parentId)?.size}`,
		)

		// Timeout timer
		setTimeout(() => {
			const current = this.delegations.get(delegation.id)
			if (current && current.status === "running") {
				this.handleTimeout(delegation.id)
			}
		}, MAX_RUN_TIME_MS + 5000)

		// Toast: task launched
		showToast(this.client, "New Background Task", `${delegation.id} (${input.agent})`, "info", 3000)

		// Fire the prompt — optionally override model if specified
		const promptBody: any = {
			agent: input.agent,
			parts: [{ type: "text", text: input.prompt }],
			tools: {
				task: false,
				delegate: false,
				todowrite: false,
				plan_save: false,
			},
		}
		if (input.model) {
			promptBody.model = parseModel(input.model)
		}

		this.client.session
			.prompt({
				path: { id: delegation.sessionID },
				body: promptBody,
			})
			.catch((error: Error) => {
				delegation.status = "error"
				delegation.error = error.message
				delegation.completedAt = new Date()
				delegation.duration = this.calculateDuration(delegation)
				this.notifyParent(delegation)
			})

		return delegation
	}

	async resume(delegationId: string, newPrompt?: string): Promise<Delegation> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation) {
			throw new Error(`Delegation "${delegationId}" not found`)
		}

		if (delegation.status !== "cancelled" && delegation.status !== "error") {
			throw new Error(`Cannot resume delegation: status is "${delegation.status}". Only cancelled or error tasks can be resumed.`)
		}

		// Reset status
		delegation.status = "running"
		delegation.completedAt = undefined
		delegation.error = undefined
		delegation.startedAt = new Date()
		delegation.progress = {
			toolCalls: 0,
			lastUpdate: new Date(),
		}

		// Track again
		const parentId = delegation.parentSessionID
		if (!this.pendingByParent.has(parentId)) {
			this.pendingByParent.set(parentId, new Set())
		}
		this.pendingByParent.get(parentId)?.add(delegation.id)

		// Send continue prompt to same session — reuse model if set
		const prompt = newPrompt || "Continue from where you left off."

		const resumeBody: any = {
			agent: delegation.agent,
			parts: [{ type: "text", text: prompt }],
			tools: {
				task: false,
				delegate: false,
				todowrite: false,
				plan_save: false,
			},
		}
		if (delegation.model) {
			resumeBody.model = parseModel(delegation.model)
		}

		this.client.session
			.prompt({
				path: { id: delegation.sessionID },
				body: resumeBody,
			})
			.catch((error: Error) => {
				delegation.status = "error"
				delegation.error = error.message
				delegation.completedAt = new Date()
				delegation.duration = this.calculateDuration(delegation)
				this.notifyParent(delegation)
			})

		await this.debugLog(`Resumed delegation ${delegation.id}`)
		return delegation
	}

	async cancel(delegationId: string): Promise<boolean> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation) return false
		if (delegation.status !== "running") return false

		// Abort the session
		try {
			await this.client.session.abort({
				path: { id: delegation.sessionID },
			})
		} catch {
			// Ignore abort errors
		}

		delegation.status = "cancelled"
		delegation.completedAt = new Date()
		delegation.duration = this.calculateDuration(delegation)

		// Remove from pending
		const pendingSet = this.pendingByParent.get(delegation.parentSessionID)
		if (pendingSet) {
			pendingSet.delete(delegationId)
		}

		await this.notifyParent(delegation)

		// Toast: task cancelled
		showToast(this.client, "Task Cancelled", `${delegation.id} cancelled (${delegation.duration})`, "info", 3000)

		await this.debugLog(`Cancelled delegation ${delegation.id}`)
		return true
	}

	async cancelAll(parentSessionID: string): Promise<string[]> {
		const cancelled: string[] = []

		for (const delegation of this.delegations.values()) {
			if (delegation.parentSessionID === parentSessionID && delegation.status === "running") {
				const success = await this.cancel(delegation.id)
				if (success) {
					cancelled.push(delegation.id)
				}
			}
		}

		return cancelled
	}

	// ---- Event handlers ----

	private async handleTimeout(delegationId: string): Promise<void> {
		const delegation = this.delegations.get(delegationId)
		if (!delegation || delegation.status !== "running") return

		await this.debugLog(`handleTimeout for delegation ${delegation.id}`)

		delegation.status = "timeout"
		delegation.completedAt = new Date()
		delegation.duration = this.calculateDuration(delegation)
		delegation.error = `Delegation timed out after ${MAX_RUN_TIME_MS / 1000}s`

		try {
			await this.client.session.abort({
				path: { id: delegation.sessionID },
			})
		} catch {
			// Ignore
		}

		await this.notifyParent(delegation)
	}

	async handleSessionIdle(sessionID: string): Promise<void> {
		const delegation = this.findBySession(sessionID)
		if (!delegation || delegation.status !== "running") return

		await this.debugLog(`handleSessionIdle for delegation ${delegation.id}`)

		delegation.status = "completed"
		delegation.completedAt = new Date()
		delegation.duration = this.calculateDuration(delegation)

		// Extract title/description from first user message
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})
			const messageData = messages.data as SessionMessageItem[] | undefined
			if (messageData && messageData.length > 0) {
				const firstUser = messageData.find(m => m.info.role === "user")
				if (firstUser) {
					const textPart = firstUser.parts.find((p): p is TextPart => p.type === "text")
					if (textPart) {
						delegation.description = textPart.text.slice(0, 150)
						delegation.title = textPart.text.split('\n')[0].slice(0, 50)
					}
				}
			}
		} catch {
			// Ignore
		}

		showToast(
			this.client,
			"Task Completed",
			`"${delegation.id}" finished in ${delegation.duration}`,
			"success",
			5000,
		)

		await this.notifyParent(delegation)
	}

	// ---- Read delegation results ----

	async readDelegation(args: ReadDelegationArgs): Promise<string> {
		const delegation = this.delegations.get(args.id)
		if (!delegation) {
			throw new Error(`Delegation "${args.id}" not found.\n\nUse delegation_list() to see available delegations.`)
		}

		if (delegation.status === "running") {
			return `Delegation "${args.id}" is still running.\n\nStatus: ${delegation.status}\nStarted: ${delegation.startedAt.toISOString()}\n\nWait for completion notification, then call delegation_read() again.`
		}

		if (delegation.status !== "completed") {
			let statusMessage = `Delegation "${args.id}" ended with status: ${delegation.status}`
			if (delegation.error) statusMessage += `\n\nError: ${delegation.error}`
			if (delegation.duration) statusMessage += `\n\nDuration: ${delegation.duration}`
			return statusMessage
		}

		if (!args.mode || args.mode === "simple") {
			return await this.getSimpleResult(delegation)
		}

		if (args.mode === "full") {
			return await this.getFullSession(delegation, args)
		}

		return "Invalid mode. Use 'simple' or 'full'."
	}

	private async getSimpleResult(delegation: Delegation): Promise<string> {
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messages.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				return `Delegation "${delegation.id}" completed but produced no output.`
			}

			const assistantMessages = messageData.filter(
				(m): m is AssistantSessionMessageItem => m.info.role === "assistant"
			)

			if (assistantMessages.length === 0) {
				return `Delegation "${delegation.id}" completed but produced no assistant response.`
			}

			const lastMessage = assistantMessages[assistantMessages.length - 1]
			const textParts = lastMessage.parts.filter((p): p is TextPart => p.type === "text")

			if (textParts.length === 0) {
				return `Delegation "${delegation.id}" completed but produced no text content.`
			}

			const result = textParts.map((p) => p.text).join("\n")

			const header = `# Task Result: ${delegation.id}

**Agent:** ${delegation.agent}
**Status:** ${delegation.status}
**Duration:** ${delegation.duration || "N/A"}
**Started:** ${delegation.startedAt.toISOString()}
${delegation.completedAt ? `**Completed:** ${delegation.completedAt.toISOString()}` : ""}

---

`

			return header + result
		} catch (error) {
			return `Error retrieving result: ${error instanceof Error ? error.message : "Unknown error"}`
		}
	}

	private async getFullSession(delegation: Delegation, args: ReadDelegationArgs): Promise<string> {
		try {
			const messages = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messages.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				return `Delegation "${delegation.id}" has no messages.`
			}

			const sortedMessages = [...messageData].sort((a, b) => {
				const timeA = String(a.info.time || "")
				const timeB = String(b.info.time || "")
				return timeA.localeCompare(timeB)
			})

			let filteredMessages = sortedMessages
			if (args.since_message_id) {
				const index = sortedMessages.findIndex((m) => m.info.id === args.since_message_id)
				if (index !== -1) {
					filteredMessages = sortedMessages.slice(index + 1)
				}
			}

			const limit = args.limit ? Math.min(args.limit, 100) : undefined
			const hasMore = limit !== undefined && filteredMessages.length > limit
			const visibleMessages = limit !== undefined ? filteredMessages.slice(0, limit) : filteredMessages

			const lines: string[] = []
			lines.push(`# Full Session: ${delegation.id}`)
			lines.push("")
			lines.push(`**Agent:** ${delegation.agent}`)
			lines.push(`**Status:** ${delegation.status}`)
			lines.push(`**Duration:** ${delegation.duration || "N/A"}`)
			lines.push(`**Total messages:** ${sortedMessages.length}`)
			lines.push(`**Returned:** ${visibleMessages.length}`)
			lines.push(`**Has more:** ${hasMore ? "true" : "false"}`)
			lines.push("")
			lines.push("## Messages")
			lines.push("")

			for (const message of visibleMessages) {
				const role = message.info.role
				const time = message.info.time || "unknown"
				const id = message.info.id || "unknown"

				lines.push(`### [${role}] ${time} (id: ${id})`)
				lines.push("")

				for (const part of message.parts) {
					if (part.type === "text" && part.text) {
						lines.push(part.text.trim())
						lines.push("")
					}

					if (args.include_thinking && (part.type === "thinking" || part.type === "reasoning")) {
						const thinkingText = (part as any).thinking || (part as any).text || ""
						if (thinkingText) {
							lines.push(`[thinking] ${thinkingText.slice(0, 2000)}`)
							lines.push("")
						}
					}

					if (args.include_tools && part.type === "tool_result") {
						const content = (part as any).content || (part as any).output || ""
						if (content) {
							lines.push(`[tool result] ${content}`)
							lines.push("")
						}
					}
				}
			}

			return lines.join("\n")
		} catch (error) {
			return `Error fetching session: ${error instanceof Error ? error.message : "Unknown error"}`
		}
	}

	// ---- Notification ----

	private async notifyParent(delegation: Delegation): Promise<void> {
		try {
			const pendingSet = this.pendingByParent.get(delegation.parentSessionID)
			if (pendingSet) {
				pendingSet.delete(delegation.id)
			}

			const allComplete = !pendingSet || pendingSet.size === 0
			const remainingCount = pendingSet?.size || 0

			const statusText = delegation.status === "completed" ? "COMPLETED"
				: delegation.status === "cancelled" ? "CANCELLED"
				: delegation.status === "error" ? "ERROR"
				: delegation.status === "timeout" ? "TIMEOUT"
				: delegation.status.toUpperCase()
			const duration = delegation.duration || "N/A"
			const errorInfo = delegation.error ? `\n**Error:** ${delegation.error}` : ""

			let notification: string

			if (allComplete) {
				const completedTasks: Delegation[] = []
				for (const d of this.delegations.values()) {
					if (d.parentSessionID === delegation.parentSessionID && d.status !== "running") {
						completedTasks.push(d)
					}
				}
				const completedList = completedTasks
					.map(t => `- \`${t.id}\`: ${t.title || t.prompt.slice(0, 80)}`)
					.join("\n")

				const sessionHints = completedTasks
					.map(t => `opencode -s ${t.id}`)
					.join("\n")

				notification = `<system-reminder>
[ALL BACKGROUND TASKS COMPLETE]

**Completed:**
${completedList || `- \`${delegation.id}\`: ${delegation.title || delegation.prompt.slice(0, 80)}`}

Use \`delegation_read(id="<id>")\` to retrieve each result.
</system-reminder>
To inspect session content(human): ${sessionHints || `opencode -s ${delegation.id}`}`
			} else {
				notification = `<system-reminder>
[BACKGROUND TASK ${statusText}]
**ID:** \`${delegation.id}\`
**Agent:** ${delegation.agent}
**Duration:** ${duration}${errorInfo}

**${remainingCount} task${remainingCount === 1 ? "" : "s"} still in progress.** You WILL be notified when ALL complete.
Do NOT poll - continue productive work.

Use \`delegation_read(id="${delegation.id}")\` to retrieve this result when ready.
</system-reminder>
To inspect session content(human): opencode -s ${delegation.id}`
			}

			await this.client.session.prompt({
				path: { id: delegation.parentSessionID },
				body: {
					noReply: !allComplete,
					agent: delegation.parentAgent,
					parts: [{ type: "text", text: notification }],
				},
			})

			await this.debugLog(
				`Notified parent session ${delegation.parentSessionID} (status=${statusText}, remaining=${remainingCount})`,
			)
		} catch (error) {
			await this.debugLog(
				`Failed to notify parent: ${error instanceof Error ? error.message : "Unknown error"}`,
			)
		}
	}

	// ---- Queries ----

	async listDelegations(parentSessionID: string): Promise<DelegationListItem[]> {
		const results: DelegationListItem[] = []

		for (const delegation of this.delegations.values()) {
			if (delegation.parentSessionID === parentSessionID) {
				results.push({
					id: delegation.id,
					status: delegation.status,
					title: delegation.title,
					description: delegation.description,
					agent: delegation.agent,
					duration: delegation.duration,
					startedAt: delegation.startedAt,
				})
			}
		}

		return results.sort((a, b) => (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0))
	}

	listAllDelegations(): DelegationListItem[] {
		const results: DelegationListItem[] = []
		for (const delegation of this.delegations.values()) {
			results.push({
				id: delegation.id,
				status: delegation.status,
				title: delegation.title,
				description: delegation.description,
				agent: delegation.agent,
				duration: delegation.duration,
				startedAt: delegation.startedAt,
			})
		}
		return results.sort((a, b) => (b.startedAt?.getTime() || 0) - (a.startedAt?.getTime() || 0))
	}

	findBySession(sessionID: string): Delegation | undefined {
		return Array.from(this.delegations.values()).find((d) => d.sessionID === sessionID)
	}

	handleMessageEvent(sessionID: string, messageText?: string): void {
		const delegation = this.findBySession(sessionID)
		if (!delegation || delegation.status !== "running") return

		delegation.progress.lastUpdate = new Date()
		if (messageText) {
			delegation.progress.lastMessage = messageText
			delegation.progress.lastMessageAt = new Date()
		}
	}

	getPendingCount(parentSessionID: string): number {
		const pendingSet = this.pendingByParent.get(parentSessionID)
		return pendingSet ? pendingSet.size : 0
	}

	getRunningDelegations(): Delegation[] {
		return Array.from(this.delegations.values()).filter((d) => d.status === "running")
	}

	async debugLog(msg: string): Promise<void> {
		this.log.debug(msg)
	}
}

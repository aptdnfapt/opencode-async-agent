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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { join } from "path"

// Same logic as OpenCode's Provider.parseModel() — first "/" splits provider from model
function parseModel(model: string): { providerID: string; modelID: string } {
	const [providerID, ...rest] = model.split("/")
	return { providerID, modelID: rest.join("/") }
}

const ANALYSIS_PROMPT = `You are a session analyst. Analyze the following AI task execution comprehensively so the main agent can make informed next decisions.

## Analysis Criteria

### 1. Anything AI Missed Based on Initial Prompt
- Compare the original user prompt against what was actually accomplished
- Identify any requirements, questions, or requests that were never addressed
- List promises made by the agent that were left unfulfilled

### 2. Wrong Doings
- Identify incorrect assumptions or bad approaches taken
- Note any factual errors or wrong technical decisions
- Call out misinterpretations of the original prompt

### 3. Gave Up / Shortcuts
- Did the agent abandon parts of the task prematurely?
- Were steps skipped or incomplete solutions used?
- Did the agent stop without exhausting reasonable options?
- Any signs of "good enough" attitude instead of thorough completion?

### 4. Messed Up
- Did the agent break existing functionality?
- Were new problems introduced during the task?
- Any destructive actions or unintended side effects?

### 5. Good Points / Choices
- What technical decisions were sound and should be replicated?
- What approaches worked well that future tasks should follow?
- Notable strengths in this session's execution

### 6. Session Ended Properly or Stream Cut Out
- **Proper finish:** Agent concluded with clear result or summary
- **Stream cut out:** Session interrupted mid-task with no conclusion
- **Ambiguous end:** Final state unclear or incomplete explanation

### 7. Overall Status on the Session
- Give the main agent a complete picture of what happened
- Was this session successful, partial, or a failure?
- Is the output reliable enough to base next decisions on?

## Output Format

Provide your analysis in **markdown** with these exact sections:

### Summary
[2-3 sentence summary of what happened]

### What the AI Missed Based on Initial Prompt
[List anything not covered from the original prompt]

### Wrong Doings
[Incorrect assumptions, bad approaches, factual errors]

### Gave Up / Shortcuts
[Premature abandonment, skipped steps, incomplete solutions]

### Messed Up
[Broke things, created new problems, unintended side effects]

### Good Points / Choices
[Sound decisions, approaches worth replicating, notable strengths]

### Session Completion
- **Status:** [Proper finish / Stream cut out / Ambiguous]
- **Details:** [explanation of how the session ended]

### Overall Status
[Complete assessment: Is this session's output reliable for next decisions? What's the verdict?]

### Next Action for Main Agent
[Specific recommendation on what the main agent should do next based on this session's outcome]

---

## Session Data

### Initial User Prompt
\`\`\`
\${initialPrompt}
\`\`\`

### Full Conversation
\`\`\`
\${formattedMessages}
\`\`\`

### Session Metadata
- Agent: \${agent}
- Model: \${model}
- Duration: \${duration}
- Status: \${status}
- Started: \${startTime}
- Completed: \${completedTime}
`

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

	// ---- Parent session model ----

	async getParentModel(parentSessionID: string): Promise<string | null> {
		try {
			const messagesResult = await this.client.session.messages({
				path: { id: parentSessionID },
			})

			const messageData = messagesResult.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				return null
			}

			const lastUserMessage = [...messageData].reverse().find((m) => m.info.role === "user")

			if (!lastUserMessage || !lastUserMessage.info.model) {
				return null
			}

			const model = lastUserMessage.info.model
			const modelString = `${model.providerID}/${model.modelID}`

			await this.debugLog(`Got parent model: ${modelString}`)
			return modelString
		} catch (error) {
			this.log.debug(`Failed to get parent model: ${error instanceof Error ? error.message : "Unknown error"}`)
			return null
		}
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

		const parentModel = await this.getParentModel(input.parentSessionID)

		const delegation: Delegation = {
			id: sessionID,
			sessionID: sessionID,
			parentSessionID: input.parentSessionID,
			parentMessageID: input.parentMessageID,
			parentAgent: input.parentAgent,
			parentModel: parentModel,
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

		if (delegation.status === "running") {
			throw new Error(`Delegation is already running. Wait for it to complete or cancel it first.`)
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

		// Set cancelled BEFORE abort to prevent race with session.idle event
		// Otherwise handleSessionIdle() sees status="running" and marks it "completed"
		delegation.status = "cancelled"
		delegation.completedAt = new Date()
		delegation.duration = this.calculateDuration(delegation)

		// Abort the session
		try {
			await this.client.session.abort({
				path: { id: delegation.sessionID },
			})
		} catch {
			// Ignore abort errors
		}

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
			if (args.ai) {
				return `Delegation "${args.id}" is still running.\n\nStatus: ${delegation.status}\nStarted: ${delegation.startedAt.toISOString()}\n\nWait for completion notification, then call delegation_read() again. AI analysis only available for completed sessions.`
			}
			return `Delegation "${args.id}" is still running.\n\nStatus: ${delegation.status}\nStarted: ${delegation.startedAt.toISOString()}\n\nWait for completion notification, then call delegation_read() again.`
		}

		if (delegation.status !== "completed") {
			let statusMessage = `Delegation "${args.id}" ended with status: ${delegation.status}`
			if (delegation.error) statusMessage += `\n\nError: ${delegation.error}`
			if (delegation.duration) statusMessage += `\n\nDuration: ${delegation.duration}`
			return statusMessage
		}

		if (args.ai) {
			let model = args.ai_model
			if (!model) {
				model = delegation.parentModel || await this.getDefaultModel()
				if (!model) {
					return "❌ ai_model required when ai=true and no default model configured (parent session has no model)"
				}
			}
			return await this.analyzeSessionWithAI(delegation, model)
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

		// Fire and forget - don't await to avoid deadlock when parent session is busy
		this.client.session.prompt({
			path: { id: delegation.parentSessionID },
			body: {
				noReply: !allComplete,
				agent: delegation.parentAgent,
				parts: [{ type: "text", text: notification }],
			},
		}).catch(() => {})

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

	// ---- AI Analysis ----

	async getDefaultModel(): Promise<string | null> {
		try {
			const result = await this.client.config.get()
			const config = result.data as any
			return config?.model || null
		} catch (error) {
			this.log.debug(`Failed to get default model: ${error instanceof Error ? error.message : "Unknown error"}`)
			return null
		}
	}

	getModelInfo(modelId: string): { provider: string; apiUrl: string; modelId: string } {
		const [provider, ...rest] = modelId.split("/")
		if (!provider) {
			throw new Error(`Invalid model format: "${modelId}". Expected "provider/model"`)
		}
		const modelIdOnly = rest.join("/")

		try {
			const modelJsonPath = join(process.env.HOME || "", ".cache", "opencode", "models.json")
			const content = readFileSync(modelJsonPath, "utf-8")
			const modelsData = JSON.parse(content)

			if (!modelsData[provider]) {
				throw new Error(`Provider "${provider}" not found in models.json`)
			}

			const providerData = modelsData[provider]
			const apiUrl = providerData.api || providerData.baseUrl

			if (!apiUrl) {
				throw new Error(`No API URL found for provider "${provider}"`)
			}

			return { provider, apiUrl, modelId: modelIdOnly }
		} catch (error) {
			if (error instanceof Error) throw error
			throw new Error(`Failed to parse models.json: ${error}`)
		}
	}

	getApiKey(provider: string): string {
		try {
			const authJsonPath = join(process.env.HOME || "", ".local", "share", "opencode", "auth.json")
			const content = readFileSync(authJsonPath, "utf-8")
			const authData = JSON.parse(content)

			if (!authData[provider]) {
				throw new Error(`Provider "${provider}" not found in auth.json`)
			}

			const providerAuth = authData[provider]
			if (providerAuth.type !== "api") {
				throw new Error(`Provider "${provider}" is not an API key type`)
			}

			return providerAuth.key
		} catch (error) {
			if (error instanceof Error) throw error
			throw new Error(`Failed to parse auth.json: ${error}`)
		}
	}

	formatSessionForAI(messages: SessionMessageItem[], delegation: Delegation): string {
		let initialPrompt = delegation.prompt

		const parts: string[] = []

		for (const msg of messages) {
			const role = msg.info.role.toUpperCase()
			const timestamp = msg.info.time?.created ? new Date(msg.info.time.created).toISOString() : "unknown"

			parts.push(`[${role}] ${timestamp}`)

			for (const part of msg.parts) {
				switch (part.type) {
					case "text":
						if (part.text) {
							parts.push(part.text.trim())
						}
						break
					case "reasoning":
					case "thinking":
						const thinkingText = (part as any).thinking || (part as any).text || ""
						if (thinkingText) {
							parts.push(`[REASONING] ${thinkingText.slice(0, 2000)}`)
						}
						break
					case "tool":
						if (part.state) {
							const toolInput = part.state.status === "pending" || part.state.status === "running"
								? JSON.stringify(part.state.input || {})
								: JSON.stringify(part.state.input || {})
							parts.push(`[TOOL CALL] ${part.tool}: ${toolInput}`)
						}
						break
					case "tool_result":
						const content = (part as any).content || (part as any).output || ""
						parts.push(`[TOOL RESULT] ${content}`)
						break
					case "file":
						parts.push(`[FILE] ${part.filename || "unknown file"} (${part.mime})`)
						break
					case "patch":
						parts.push(`[PATCH] Code diff applied`)
						break
					case "snapshot":
						parts.push(`[SNAPSHOT] State snapshot`)
						break
					case "agent":
						parts.push(`[AGENT] Switched to: ${(part as any).name || "unknown"}`)
						break
					default:
						parts.push(`[${part.type}] ${JSON.stringify(part).slice(0, 200)}`)
				}
			}

			parts.push("")
		}

		return `# Full Conversation

${parts.join("\n")}`
	}

	async callAIForAnalysis(
		apiUrl: string,
		apiKey: string,
		model: string,
		prompt: string,
		timeoutMs: number = 60000,
	): Promise<string> {
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

		try {
			const url = apiUrl.endsWith("/") ? `${apiUrl}chat/completions` : `${apiUrl}/chat/completions`

			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: model,
					messages: [{ role: "user", content: prompt }],
					max_tokens: 4000,
					temperature: 0.3,
				}),
				signal: controller.signal,
			})

			clearTimeout(timeoutId)

			if (!response.ok) {
				const errorText = await response.text()
				throw new Error(`API request failed: ${response.status} ${response.statusText}\n${errorText}`)
			}

			const data = await response.json()

			if (!data.choices || !data.choices[0] || !data.choices[0].message) {
				throw new Error("Invalid API response format")
			}

			return data.choices[0].message.content
		} catch (error) {
			if ((error as Error).name === "AbortError") {
				throw new Error("AI analysis timed out after 60 seconds")
			}
			throw error
		}
	}

	logAnalysis(
		delegationId: string,
		model: string,
		result: string,
		error?: string,
		duration?: number,
	): void {
		if (process.env.OC_ASYNC_DEBUG !== "true") {
			return
		}

		try {
			const logDir = join(process.env.HOME || "", ".cache", "opencode-delegation-ai")
			if (!existsSync(logDir)) {
				mkdirSync(logDir, { recursive: true })
			}

			const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
			const filename = `analysis-${delegationId}-${timestamp}.json`

			const logEntry = {
				timestamp: new Date().toISOString(),
				delegationId,
				model,
				status: error ? "error" : "success",
				durationMs: duration,
				result: error ? undefined : result,
				error: error || undefined,
			}

			writeFileSync(join(logDir, filename), JSON.stringify(logEntry, null, 2))
		} catch (err) {
			this.log.debug(`Failed to log analysis: ${err}`)
		}
	}

	async analyzeSessionWithAI(delegation: Delegation, model: string): Promise<string> {
		const startTime = Date.now()

		try {
			const modelInfo = this.getModelInfo(model)
			const apiKey = this.getApiKey(modelInfo.provider)

			const messagesResult = await this.client.session.messages({
				path: { id: delegation.sessionID },
			})

			const messageData = messagesResult.data as SessionMessageItem[] | undefined

			if (!messageData || messageData.length === 0) {
				return `Delegation "${delegation.id}" has no messages to analyze.`
			}

			const formattedMessages = this.formatSessionForAI(messageData, delegation)

			const initialPrompt = messageData.find((m) => m.info.role === "user")?.parts
				.filter((p): p is TextPart => p.type === "text")
				.map((p) => p.text)
				.join("\n") || delegation.prompt

			const sessionMetadata = `
### Session Metadata
- Agent: ${delegation.agent}
- Model: ${delegation.model || "unknown"}
- Duration: ${delegation.duration || "N/A"}
- Status: ${delegation.status}
- Started: ${delegation.startedAt.toISOString()}
- Completed: ${delegation.completedAt?.toISOString() || "N/A"}
`

			const fullPrompt = ANALYSIS_PROMPT
				.replace("${initialPrompt}", initialPrompt)
				.replace("${formattedMessages}", formattedMessages)
				.replace("${agent}", delegation.agent)
				.replace("${model}", delegation.model || "unknown")
				.replace("${duration}", delegation.duration || "N/A")
				.replace("${status}", delegation.status)
				.replace("${startTime}", delegation.startedAt.toISOString())
				.replace("${completedTime}", delegation.completedAt?.toISOString() || "N/A")

			const analysis = await this.callAIForAnalysis(modelInfo.apiUrl, apiKey, modelInfo.modelId, fullPrompt)

			const duration = Date.now() - startTime
			this.logAnalysis(delegation.id, model, analysis, undefined, duration)

			const header = `# AI Analysis for Delegation: ${delegation.id}

**Agent:** ${delegation.agent}
**Analysis Model:** ${model}
**Duration:** ${delegation.duration || "N/A"}
**Analysis Time:** ${(duration / 1000).toFixed(2)}s

---

`

			return header + analysis
		} catch (error) {
			const duration = Date.now() - startTime
			const errorMessage = error instanceof Error ? error.message : "Unknown error"
			this.logAnalysis(delegation.id, model, "", errorMessage, duration)
			return `❌ AI analysis failed:\n\n${errorMessage}`
		}
	}
}

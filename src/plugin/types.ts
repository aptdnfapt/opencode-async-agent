import type { Message, Part } from "@opencode-ai/sdk"
import type { createOpencodeClient } from "@opencode-ai/sdk"

// OpenCode client instance type
export type OpencodeClient = ReturnType<typeof createOpencodeClient>

// Logger returned by createLogger
export type Logger = {
	debug: (msg: string) => void
	info: (msg: string) => void
	warn: (msg: string) => void
	error: (msg: string) => void
}

// 15 minute max run time per delegation
export const MAX_RUN_TIME_MS = 15 * 60 * 1000

export interface SessionMessageItem {
	info: Message
	parts: Part[]
}

export interface AssistantSessionMessageItem {
	info: Message & { role: "assistant" }
	parts: Part[]
}

export interface DelegationProgress {
	toolCalls: number
	lastUpdate: Date
	lastMessage?: string
	lastMessageAt?: Date
}

export interface Delegation {
	id: string // OpenCode session ID (same as sessionID — used for delegation_read, opencode -s, etc.)
	sessionID: string // Same as id — kept for clarity in API calls
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	model?: string // Full "provider/model" string (e.g. "minimax/MiniMax-M2.5")
	status: "running" | "completed" | "error" | "cancelled" | "timeout"
	startedAt: Date
	completedAt?: Date
	duration?: string
	progress: DelegationProgress
	error?: string
	title?: string
	description?: string
}

export interface DelegateInput {
	parentSessionID: string
	parentMessageID: string
	parentAgent: string
	prompt: string
	agent: string
	model?: string // Full "provider/model" string — split via parseModel() before passing to session.prompt()
}

export interface DelegationListItem {
	id: string
	status: string
	title?: string
	description?: string
	agent?: string
	duration?: string
	startedAt?: Date
}

export interface ReadDelegationArgs {
	id: string
	mode?: "simple" | "full"
	include_thinking?: boolean
	include_tools?: boolean
	since_message_id?: string
	limit?: number
}

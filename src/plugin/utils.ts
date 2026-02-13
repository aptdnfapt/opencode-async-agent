import type { OpencodeClient, Logger } from "./types"

// Structured logger → OpenCode log API
// Catches errors silently to avoid disrupting tool execution
export function createLogger(client: OpencodeClient): Logger {
	const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
		client.app.log({ body: { service: "async-agent", level, message } }).catch(() => {})
	return {
		debug: (msg: string) => log("debug", msg),
		info: (msg: string) => log("info", msg),
		warn: (msg: string) => log("warn", msg),
		error: (msg: string) => log("error", msg),
	}
}

// Shows toast in OpenCode TUI (top-right notification)
// Casts client to any + optional chaining = graceful no-op if unavailable
export function showToast(
	client: OpencodeClient,
	title: string,
	message: string,
	variant: "info" | "success" | "error" = "info",
	duration = 3000,
) {
	const tuiClient = client as any
	if (!tuiClient.tui?.showToast) return
	tuiClient.tui.showToast({
		body: { title, message, variant, duration },
	}).catch(() => {})
}

// Format ms duration into human-readable string (e.g. "2m 30s")
export function formatDuration(startedAt: Date, completedAt?: Date): string {
	const end = completedAt || new Date()
	const diffMs = end.getTime() - startedAt.getTime()
	const diffSec = Math.floor(diffMs / 1000)

	if (diffSec < 60) {
		return `${diffSec}s`
	}

	const diffMin = Math.floor(diffSec / 60)
	if (diffMin < 60) {
		const secs = diffSec % 60
		return secs > 0 ? `${diffMin}m ${secs}s` : `${diffMin}m`
	}

	const diffHour = Math.floor(diffMin / 60)
	const mins = diffMin % 60
	return mins > 0 ? `${diffHour}h ${mins}m` : `${diffHour}h`
}

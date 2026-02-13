// System prompt rules injected to teach the agent how to use delegation tools
export const DELEGATION_RULES = `<system-reminder>
<delegation-system>

## Async Delegation

You have tools for parallel background work:
- \`delegate(prompt, agent)\` - Launch task, returns ID immediately
- \`delegate(prompt, agent, model)\` - Launch task with specific model override
- \`delegation_read(id)\` - Retrieve completed result
- \`delegation_list()\` - List delegations (use sparingly)
- \`delegation_cancel(id|all)\` - Cancel running task(s)
- \`delegation_resume(id, prompt?)\` - Continue cancelled task (same session)

## How It Works

1. Call \`delegate()\` - Get task ID immediately, continue working
2. Receive \`<system-reminder>\` notification when complete
3. Call \`delegation_read(id)\` to get the actual result

## Model Override

The \`delegate\` tool accepts an optional \`model\` parameter in "provider/model" format.
Example: \`delegate(prompt, agent, model="minimax/MiniMax-M2.5")\`
If not specified, the agent's default model is used.

## Critical Constraints

**NEVER poll \`delegation_list\` to check completion.**
You WILL be notified via \`<system-reminder>\`. Polling wastes tokens.

**NEVER wait idle.** Always have productive work while delegations run.

**Cancelled tasks can be resumed** with \`delegation_resume()\` - same session, full context.

</delegation-system>
</system-reminder>`

// Read user's async-agent.md config file — contains model preferences for delegation
// Returns file content or empty string if not found
export async function readBgAgentsConfig(): Promise<string> {
	const { homedir } = await import("os")
	const { readFile } = await import("fs/promises")
	const { join } = await import("path")

	const configPath = join(homedir(), ".config", "opencode", "async-agent.md")
	try {
		return await readFile(configPath, "utf-8")
	} catch {
		return ""
	}
}

// Context injected during compaction so the agent remembers active delegations
interface DelegationForContext {
	id: string
	agent?: string
	title?: string
	description?: string
	status: string
	startedAt?: Date
	duration?: string
}

export function formatDelegationContext(
	running: DelegationForContext[],
	completed: DelegationForContext[],
): string {
	const sections: string[] = ["<delegation-context>"]

	if (running.length > 0) {
		sections.push("## Running Delegations")
		sections.push("")
		for (const d of running) {
			sections.push(`### \`${d.id}\`${d.agent ? ` (${d.agent})` : ""}`)
			if (d.startedAt) {
				sections.push(`**Started:** ${d.startedAt.toISOString()}`)
			}
			sections.push("")
		}
		sections.push("> **Note:** You WILL be notified via \`<system-reminder>\` when delegations complete.",
		)
		sections.push("> Do NOT poll \`delegation_list\` - continue productive work.")
		sections.push("")
	}

	if (completed.length > 0) {
		sections.push("## Recent Completed Delegations")
		sections.push("")
		for (const d of completed) {
			const statusEmoji =
				d.status === "completed"
					? "✅"
					: d.status === "error"
						? "❌"
						: d.status === "timeout"
							? "⏱️"
							: "🚫"
			sections.push(`### ${statusEmoji} \`${d.id}\``)
			sections.push(`**Status:** ${d.status}`)
			if (d.duration) sections.push(`**Duration:** ${d.duration}`)
			sections.push("")
		}
		sections.push("> Use \`delegation_list()\` to see all delegations.")
		sections.push("")
	}

	sections.push("## Retrieval")
	sections.push('Use \`delegation_read("id")\` to access results.')
	sections.push("Use \`delegation_read(id, mode=\"full\")\` for full conversation.")
	sections.push("</delegation-context>")

	return sections.join("\n")
}

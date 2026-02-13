# AGENTS.md — opencode-async-agent

## What This Is

OpenCode plugin providing async background delegation. TypeScript source in `src/plugin/`, bundled via esbuild to `dist/async-agent.js`. No test framework. No linter configured.

## Build

```bash
# Install deps
npm install

# Build
npm run build

# Verify build worked
ls -la dist/async-agent.js
```

## Project Structure

```
src/plugin/
  plugin.ts    — Entry point. Registers tools, hooks, slash commands, events
  manager.ts   — DelegationManager class. Core state machine for delegations
  tools.ts     — Tool factories (delegate, read, list, cancel, resume)
  types.ts     — All interfaces and type definitions
  rules.ts     — System prompt injection + compaction context
  utils.ts     — Logger, toast, formatDuration helpers
dist/
  async-agent.js  — Bundled output (committed)
```

## Code Style

### TypeScript
- Strict types, no `any` except when casting OpenCode client for optional APIs
- Use `type` imports: `import type { Foo } from "./types"`
- Tabs for indentation, no semicolons (except rare cases)
- Double quotes for strings
- Interfaces over type aliases for object shapes

### Naming
- PascalCase: classes (`DelegationManager`), interfaces (`Delegation`, `DelegateInput`)
- camelCase: functions (`createDelegate`), variables, methods
- UPPER_SNAKE: constants (`MAX_RUN_TIME_MS`, `DELEGATION_RULES`)
- Slash command names: kebab-case strings (`"delegation"`)

### Imports
- Group order: external packages → local types → local modules
- Always use relative paths (`"./types"`, `"./manager"`)
- External deps are `@opencode-ai/plugin` and `@opencode-ai/sdk` only

### Functions
- Tool creators follow factory pattern: `createXxx(manager) → tool({...})`
- Tools return `string` (success message or error text), never throw to caller
- Prefix user-facing errors with `❌`
- Manager methods are `async` and return typed results

### Error Handling
- Tools: try/catch → return error string (never throw)
- Async fire-and-forget: `.catch(() => {})` on non-critical promises (logging, toasts)
- Manager notifications: catch and log, never crash the plugin
- SDK calls that might fail: wrap in try/catch, ignore or log

### Plugin Hooks Pattern
- `config` hook → register slash commands via `input.command[name] = { template, description }`
- `command.execute.before` hook → handle slash command, throw Error to signal "handled"
- `event` hook → listen for `session.idle`, `session.deleted` etc.
- `experimental.chat.system.transform` → inject into system prompt
- `experimental.session.compacting` → inject context during compaction

### State Management
- All state in `DelegationManager.delegations: Map<string, Delegation>`
- In-memory only, no persistence to disk
- Delegation ID = OpenCode session ID (same value)
- Status flow: `running` → `completed` | `error` | `cancelled` | `timeout`

## Key Patterns

### Adding a new tool
1. Define args interface in `tools.ts`
2. Create factory function `createXxx(manager)` returning `tool({...})`
3. Register in `plugin.ts` under the `tool:` object
4. Add any needed manager methods in `manager.ts`
5. Rebuild

### Adding a new slash command
1. Define command name constant in `plugin.ts`
2. Register in `config` hook: `input.command[name] = { template, description }`
3. Handle in `command.execute.before` hook, throw Error when handled
4. Send output via `client.session.prompt({ path: { id: sessionID }, body: { noReply: true, parts: [...] } })`

### Tool execute signature
```typescript
async execute(args: ArgsType, toolCtx: ToolContext): Promise<string>
```
- `toolCtx.sessionID` — current chat session
- `toolCtx.messageID` — current message
- `toolCtx.agent` — current agent name
- Always guard: `if (!toolCtx?.sessionID) return "❌ ..."`

## External Dependencies

- `@opencode-ai/plugin` — tool() factory, ToolContext, Plugin type (external, not bundled)
- `@opencode-ai/sdk` — OpenCode client types, Event, Message, Part (external, not bundled)
- `esbuild` — build tool (devDependency)

## No Tests

No test framework is configured. Validate changes by building and running in OpenCode.

## Common Gotchas

- `dist/` is committed — always rebuild after changes
- `@opencode-ai/*` packages are marked external in esbuild — they're provided by the OpenCode runtime
- Delegation ID and session ID are the same value (kept as two fields for clarity)
- `noReply: true` on prompts means "show to user but don't trigger AI response"
- Throwing in `command.execute.before` signals the command was handled by this plugin
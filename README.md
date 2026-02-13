# OpenCode Async Agent Plugin

Async background delegation for OpenCode — run multiple AI agents in parallel.

## Features

- **Parallel Execution** — Delegate tasks to background agents while you continue working
- **Multiple Agents** — Use explore, researcher, or any custom agent
- **Model Override** — Specify which model runs each task (e.g., `minimax/MiniMax-M2.5`)
- **Session Persistence** — Resume cancelled tasks without losing context
- **System Prompt Injection** — Your `~/.config/opencode/async-agent.md` config is automatically loaded

## Installation

### Manual Setup (Current)

 1. **Clone and build:**
    ```bash
    git clone <repo-url>
    cd opencode-async-agent
    npm install
    npm run build
    ```

2. **Copy to OpenCode plugins:**
   ```bash
   mkdir -p ~/.config/opencode/plugin
    cp dist/async-agent.js ~/.config/opencode/plugin/
   ```

3. **Restart OpenCode** — the plugin auto-registers on startup

### NPM Package (Coming Soon)

```bash
npm install -g oc-async-agent
```

## Usage

The plugin adds these tools to your OpenCode agent:

| Tool | Description |
|------|-------------|
| `delegate(prompt, agent)` | Start a background task |
| `delegate(prompt, agent, model)` | Start with specific model |
| `delegation_read(id)` | Get completed result |
| `delegation_list()` | List active/completed tasks |
| `delegation_cancel(id\|all)` | Cancel running task(s) |
| `delegation_resume(id, prompt?)` | Resume cancelled task |

## Configuration

first run "opencode models |grep <modelname> " and get the full provider/mode name 
Create `~/.config/opencode/async-agent.md` to customize available models:

```markdown
# Async Agent Model Configuration

## Recommended Models

### Fast
- `minimax/MiniMax-M2.5`

### Good Understanding  
- `synthetic/hf:moonshotai/Kimi-K2.5`

Format: `provider/model` — pass to `delegate()` via the `model` parameter.
```

This file is injected into your agent's system prompt automatically.

## How I Use It

My workflow with async agent goes like this:

1. **Use Claude Opus 4.5 as my main planner** — I tell Opus what I want to build, including tech stack, key libraries, APIs, etc.

2. **Identify knowledge gaps** — When I don't know much about a specific component or tech choice

3. **Launch parallel research** — I tell Opus: "Send 15 minimax agents to research this part"
   - Web search for docs and tutorials
   - zread/zai for GitHub repo exploration
   - grep.app for real code examples
   - MCP tools for specialized queries
   - Clone OSS codebases and explore them

4. **Continue planning while research runs** — Opus keeps working with me on the plan while the async agents investigate in the background

5. **Get notified + read results** — When research completes, `<system-reminder>` fires to notify Opus, Opus reads the results internally with `delegation_read(id)`, then explains the findings to me

The parallelism is key — 15 agents researching different aspects simultaneously means comprehensive information in the time it would take to do one sequential query.

**Note:** I've also tried using async agent for parallel feature implementation but haven't found good success with that yet.


## Project Structure

```
src/plugin/
  plugin.ts    — Entry point, tool registration
  manager.ts   — Delegation state machine
  tools.ts     — Tool factories
  types.ts     — Type definitions
  rules.ts     — System prompt injection
  utils.ts     — Helpers
dist/
  async-agent.js  — Bundled output
```

## License

MIT

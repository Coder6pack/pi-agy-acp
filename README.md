# agy-acp

An [Agent Client Protocol (ACP)](https://agentclientprotocol.com) stdio adapter for [Google Antigravity CLI](https://github.com/google-antigravity/antigravity-cli) (`agy`). It bridges `agy` into any ACP-compatible host like [Zed](https://zed.dev), enabling you to use Gemini models through `agy` inside Zed's Agent Panel.

## How It Works

`agy-acp` speaks JSON-RPC over stdin/stdout (the ACP transport). When a host like Zed sends a prompt, `agy-acp` spawns `agy` as a subprocess, gives that invocation a unique log file so its conversation ID can be bound safely under parallel execution, streams SQLite-backed updates as incremental `session/update` notifications, and persists session state across restarts. Captured `agy --print` stdout supplies the final-answer fallback; missing conversation identity or assistant output is reported as an error rather than a successful empty turn.

```
Zed (ACP host)  <--stdin/stdout JSON-RPC-->  agy-acp  <--subprocess-->  agy  <--API-->  Gemini
```

## Prerequisites

- **Rust** (1.70+) with Cargo
- **`agy`** installed and in your `PATH` — install from [google-antigravity/antigravity-cli releases](https://github.com/google-antigravity/antigravity-cli)
- **Authentication** — either set `GEMINI_API_KEY` or configure auth via `~/.gemini/antigravity-cli/settings.json`

## Build & Install

```bash
cargo build --release
```

The binary is at `target/release/agy-acp`. Copy it somewhere in your `PATH`:

```bash
cp target/release/agy-acp /usr/local/bin/
```

## Use with Zed

Add `agy-acp` as a custom agent server in your Zed settings (`~/.config/zed/settings.json`):

```json
{
  "agent_servers": {
    "agy": {
      "type": "custom",
      "command": "agy-acp",
      "args": [],
      "env": {}
    }
  }
}
```

Then open the Agent Panel in Zed (`Cmd-?` on macOS, `Ctrl-?` on Linux), select **agy** from the agent dropdown, and start chatting.

### Model Selection

`agy-acp` queries available models by running `agy models` at startup. You can switch models from Zed's model selector in the agent thread — the adapter exposes them as ACP config options.

### Passing Extra Arguments

Set the `AGY_EXTRA_ARGS` environment variable to pass additional arguments to every `agy` invocation:

```json
{
  "agent_servers": {
    "agy": {
      "type": "custom",
      "command": "agy-acp",
      "args": [],
      "env": {
        "AGY_EXTRA_ARGS": "--some-flag value"
      }
    }
  }
}
```

## Environment Variables

| Variable | Description |
|---|---|
| `GEMINI_API_KEY` | API key for Gemini (passed through to `agy`) |
| `AGY_EXTRA_ARGS` | Space-separated extra args passed to every `agy` invocation |
| `AGY_PRINT_TIMEOUT` | Maximum time `agy --print` may wait for a trustworthy completed turn (default `24h`) |

## Use with Pi

The repository also includes a Pi provider extension backed by the same `agy`
CLI. Install it from the repository root with:

```bash
pi install ./agy-acp/pi-extension
```

Then choose an Antigravity model with `/model`, or start Pi directly:

```bash
pi --model antigravity/gemini-4-argon-medium
```

See [`pi-extension/README.md`](pi-extension/README.md) for configuration and
limitations. This provider lets `agy` run its own tools and streams the final
agent response into Pi; it does not translate Pi tool calls into Antigravity
CLI tool calls.

## Session Persistence

Sessions are persisted to `~/.openab/agy-acp/sessions.json`. When you resume a session in Zed, `agy-acp` restores the conversation binding and replays the message history from `agy`'s SQLite conversation databases (`~/.gemini/antigravity-cli/conversations/*.db`).

## Debugging

To inspect the JSON-RPC messages between Zed and `agy-acp`, run `dev: open acp logs` from Zed's Command Palette.

## License

MIT

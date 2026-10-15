# Antigravity provider for Pi

This extension registers an `antigravity` provider backed by the local
[`agy`](https://github.com/google-antigravity/antigravity-cli) executable.
It uses `agy --input-format stream-json --output-format stream-json`, so one
Pi session keeps one Antigravity conversation and model output is streamed
back into Pi.

## Install

From this repository:

```bash
pi install ./agy-acp/pi-extension
```

Or try it for one invocation:

```bash
pi -e ./agy-acp/pi-extension --model antigravity/gemini-4-argon-medium
```

Then select a model normally with `/model`, or use for example:

```bash
pi --model antigravity/gemini-4-argon-high
```

The extension runs `agy models` during startup and exposes the discovered
models. If discovery fails, it keeps a small fallback catalog visible so the
request reports the real CLI error instead of hiding the provider.

## Requirements and configuration

- `agy` must be installed and available on `PATH`.
- Authenticate `agy` using its normal Antigravity setup, or provide
  `GEMINI_API_KEY`.
- The Pi working directory is passed to `agy` with `--add-dir`.
- `AGY_EXTRA_ARGS` is split into additional CLI arguments.
- `AGY_PRINT_TIMEOUT` controls the print-mode timeout (default `24h`).
- Set `ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS=1` only if you explicitly want
  `agy` to auto-approve its own tool calls.
- `ANTIGRAVITY_CONTEXT_WINDOW` and `ANTIGRAVITY_MAX_TOKENS` override the
  catalog metadata when the installed CLI uses different limits.

## Important behavior

`agy` is an agent CLI, not a public model HTTP endpoint. The provider therefore
lets Antigravity execute its own tools and returns its final response to Pi;
Pi's own tool calls are not forwarded into `agy`. Text/image input is supported
at the Pi boundary, but images are represented as a text placeholder because
`agy` print-mode stream input is currently text-only.

The provider reports zero cost because Antigravity subscription/account
pricing is not exposed by the CLI. Token usage from `agy` is still forwarded
to Pi.

---
name: antigravity-cli
description: Spawn, configure, or troubleshoot Antigravity CLI (antigravity-cli) threads in BB — models, reasoning levels (low, medium, high), Build/Plan work modes, permissions, and sign-in.
---

# Antigravity CLI provider

Threads on the `antigravity-cli` provider run the locally installed Antigravity CLI (`agy acp --disable-telemetry`) through BB's shared ACP bridge.

## Models and reasoning levels

`antigravity-cli` discovers models and per-model reasoning efforts from the signed-in CLI (`low`, `medium`, `high`; default `medium`). Fixed-effort models (such as `gpt-oss-120b-medium`) report `supportedReasoningEfforts: []`.

- Plain `bb provider models antigravity-cli` prints only the model table and `sessionOptions` (`mode`), omitting reasoning levels. Always pass `--json` when inspecting reasoning support:

```sh
bb provider models antigravity-cli --environment "$BB_ENVIRONMENT_ID" --json
```

- If a model reports `reasoningDiscovery: "unknown"`, probe that model explicitly:

```sh
bb provider models antigravity-cli --environment "$BB_ENVIRONMENT_ID" --selected-model <model-id> --json
```

- Pass reasoning level with `--reasoning-level` (not `--option`):

```sh
bb thread spawn --project "$BB_PROJECT_ID" --provider antigravity-cli --model gemini-4-argon --reasoning-level medium --prompt "..."
```

## Work modes and permissions

Work mode and permissions are separate controls:

- **Work mode (`--option mode=<accept-edits|plan>`)**:
  - `accept-edits` (**Build**, default): implement the task under the active permission policy.
  - `plan` (**Plan**): research and plan before implementation (behavioral mode, not enforced read-only access).
- **Permission mode (`--permission-mode <accept-edits|full>`)**:
  - `accept-edits`: workspace edits run with native Accept edits behavior; remaining ACP permission requests surface in BB.
  - `full`: auto-approves ACP permission requests, including requests to run outside the CLI terminal sandbox.
  - `auto` is not supported by the shared ACP bridge.

## Requirements and settings

- `agy` must be installed and on `PATH` on the target host (`agy --version`, `agy acp --help`).
- Sign in on the target host with `agy acp --login`.
- Plugin settings (`Settings -> Installed plugins -> Antigravity CLI`):
  - `enabled` (default `true`): show or hide `antigravity-cli` in the provider picker.
  - `sandbox` (default `false`): pass `--sandbox` when starting new threads (when `false`, inherits CLI settings).

## Limits

- Session fork/rewind (`fork: "none"`), manual `/compact`, service tiers, usage window reporting, and native thread archive/rename are not supported.
- Native skills are indexed from workspace `.agents/skills` and `.agent/skills`, and from user `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, and `~/.gemini/config/skills`.

<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="Antigravity plugin icon">
</p>

<h1 align="center">Antigravity for BB</h1>

<p align="center">Use your Antigravity CLI account to code in BB.</p>

<p align="center">
  <a href="#getting-started">Getting started</a> &middot;
  <a href="#modes-and-permissions">Modes & permissions</a> &middot;
  <a href="SECURITY.md">Security</a> &middot;
  <a href="docs/RELEASE.md">Marketplace submission</a>
</p>

An experimental community provider that connects [BB](https://getbb.app) to the [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli). Keep your existing CLI sign-in, choose available models, and work with streamed responses and tool approvals inside BB.

**Status:** installed and tested locally on Windows. A Community marketplace listing is not published yet. macOS and Linux still need validation.

## What you get

- **One provider in BB:** select Antigravity when creating a thread.
- **Live model discovery:** models and reasoning options come from your CLI and account.
- **Plan and Build:** plan a task, then switch back to implementation.
- **Permission controls:** choose Accept edits or Full access.
- **A settings toggle:** show or hide the provider without editing configuration files.

## Getting started

### 1. Prepare the agent host

You need BB 0.48+, Node.js 22+, and a separately installed Antigravity CLI with an eligible account. The Antigravity desktop application alone is insufficient. Your provider's quota and charges still apply.

Run these commands on the machine where the agent will execute:

```sh
agy --version
agy acp --help
```

Sign in if needed:

```sh
agy acp --login
```

The executable must be on that machine's `PATH`. Restart BB after changing `PATH`. Remote agent hosts need their own CLI installation and sign-in.

### 2. Install the plugin

For now, install from a local checkout. Inside the plugin directory, run:

```sh
npm ci --ignore-scripts
bb plugin install .
```

Review and accept BB's installation prompt. Plugins run with full trust.

Once a public release is available, users can install from the [GitHub repository](https://github.com/ols-md/bb-plugin-antigravity) directly:

```sh
bb plugin install https://github.com/ols-md/bb-plugin-antigravity
```

That URL tracks the default branch. Release and marketplace preparation are documented in [docs/RELEASE.md](docs/RELEASE.md).

### 3. Start a thread

Select **Antigravity** in BB's provider picker, choose a model, and send a prompt. The CLI supplies the available models; availability depends on your account and installed version.

## How it works

```text
Your BB thread -> Plugin -> BB's shared ACP bridge -> agy acp -> Antigravity service
```

The plugin starts `agy acp --disable-telemetry` on the agent host. BB's shared [Agent Client Protocol (ACP)](https://agentclientprotocol.com) bridge handles streamed messages, tool updates, approval requests, and session communication. A small adapter maps BB's Plan action to the CLI's native mode.

Authentication stays with the CLI. You do not enter an API key into the plugin or maintain custom-agent JSON.

## Modes and permissions

Planning and permissions are separate controls:

| Control | Choice | Behavior |
| --- | --- | --- |
| Work mode | Plan | Selects the CLI's native Plan mode. Use it to research and outline a task. |
| Work mode | Build | Turn off BB's Plan action to return to the CLI's Accept edits mode. |
| Permissions | Accept edits | Uses native Accept edits behavior; remaining ACP approval requests are presented in BB. |
| Permissions | Full access | BB's shared bridge automatically approves ACP permission requests. |

Use BB's Plan action (or `/plan`) to enter planning. This mapping takes precedence over the CLI's native Mode selector, including any previously selected native mode. BB's Auto permission mode is unsupported by the shared ACP bridge.

### Terminal sandbox

The plugin inherits the CLI's sandbox settings; it does not add `--sandbox` or force sandboxing off. Antigravity supports an OS-level terminal sandbox on supported systems. Its availability and boundaries depend on your OS, CLI version, and configuration. See [Antigravity's sandbox documentation](https://antigravity.google/docs/sandbox/?tab=cli).

**Full access does not guarantee sandbox containment.** Even with the CLI sandbox enabled, a command can request execution outside it. Full access automatically approves ACP permission requests, potentially including those escape requests. Use Accept edits to retain review of requests forwarded to BB.

Plan is agent behavior, not enforced read-only access. Permission approvals and terminal sandboxing are distinct protections.

## Settings

Open **Settings -> Installed plugins -> Antigravity** and use **Enable Antigravity** to show or hide the provider. Changes apply immediately. Hiding the provider does not stop a running turn. BB's standard installed-plugin switch disables the entire plugin.

The plugin stores only this enable/disable preference. BB and the CLI can retain their normal conversations and diagnostics. Prompts, workspace context, and tool results are processed by Antigravity and its service. Disabling CLI telemetry does not disable service processing or conversation storage. Read [SECURITY.md](SECURITY.md) for the trust and privacy details.

## Limitations

Usage accounting, automatic CLI installation, conversation forking, manual compaction, and native thread archive/rename synchronization are not advertised. The plugin depends on your installed CLI and the shared BB ACP bridge.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Antigravity is missing | Enable the installed plugin and its **Enable Antigravity** setting. |
| `agy` cannot be found | Install the CLI on the agent host, check `PATH`, and restart BB. |
| Sign-in is required or expired | Run `agy acp --login` on the agent host, then retry. |
| ACP is unavailable | Update the CLI and confirm `agy acp --help` works. |
| Model list is empty | Check CLI sign-in, connectivity, and account eligibility, then refresh providers. |
| Commands run without asking | Check BB's permission selection and the CLI's own permission rules. Full access auto-approves ACP requests. |

When reporting an issue, include BB/CLI versions and a short reproduction. Remove tokens, account details, private paths, and conversation content from logs.

## Development

The test runner requires Node.js 22.18+ or Node.js 24. The SDK dependency is pinned to 0.6.104.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run smoke -- --modes
```

The smoke check creates a real CLI session in a temporary workspace and verifies native Plan/Build transitions without sending a prompt. It refuses incoming tool requests. To send a small test prompt using your account (which can consume quota):

```sh
npm run smoke -- --prompt
```

See [review notes](docs/REVIEW.md) and the [release checklist](docs/RELEASE.md) before publishing. Published npm packages exclude source maps because they can contain local build paths.

## License

[MIT](LICENSE). This project is independent of Google and BB. Their products, services, and dependencies retain their own terms.

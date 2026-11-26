<p align="center">
  <img src="assets/icon.svg" width="72" height="72" alt="Antigravity plugin icon">
</p>

<h1 align="center">Antigravity CLI for BB</h1>

<p align="center">
  <a href="#getting-started">Getting started</a> &middot;
  <a href="#modes-and-permissions">Modes & permissions</a> &middot;
  <a href="SECURITY.md">Security</a>
</p>

Use your installed Antigravity CLI and existing sign-in to work in [BB](https://getbb.app). Choose an available model, work in Build or Plan mode, and review tool approval requests in BB.

This experimental provider is available in the BB Community marketplace. It has been tested on Windows. macOS and Linux still need validation.

## Getting started

### 1. Prepare the agent host

You need BB 0.48 or later, Node.js 22 or later, and an eligible Antigravity account. Antigravity quota and charges apply.

Install the standalone Antigravity CLI (`agy`) on the machine where the agent runs. If you use a remote agent host, install it there. [Google's CLI installation instructions](https://antigravity.google/docs/getting-started?tab=cli)

Check the CLI version and ACP support on the agent host.

```sh
agy --version
agy acp --help
```

If you need to sign in, run this command on the agent host.

```sh
agy acp --login
```

Follow the sign-in prompts. The plugin checks `PATH` first, then the standard CLI install location (`%LOCALAPPDATA%\agy\bin\agy.exe` on Windows or `~/.local/bin/agy` on macOS and Linux).

### 2. Install the plugin

In BB, open **Plugins** from the navigation rail. In the Community marketplace, find **Antigravity CLI [Experimental]** and select **Install**. You can also install it from the command line.

```sh
bb plugin install antigravity-cli
```

To install from the default branch on GitHub, run this command.

```sh
bb plugin install https://github.com/ols-md/bb-plugin-antigravity
```

To install from a local checkout, run these commands in the plugin directory.

```sh
npm ci --ignore-scripts
bb plugin install .
```

Plugins run with full trust. Review BB's installation prompt. If you trust the plugin, accept the prompt. For release and marketplace information, see the [release guide](docs/RELEASE.md).

### 3. Start a thread

1. Select **Antigravity CLI** in BB's provider picker for a new thread.
2. Select an available model. If the model offers reasoning levels, select a level.
3. In the **Mode** selector, select **Build** to implement a task or **Plan** to outline it. See [Modes and permissions](#modes-and-permissions).
4. Send a prompt.

## Preview

![Antigravity CLI in BB showing the model picker and reasoning levels, quota used and reset times by model group, and provider settings for visibility, automatic approvals, terminal sandboxing, subagents, and command descriptions.](assets/screenshots/marketplace-overview.png)

The preview shows example settings. Available models and reasoning levels can depend on your Antigravity account, CLI version, and plugin version. [View the preview at full size](assets/screenshots/marketplace-overview.png?raw=true)

When the CLI reports quota used and reset times, BB shows them in the usage sidebar and in **Settings → Usage limits**.

## How it works

```text
Your BB thread -> Plugin -> BB's shared ACP bridge -> agy acp -> Antigravity service
```

The plugin starts `agy acp --disable-telemetry` on the agent host. BB's shared [Agent Client Protocol (ACP)](https://agentclientprotocol.com) bridge handles streamed messages, tool updates, approval requests, and session communication. A small adapter exposes the CLI's work mode as Build or Plan in BB.

Authentication stays with the CLI. You do not enter an API key into the plugin or maintain custom-agent JSON.

## Modes and permissions

Planning and permissions are separate controls:

| Control | Choice | Behavior |
| --- | --- | --- |
| Work mode | Plan | Selects the CLI's native Plan mode. Use it to research and outline a task. |
| Work mode | Build | Implement the task using native Accept edits behavior and the selected BB permission policy. |
| Permissions | Accept edits | Uses native Accept edits behavior; remaining ACP approval requests are presented in BB unless automatic approval is enabled. |
| Permissions | Full access | BB's shared bridge automatically approves ACP permission requests. |

Choose **Build** or **Plan** in the **Mode** selector. Build is the default. The CLI's combined Default / Accept edits / Plan selector is replaced by these two work modes, so editing permissions are no longer repeated there. BB's Auto permission mode is unsupported by the shared ACP bridge.

### Terminal sandbox

By default the plugin inherits the CLI's sandbox settings. Antigravity supports an OS-level terminal sandbox on supported systems. Its availability and boundaries depend on your OS, CLI version, and configuration. See [Antigravity's sandbox documentation](https://antigravity.google/docs/sandbox/?tab=cli).

**Full access does not guarantee sandbox containment.** Even with the CLI sandbox enabled, a command can request execution outside it. Full access automatically approves ACP permission requests, potentially including those escape requests. Use Accept edits with automatic approval off to retain review of requests forwarded to BB.

Plan is agent behavior, not enforced read-only access. Permission approvals and terminal sandboxing are distinct protections.

## Settings

Open **Settings -> Installed plugins -> Antigravity CLI** and use **Show in provider picker** to show or hide the provider. Changes apply immediately. Hiding the provider does not stop a running turn. BB's standard installed-plugin switch disables the entire plugin.

The **Request CLI terminal sandbox** setting adds `--sandbox` for new threads. Off means inherit CLI settings, not force sandboxing off. Availability depends on the host OS.

**Automatically approve ACP permission requests** is off by default. When enabled, the plugin answers Antigravity ACP permission requests automatically in Accept edits mode, including commands requesting execution outside the CLI sandbox. It takes effect on new turns, keeps the selected BB permission mode and direct ACP filesystem restrictions, and does not override a host policy that denies permission escalation. Requests without an allow option and other interactions continue to BB. Full access already auto-approves these requests.

**Disable provider subagents** is off by default. When enabled, the plugin instructs Antigravity CLI not to use its native subagent tools (`invoke_subagent`, `define_subagent`, `manage_subagents`, `send_message`) so agents delegate work through BB threads (`bb thread spawn --parent-self`), and automatically denies native subagent approval prompts (taking precedence over automatic approval).

**Show command descriptions** is on by default. When enabled, command execution cards display Antigravity's `toolSummary` as the title with the raw command line as the subtitle, along with an **Outside of sandbox** badge whenever `BypassSandbox` is requested.

The plugin stores these boolean preferences. BB and the CLI can retain their normal conversations and diagnostics. Prompts, workspace context, and tool results are processed by Antigravity and its service. Disabling CLI telemetry does not disable service processing or conversation storage. Read [SECURITY.md](SECURITY.md) for the trust and privacy details.

## Limitations

See the [capability comparison](docs/FEATURES.md) for verified features and remaining gaps.

Automatic CLI installation, conversation forking, manual compaction, and native thread archive/rename synchronization are not advertised. The plugin depends on your installed CLI and the shared BB ACP bridge.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Antigravity is missing | Enable the installed plugin and its **Show in provider picker** setting. |
| `agy` cannot be found | See [Windows CLI recovery](#windows-cli-recovery). Install the standalone CLI on the agent host; the plugin also checks its standard install location. |
| Sign-in is required or expired | Run `agy acp --login` on the agent host, then retry. |
| ACP is unavailable | Update the CLI and confirm `agy acp --help` works. |
| Model list is empty | Check CLI sign-in, connectivity, and account eligibility, then refresh providers. |
| Commands run without asking | Check automatic approval in plugin settings, BB's permission selection, and the CLI's own permission rules. Full access auto-approves ACP requests. |

When reporting an issue, include BB/CLI versions and a short reproduction. Remove tokens, account details, private paths, and conversation content from logs.

### Windows CLI recovery

If PowerShell reports **`agy` is not recognized**, check the default installation:

```powershell
Test-Path "$env:LOCALAPPDATA\agy\bin\agy.exe"
```

If it returns `False`, install the standalone CLI using the [official installation instructions](https://antigravity.google/docs/getting-started?tab=cli):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

If it returns `True`, add its directory to the current terminal's PATH and verify:

```powershell
$env:Path += ";$env:LOCALAPPDATA\agy\bin"
agy --version
agy acp --login
```

For future terminals, add `%LOCALAPPDATA%\agy\bin` to your user **Path** in Windows Environment Variables, then reopen PowerShell and restart BB. The plugin fallback also works without this PATH change.

## Development

The test runner requires Node.js 22.18+ or Node.js 24.

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

The plugin and provider ID is `antigravity-cli`. This is a separate community integration from the marketplace plugin named `antigravity`. Local installations using the earlier ID need to be reinstalled; existing threads retain their original provider ID.

## Native skills

BB discovers skills in workspace `.agents/skills` and legacy `.agent/skills`, and in personal `~/.gemini/antigravity-cli/skills`, `~/.gemini/skills`, and `~/.gemini/config/skills`. Installed CLI plugin skill directories are not yet resolved into BB's picker. See [Antigravity skills](https://antigravity.google/docs/skills).

The provider uses the Antigravity mark in BB's model selector, rendered in one color to follow the theme. The plugin page uses the color mark. See [asset attribution](assets/README.md).

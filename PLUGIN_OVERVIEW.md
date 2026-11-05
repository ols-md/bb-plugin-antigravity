## What you get

Use your Antigravity CLI sign-in to work inside BB. Choose models discovered from the CLI, read streamed replies, and review tool approval requests in your thread. Choose Build or Plan in the Mode selector, and show or hide the provider in the plugin settings.

BB can list native personal and workspace Antigravity skills. A separate setting requests the CLI terminal sandbox for new threads; off inherits CLI settings.

## Permissions and sandbox

Accept edits uses the CLI's native editing mode and forwards remaining ACP approval requests to BB. Full access automatically approves ACP permission requests, potentially including requests to execute outside the terminal sandbox. Plan is agent behavior, not enforced read-only access.

The plugin inherits the CLI's sandbox configuration. Sandbox availability depends on your operating system and CLI version. See the [Antigravity sandbox documentation](https://antigravity.google/docs/sandbox/?tab=cli).

## Requirements

Requires BB 0.48+, Node.js 22+, a separately installed Antigravity CLI with `agy acp` on the agent host's PATH, and an eligible signed-in account. Provider quota or charges apply. The desktop application alone is insufficient; remote hosts need their own CLI installation and sign-in.

Windows has been tested locally; macOS and Linux need validation. Usage accounting, automatic CLI installation, forks, and manual compaction are not supported.

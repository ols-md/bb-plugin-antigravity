# Antigravity for BB

Use Antigravity alongside your other BB providers. This community integration launches the official `agy acp` command and reuses your CLI sign-in. No API key or custom-agent JSON is required.

## Start

1. Install the [Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli) on the machine where BB runs your agent. The desktop app alone is insufficient.
2. Confirm `agy acp --help` works. If needed, sign in once with `agy acp --login`.
3. Install this plugin from the BB marketplace when published. Select **Antigravity** when creating a thread.

If you already have a signed-in CLI on PATH, only step 3 is needed. Restart BB after changing PATH. Remote hosts need their own CLI installation and sign-in.

## Install from this checkout

```sh
npm ci --ignore-scripts
bb plugin install . --yes
```

Once a public repository is published, BB can install it directly by repository URL. A marketplace listing is not published yet; see [release preparation](docs/RELEASE.md).

## What works

BB's shared ACP bridge handles streamed replies, tool updates, approval requests, conversation sessions, and the model/mode catalog advertised by the CLI. Models are discovered rather than hardcoded. Antigravity retains its permission checks; the plugin never adds `--dangerously-skip-permissions`. Use BB's Plan action for planning and turn it off to return to Build (native Accept edits). This mapping takes precedence over the native Mode selector. Plan is CLI behavior, not a filesystem sandbox. The permission picker separately offers Accept edits and Full access; Full access automatically approves ACP permission requests. Auto is unsupported by the shared ACP bridge. BB's accept-edits permission profile does not promise a filesystem sandbox.

Usage accounting, automatic CLI installation, conversation forking, and manual compaction are not advertised. CLI permissions and account availability remain subject to Antigravity itself.

## Troubleshooting

- Missing executable: install the CLI and make `agy` available on the agent host's PATH.
- Sign-in required or expired: run `agy acp --login` on that host, then retry.
- ACP unavailable: update the CLI until `agy acp --help` works.
- Empty model list: verify CLI sign-in, network access, and account eligibility, then refresh providers.

## Development

Requires Node 22.18+ (or Node 24) for the test runner, BB 0.48+, and SDK 0.6.104.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run smoke
```

`npm run smoke` opens a real ACP session without sending a prompt. `npm run smoke -- --prompt` sends a small request using your account and can consume quota. Tests use a temporary empty workspace and refuse tool requests. Windows was verified locally; macOS and Linux still need release checks.

See [security and privacy](SECURITY.md) and [review results](docs/REVIEW.md). MIT licensed. This project is independent of Google and BB; their products, services, and dependencies retain their respective terms.

## Settings

Settings ? Installed plugins ? Antigravity includes **Enable Antigravity**. Changes update provider registration immediately; disabling does not stop a running turn. The standard installed-plugin switch can disable the entire plugin. Only this boolean is stored by the plugin; CLI sign-in remains managed by Antigravity.

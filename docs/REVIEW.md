# Security and public-source review

Reviewed the provider declaration, host entry, tests, smoke script, manifest, lockfile, documentation, and generated package inventory.

- Plugin-owned runtime code contains no shell execution, HTTP route, credential handling, telemetry collector, credential persistence, or install hook. The shared SDK handles subprocesses and ACP transport.
- The plugin disables CLI telemetry. Accept edits forwards outstanding approval requests to BB by default. Enabling automatic approval can also approve commands outside the CLI sandbox. No permission bypass flags or arbitrary endpoint overrides are added. Explicitly selecting Full access makes the shared bridge approve permission requests.
- No account identifiers, personal email addresses, home-directory paths, tokens, CLI state, or session recordings are intentionally bundled in release files. Git commit metadata can separately contain author identities and emails. Background-task state is stored locally and can include private command descriptions and paths; see SECURITY.md. Package contents use an allowlist; dependencies, scratch scaffold, environment files, logs, and local Git metadata are excluded. Published package contents exclude source maps, which can contain local build paths.
- npm audit reported zero known vulnerabilities at verification time. This is not a guarantee against unknown vulnerabilities or an independent audit of upstream code.
- MIT applies to this project's original source. The dependency SDK declares MIT; other dependencies and Google's service retain their own terms.

Verified on Windows: TypeScript check, launch-policy regression test, BB build and plugin reload, live model/mode discovery, and native ACP initialize/session/new/prompt against the installed signed-in CLI. The prompt returned the requested marker without tool access.

Public source metadata, Git-source installation, and the BB Community marketplace listing (`antigravity-cli`) are published.

Ubuntu CI runs the typecheck and test suite with Node 24. A contributor reported live sessions on an Unraid Linux fork with Node 26 and Antigravity CLI 1.5.14. A signed-in test of the released plugin on Linux and a macOS runtime test remain open. [Linux test environment](https://github.com/mturilin/bb-plugin-antigravity/commit/3323a3a40445e58d62a70a24ca242e4e3fdcfd4c)

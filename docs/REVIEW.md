# Security and public-source review

Reviewed the provider declaration, host entry, tests, smoke script, manifest, lockfile, documentation, and generated package inventory.

- Plugin-owned runtime code contains no shell execution, HTTP route, credential handling, telemetry collector, persistence, or install hook. The shared SDK handles subprocesses and ACP transport.
- Fixed launch arguments preserve vendor approval checks and disable CLI telemetry. No permission bypass flags or arbitrary endpoint overrides are added.
- No account identifiers, personal email addresses, home-directory paths, tokens, CLI state, or session recordings are intentionally shipped. Package contents use an allowlist; dependencies, scratch scaffold, environment files, logs, and local Git metadata are excluded. Generated source-map sources use relative paths.
- npm audit reported zero known vulnerabilities at verification time. This is not a guarantee against unknown vulnerabilities or an independent audit of upstream code.
- MIT applies to this project's original source. The dependency SDK declares MIT; other dependencies and Google's service retain their own terms.

Verified on Windows: TypeScript check, launch-policy regression test, BB build and plugin reload, live model/mode discovery, and native ACP initialize/session/new/prompt against the installed signed-in CLI. The prompt returned the requested marker without tool access.

Remaining before public release: public owner/source metadata, clean Git-source installation, BB conversation UI exercise including approvals/cancellation/resume, marketplace validation and screenshots, and platform checks outside Windows. These are release gates rather than claims of completed validation.

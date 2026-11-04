# Security and privacy

This is a full-trust BB provider plugin. Install only from a source you trust.

The plugin registers one provider and re-exports BB's ACP bridge. It launches `agy` through the shared bridge, with fixed arguments and no shell command construction, credential parser, custom network endpoint, listener, or database. The trusted agent-host PATH selects the executable; do not place an untrusted `agy` earlier on PATH.

Existing credentials remain managed by Antigravity. The plugin does not copy or bundle them. Prompts, workspace context, and tool results are processed by Antigravity and its service under Google's policies; BB and the CLI may retain their normal conversation records and diagnostics. Disabling CLI telemetry does not disable service processing or those records.

Antigravity's normal approval checks stay enabled. These checks are not an operating-system sandbox. Only open trusted workspaces and review tool approvals. Dependency and upstream bridge security remain part of this plugin's trust boundary.

Do not post credentials or raw private session logs in public issues. Report a suspected issue privately to the repository maintainer through GitHub's private security reporting once a public repository has been configured.

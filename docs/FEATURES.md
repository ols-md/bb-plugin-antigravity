# Provider capabilities

Verified against Antigravity CLI 1.5.1 and BB SDK 0.6.104 on Windows. A terminal CLI feature does not imply that the same feature is exposed through ACP.

| Feature | Current integration |
| --- | --- |
| Streaming, tools, approvals | Shared BB ACP bridge |
| Model and reasoning choices | Discovered from CLI; account dependent |
| Plan/Build | One Mode selector, mapped to native Plan/Accept edits; duplicate Plan action removed |
| Accept edits / Full access | Shared bridge permission policy |
| CLI terminal sandbox | Inherits settings; optional request-sandbox flag for new threads |
| Native skills in BB picker | Declared workspace and personal skill directories |
| Separate child sessions | Distinct ACP session IDs verified; actual concurrent agent work not tested |
| Existing session load | Native session/load verified; full BB restart recovery not tested |
| Session fork/rewind | Disabled: CLI initialize does not advertise session/fork |
| Manual compaction | Disabled: sending /compact returned conversational text; actual compaction not established |
| Subscription quota/usage | Supported via `agy -p "/usage" --output-format json` and `provider-usage.v1` |
| Native archive/rename | Disabled: bridge does not implement these operations |
| BB Auto permission profile | Unsupported by the shared ACP bridge |
| Native plugin-provided skills | Not resolved into BB's picker yet |

The sandbox flag may have no effect on an unsupported OS. Full access can approve requests to run outside the sandbox. Native skills are discovered according to the [CLI skill locations](https://antigravity.google/docs/skills); [ACP documentation](https://antigravity.google/docs/ide/extensions/acp/) describes the supported session operations.

Run `node scripts/smoke.mjs --capabilities --features --modes` for a no-prompt protocol check in a temporary workspace. This prints capability flags, verifies separate session IDs, reloads a session, and tests native Plan/Build transitions. It refuses incoming tool requests. It does not test actual parallel model execution or filesystem containment.

The permission picker uses BB's fixed Accept edits / Full access profiles. CLI Default (ask before edits) is not exposed separately. Supporting it as a third BB permission profile requires a BB SDK/core extension; it is not equivalent to Auto.

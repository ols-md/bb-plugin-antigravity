---
name: antigravity-contributor
description: Use when designing, implementing, documenting, or reviewing changes to the bb-plugin-antigravity repository.
---

# Contribute to the Antigravity provider

Use the issue or request to identify who needs the change and what they need to do. Choose the smallest change that solves that problem.

## Check the risks affected by the change

Use the [security policy](../../../SECURITY.md) to locate the component that controls access. For a permission change, follow the request to the host or bridge that allows or denies it. For a change to storage or diagnostics, check which private values can reach a file or message. Use synthetic data in examples and tests.

Reuse tests that cover the changed behavior. Add a test when existing coverage would miss a relevant failure. Use the official BB providers as references when they address the same problem.

- For approvals, check that the default path asks the user and that enabling automatic approval respects a host decision to deny escalation. [Codex session policy tests](https://github.com/get-bb/bb/blob/fb045a046653cc127656ca3c7243d44ae4c94f3f/plugins/provider-codex/src/session-params.test.ts)
- For quota reporting, distinguish missing values from zero. Check the expected Antigravity result in `tests/usage.test.mjs`. [Claude Code usage tests](https://github.com/get-bb/bb/blob/fb045a046653cc127656ca3c7243d44ae4c94f3f/plugins/provider-claude-code/src/delta-translation.usage.test.ts)

## Explain the change in the PR body

Under **Change**, one plain sentence can cover the problem and the benefit. For example, “When a command needs permission, you can now read it before you decide.” Link the issue for background.

Under **Checks**, give the relevant result and any material limit. For example, “The bridge test confirmed that denying the request stopped the command. I tested with a simulated CLI.” Put any explanation the reviewer needs here in the PR.

## Write technical documentation

Use ASD-STE100 Issue 9 for new or changed English technical documentation. Consult its rules and dictionary. Use one name for each item. Give one instruction per sentence. Put the condition before the action. Claim compliance only after checking the text against the standard. [Official ASD-STE100 Issue 9 source](https://asd-ste100.org/STE_downloads.html)

> Read the command. If you do not recognize the command, deny the request.

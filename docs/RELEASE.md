# Release preparation

The local integration is installed and verified. It is not published and the marketplace entry is a template, not a validated submission.

1. Select the public GitHub owner, author name, and repository. Replace the explicit placeholders in marketplace-entry.template.json. Add that repository URL to package.json. Do not add an email address.
2. Review the exact commit and files to publish. Obtain release approval before the first push or tag. Publish the repository with a v0.1.0 tag after approval.
3. Run npm ci --ignore-scripts, npm run check, npm test, npm run build, and npm run smoke -- --prompt. Check clean install from the public Git URL in BB. Verify streaming, cancellation, approval allow/deny, workspace editing, and resumed conversations in BB. Verify macOS/Linux before claiming support there.
4. In a fork of https://github.com/get-bb/marketplace, copy the filled template to entries/antigravity.json, assets/icon.svg to icons/antigravity.svg, and PLUGIN_OVERVIEW.md to overview/antigravity.md. Capture real screenshots in BB with a non-private test workspace. Do not include account data or private conversation content.
5. Recheck the current marketplace schema and reserved IDs. Run the marketplace's documented validation/build, then prepare its pull request. No marketplace fork, push, tag, or PR has been created by this build.

Git installation builds from source; no install lifecycle scripts or additional configuration are needed. npm distribution additionally needs freshly built dist artifacts and metadata. The pinned SDK is a runtime dependency because the host bridge uses it.

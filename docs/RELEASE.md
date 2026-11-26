# Publish to the BB Community marketplace

The live listing for `antigravity-cli` is a legacy entry. A future tagged release from the same [public GitHub repository](https://github.com/ols-md/bb-plugin-antigravity) can replace it in the v2 catalog through [marketplace self-publishing](https://github.com/get-bb/marketplace#get-listed).

While BB serves the legacy catalog, listing changes can still require a pull request to [get-bb/marketplace](https://github.com/get-bb/marketplace#legacy-entries). Use the description and overview from this repository for that update. If a change affects the frozen v1 document, ask a marketplace maintainer to apply the `v1-change` label.

## Prepare the release

1. Update `bb.description` and `keywords` in `package.json` when the listing copy or tags change. Keep `bbMarketplace.category` set to `agents-and-providers`.
2. Put the long description in `PLUGIN_OVERVIEW.md` next to `package.json`. Use UTF-8 Markdown with a maximum of 4,000 characters. Use absolute HTTPS links.
3. If a future release includes marketplace screenshots, use relative paths in `bbMarketplace.screenshots`. Use up to six PNG, JPEG, or WebP files. Each image must be at least 1,200 pixels wide and at most 2 MiB.
4. Complete the [public contribution and release checks](../SECURITY.md#public-contribution-and-release-checks).

Run the local release checks in the plugin directory.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run smoke -- --modes
npm pack --dry-run
bb plugin publish --check
```

Verify a clean Git-source installation in BB. Check streaming, cancellation, permission approval and denial, editing, and resumed conversations. Keep signed-in CLI smoke tests outside public PR automation. If you run `npm run smoke -- --prompt`, it can consume quota. Signed-in tests passed on Windows. We expect the plugin to work on Linux. A signed-in Linux test and macOS validation are still pending.

## Publish and verify the listing

1. For a planned release, set the package version and prepare the release commit.
2. Make sure the public repository has the `bb-plugin` GitHub topic.
3. Push the reviewed release commit and a new `v<version>` tag that matches `package.json`. Use a new version and tag for later corrections.
4. After the next crawl, check the [crawl report](https://getbb.app/marketplace/v1/index/v1/report.json) for `github:ols-md/bb-plugin-antigravity`. Verify the description, category, and overview in the v2 catalog when the replacement is live.

The crawler reads the listing from the newest release tag. Future listing changes use the same release process. The GitHub repository supplies the plugin for installation and updates.

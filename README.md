# PR Commit Tracker

A Chrome extension (Manifest V3) that helps you review large GitHub pull requests
commit by commit. It adds a checkbox to every commit row and a progress badge to the
PR header, so you always know how far you got.

```
Reviewed: 3/10 (30%)
```

## Features

- **Per-commit checkboxes** on the PR `Commits` tab and on commit rows in the
  `Conversation` timeline, placed to the right of the commit hash link. Commits merely
  *referenced* inside a comment body are ignored, so they never count as commits.
- **Header badge** showing reviewed / total commits and a percentage, rendered next to
  the PR tabs (falling back to the branch line next to the copy icon). The total comes
  from GitHub's own `Commits` tab counter, so it stays correct even on the Conversation
  tab where only some commit rows are rendered.
- **Persistent progress** via `chrome.storage.local` — survives refreshes and
  navigation.
- **Per-PR isolation** — every pull request has its own storage key.
- **SPA-aware** — a `MutationObserver` re-injects the UI when GitHub swaps the DOM.
- **Popup** with the current PR's status and a `Reset PR Progress` button.
- **Fully local** — no network requests, no analytics, nothing leaves your browser.

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select this project folder (the one containing
   `manifest.json`).
5. Open any pull request on `https://github.com/` — for example
   `https://github.com/owner/repo/pull/123/commits`.

To pick up code changes later, press the **Reload** button on the extension card in
`chrome://extensions`, then refresh the GitHub tab.

## Usage

1. Open a pull request and go to the **Commits** tab.
2. Tick the checkbox next to a commit once you have reviewed it. The header badge
   updates immediately.
3. Untick it to mark the commit as unreviewed again.
4. Click the extension icon to see the current PR's progress, or press
   **Reset PR Progress** to clear the progress for that PR (the tab reloads).

## How progress is stored

State lives in `chrome.storage.local` under one key per pull request, derived from the
URL path:

```
pr_reviewed_commits_{owner}_{repo}_pull_{pr_id}
```

For `https://github.com/acme/widgets/pull/42/commits` the key is
`pr_reviewed_commits_acme_widgets_pull_42`.

The stored value is:

```json
{ "v": 1, "shas": ["a1b2c3d…"], "total": 10 }
```

- `shas` — commit SHAs you marked as reviewed.
- `total` — the PR's commit count, read from GitHub's `Commits` tab counter (falling
  back to the number of commit rows on the page only when that counter is missing), so
  the popup can show progress without the page DOM.

Stale SHAs — left behind by a rebase or force-push — are pruned only when every commit
of the PR is rendered on screen. While you are looking at a partial view, commits you
cannot see keep their reviewed state.

Because state is keyed by **commit SHA**, the same commit stays in sync between the
Commits tab, the Conversation timeline, and the single-commit view.

GitHub serves the single-commit view of a PR under two URL shapes — `/pull/{id}/commits/{sha}`
(classic) and `/pull/{id}/changes/{sha}` (newer PR experience). Both are recognised. On that
page you can tick the **Reviewed** checkbox *or* click **Next**; either marks the commit, and
the PR page reflects it.

## File layout

| File            | Purpose                                                            |
| --------------- | ------------------------------------------------------------------ |
| `manifest.json` | MV3 manifest: `storage` permission, `https://github.com/*` host    |
| `content.js`    | Row discovery, checkbox injection, badge rendering, storage sync    |
| `styles.css`    | Styles for the injected checkboxes and the header badge            |
| `popup.html`    | Popup markup and styles                                            |
| `popup.js`      | Popup status rendering and the reset action                        |

`content.js` and `popup.js` each keep their own copy of the storage-key helper: the
content script and the popup run in separate contexts and the extension ships without
a bundler, so the two small helpers are intentionally standalone.

## Troubleshooting

- **No checkboxes or badge appear.** Reload the tab. If it still fails, GitHub may
  have changed its markup — `content.js` matches rows through a fallback chain of
  selectors defined in `COMMIT_ROW_SELECTORS` / `ROW_ANCESTOR_SELECTORS`, the total via
  `COMMIT_TOTAL_SELECTORS`, and the badge host via `HEADER_SELECTORS`.
- **Progress looks reset.** Confirm the URL is still the same PR; the storage key is
  built from `owner`, `repo`, and the PR number.
- **After a force-push, commits show as unreviewed.** Expected — a rebase creates new
  SHAs, so those commits are genuinely different code.

## Known limitations

- On very large PRs GitHub caps and paginates the commit list. The badge's total still
  comes from GitHub's counter, but you can only tick the commits currently rendered.
- If GitHub's commit counter cannot be found, the total falls back to the number of
  commit rows on the page.
- The extension depends on GitHub's DOM structure and can need selector updates when
  GitHub redesigns the PR pages.

## Privacy

The extension requests only the `storage` permission and runs solely on
`https://github.com/*` pull request pages. All data is stored locally in your browser.

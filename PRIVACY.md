# Privacy Policy — PR Commit Tracker

**Last updated: 2026-08-20**

PR Commit Tracker is a Chrome extension that lets you mark which commits of a GitHub
pull request you have already reviewed.

## What the extension stores

Only what is needed to remember your review progress:

- the commit SHAs you have marked as reviewed,
- the number of commits in the pull request,
- keyed per pull request as `pr_reviewed_commits_{owner}_{repo}_pull_{id}`.

Nothing else is read or retained. The extension does not store commit messages, file
contents, diffs, comments, names, or email addresses.

## Where it is stored

Locally on your own device, using the browser's `chrome.storage.local` API. If you have
Chrome profile sync enabled, that data stays inside your own Google account's sync — the
extension itself has no server to send it to.

## What is transmitted

**Nothing.** The extension makes no network requests. There is no backend, no analytics,
no telemetry, no advertising, no third-party services, and no accounts. Your data is
never sold or transferred to anyone, because it never leaves your device.

## What it accesses, and why

- **`storage` permission** — to save your reviewed-commit list between page loads.
- **Access to `https://github.com/*`** — its content script runs only on
  `https://github.com/*/*/pull/*` URLs. There it reads the commit SHAs already rendered
  on the page in order to place a checkbox on each commit row and a progress badge in
  the pull request header. It does not access any other website.

## Deleting your data

- Use **Reset PR Progress** in the extension popup to clear the stored progress for the
  pull request you are viewing.
- Removing the extension from `chrome://extensions` deletes all of its stored data.

## Changes to this policy

Any change will be published in this file, with the date above updated.

## Contact

Questions about this policy: <your contact email>

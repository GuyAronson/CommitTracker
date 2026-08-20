# Chrome Web Store submission notes

Copy-paste material for the Developer Dashboard listing. Keep this in sync with
`manifest.json` whenever permissions change.

## Item details

- **Name:** PR Commit Tracker
- **Category:** Developer Tools
- **Language:** English

**Short description** (132 characters max)

```
Track which commits you have already reviewed on a GitHub pull request, with a progress badge in the PR header.
```

**Detailed description**

```
Reviewing a large pull request commit by commit is easy to lose track of. PR Commit
Tracker adds a checkbox to every commit row on a GitHub pull request and a progress
badge to the PR header, so you always know how far you got.

Features
- A checkbox next to every commit row, on the Commits tab and in the Conversation timeline.
- A progress badge in the PR header: "Reviewed: 8/36 (22%)".
- On a single commit page, mark it reviewed with the checkbox or simply by clicking Next.
- Progress is stored per pull request and survives refreshes and navigation.
- A popup showing the active PR's progress with a one-click reset.

Everything is stored locally in your browser with chrome.storage.local. The extension
makes no network requests, has no analytics, and no account is required.
```

## Single purpose

```
Track which commits of a GitHub pull request the user has already reviewed, and show
that progress on the pull request page.
```

## Permission justifications

**`storage`**

```
Stores the list of commit SHAs the user has marked as reviewed, one entry per pull
request, so progress survives page refreshes and navigation. Nothing is stored except
commit SHAs and a commit count, and nothing is transmitted anywhere.
```

**Host permission `https://github.com/*`**

```
The extension's entire function is to annotate GitHub pull request pages. Its content
script runs only on https://github.com/*/*/pull/* URLs, where it reads the rendered
commit rows to find commit SHAs, injects review checkboxes, and adds a progress badge
to the PR header. No other site is accessed and no page data leaves the browser.
```

## Remote code

Answer: **No, I am not using remote code.**

Every line the extension runs ships inside the package. Verified: no `eval` /
`new Function`, no `fetch` / `XMLHttpRequest` / `WebSocket`, no dynamic `import()`, no
CDN `<script>` or `<link>` tags, and `popup.html` loads only local `popup.js`. The
`https://github.com/*` strings in `manifest.json` are match patterns, not code sources.

## Data usage disclosures

Certify all of the following:

- Does **not** collect or use personally identifiable information.
- Does **not** collect or use health, financial, authentication, personal
  communications, location, web history, or user activity data.
- Does **not** collect website content. (Commit SHAs are read from the page and stored
  locally on the user's own device; they are never transmitted.)
- Does **not** sell or transfer data to third parties.
- Does **not** use or transfer data for purposes unrelated to the single purpose.
- Does **not** use or transfer data to determine creditworthiness or for lending.

### Which boxes to tick

**None of them.** The extension collects nothing: commit SHAs are read from the page
you are already viewing and written to `chrome.storage.local` on your own device, and
nothing is ever transmitted off the device. The dashboard's data-usage form is about
data your extension *collects* — that is, obtains or transmits — not about DOM your
content script happens to read and keep locally.

The one box worth a second thought is **Website content**, since the content script does
read the page. Leaving it unticked is the standard call for a local-only extension and
is what the certification statements below support. If a reviewer disagrees, tick
*Website content*, state that it is limited to commit SHAs stored locally, and resubmit
— that is a normal review exchange, not a policy strike.

Then certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

### Privacy policy URL

The dashboard asks for one. Use the published `PRIVACY.md` in this repository:

```
https://github.com/GuyAronson/CommitTracker/blob/main/PRIVACY.md
```

Two conditions before pasting it:

1. The repository must be **public** and the file must be reachable at that URL — push
   `main` (or merge the feature branch) first, otherwise the link 404s and the review is
   rejected. Do not point at a branch you might delete later.
2. Fill in the contact email placeholder at the bottom of `PRIVACY.md`.

## Graphics checklist

- **Store icon:** 128x128 PNG — use `icons/icon128.png`.
- **Screenshots:** at least one, 1280x800 or 640x400 PNG/JPEG. Good candidates:
  1. The Commits tab with checkboxes and the header badge visible.
  2. A single commit page showing the "Reviewed" checkbox next to Prev/Next.
  3. The popup showing progress and the reset button.
- Crop screenshots to the exact required size; the dashboard rejects other dimensions.

## Before every upload

1. Bump `version` in `manifest.json` — an upload with a version already used is rejected.
2. Rebuild the zip (see README, "Packaging for the Chrome Web Store").
3. Confirm `manifest.json` is at the root of the zip, not inside a folder.

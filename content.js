/**
 * PR Commit Tracker - content script.
 *
 * Injects a review checkbox next to every commit row of a GitHub pull request and a
 * progress badge into the PR header. Reviewed commits are keyed by commit SHA and
 * persisted per pull request in chrome.storage.local.
 */
(() => {
  "use strict";

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const STORAGE_KEY_PREFIX = "pr_reviewed_commits";
  const STATE_VERSION = 1;

  const PR_PATH_REGEX = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const COMMIT_HREF_REGEX = /\/(?:commit|commits|changes)\/([0-9a-f]{7,40})(?:[/?#]|$)/;
  /**
   * A single commit of a PR. The newer PR experience serves it under /changes/{sha},
   * the classic one under /commits/{sha}.
   */
  const PR_COMMIT_PATH_REGEX =
    /^\/[^/]+\/[^/]+\/pull\/\d+\/(?:commits|changes)\/([0-9a-f]{7,40})/;

  const CLASS_CHECKBOX = "ct-review-checkbox";
  const CLASS_LABEL = "ct-review-label";
  const CLASS_LABEL_BLOCK = "ct-review-label--block";
  const CLASS_BADGE = "ct-review-badge";
  const CLASS_PROCESSED = "ct-review-processed";
  const ATTR_SHA = "data-ct-sha";
  const BADGE_ID = "ct-review-badge";

  /** Row containers on the "Commits" tab, most specific first. */
  const COMMIT_ROW_SELECTORS = [
    '[data-testid="commit-row-item"]',
    '[data-testid="commit-row"]',
    "li.js-commits-list-item",
    ".js-commits-list-item",
  ];

  /**
   * Containers whose commit links are mere references (a comment body quoting a
   * commit, the header, our own badge). Links inside these are never commit rows.
   */
  const NON_ROW_ANCESTOR_SELECTORS = [
    ".comment-body",
    ".js-comment-body",
    ".markdown-body",
    '[data-testid="comment-body"]',
    ".gh-header",
    "#partial-discussion-header",
    ".tabnav-tabs",
    'nav[aria-label="Pull request tabs"]',
  ];

  /** Accessible names that identify the "next commit" control, lowercased. */
  const NEXT_CONTROL_LABELS = ["next", "next commit", "next \u203a", "\u203a"];
  const NEXT_KEYWORD = "next";
  const NEXT_CONTROL_SELECTORS = ['a[rel="next"]', '[data-testid="next-commit"]'];
  /** Icon-only paginators: GitHub renders "next" as a right chevron/arrow octicon. */
  const NEXT_ICON_SELECTORS = [".octicon-chevron-right", ".octicon-arrow-right"];
  /** GitHub binds the next-commit hotkey to the right arrow key. */
  const NEXT_HOTKEY = "arrowright";
  const CLICKABLE_SELECTOR = 'a, button, [role="button"]';

  /** Anchor text of a commit-hash link, e.g. "41d2677". */
  const SHORT_SHA_TEXT_REGEX = /^[0-9a-f]{7,10}$/;

  /** GitHub's own commit counter in the PR nav, most specific first. */
  const COMMIT_TOTAL_SELECTORS = [
    "#commits_tab_counter",
    '[data-testid="commits-tab-counter"]',
    'a[data-tab-item="commits_tab"] .Counter',
    'nav a[href$="/commits"] .Counter',
  ];

  /** Ancestors accepted as a "row" when falling back to link discovery. */
  const ROW_ANCESTOR_SELECTORS = [
    '[data-testid="commit-row-item"]',
    '[data-testid="commit-row"]',
    "li.js-commits-list-item",
    "li",
    '[role="listitem"]',
    ".TimelineItem",
    "tr",
  ];

  /** PR header containers that can host the badge, most specific first. */
  const HEADER_SELECTORS = [
    "#partial-discussion-header .gh-header-meta",
    ".gh-header-meta",
    "#partial-discussion-header",
    ".gh-header-show",
    ".gh-header",
  ];

  /** The branch line of the modern, React-rendered PR header. */
  const REF_LABEL_SELECTORS = [
    '[data-testid="head-ref"]',
    '[data-testid="base-ref"]',
    ".head-ref",
    ".base-ref",
  ];

  /** Hosts for the checkbox on a single-commit page, most specific first. */
  const COMMIT_PAGE_HOST_SELECTORS = [
    ".commit-meta",
    '[data-testid="commit-header"]',
    ".commit-title",
    ".commit.full-commit",
  ];

  const LABEL_TEXT_REVIEWED = "Reviewed";
  const PREV_KEYWORD = "previous";
  const PREV_ICON_SELECTOR = ".octicon-chevron-left";
  /** How far to climb from a paginator control to the element holding both buttons. */
  const PAGINATOR_GROUP_MAX_DEPTH = 3;
  /** How far to climb looking for an ancestor that stacks its children vertically. */
  const BLOCK_ANCESTOR_MAX_DEPTH = 6;
  const VERTICAL_DISPLAYS = ["block", "flow-root", "list-item"];
  const FLEX_DISPLAYS = ["flex", "inline-flex"];

  const BADGE_STATE = { EMPTY: "empty", PARTIAL: "partial", COMPLETE: "complete" };
  const DEBOUNCE_MS = 150;
  const LOG_PREFIX = "PR Commit Tracker:";

  /* ------------------------------------------------------------------ *
   * Module state
   * ------------------------------------------------------------------ */

  let observer = null;
  let debounceTimer = null;
  let syncInFlight = false;
  let resyncRequested = false;
  let selfWrites = 0;
  /** Last state read for lastKey, so a click can write without re-reading first. */
  let lastKey = null;
  let lastState = null;
  let warnedMissingHeader = false;
  let lastHref = location.href;

  /* ------------------------------------------------------------------ *
   * PR context + storage
   * ------------------------------------------------------------------ */

  /** @returns {{owner: string, repo: string, prId: string}|null} */
  function parsePrContext() {
    const match = PR_PATH_REGEX.exec(location.pathname);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prId: match[3] };
  }

  function storageKey({ owner, repo, prId }) {
    return `${STORAGE_KEY_PREFIX}_${owner}_${repo}_pull_${prId}`;
  }

  function emptyState() {
    return { v: STATE_VERSION, shas: [], total: 0 };
  }

  /** Accepts the current object shape and the legacy bare-array shape. */
  function normalizeState(raw) {
    if (Array.isArray(raw)) {
      return { v: STATE_VERSION, shas: raw.filter((s) => typeof s === "string"), total: 0 };
    }
    if (raw && typeof raw === "object") {
      const shas = Array.isArray(raw.shas) ? raw.shas.filter((s) => typeof s === "string") : [];
      const total = Number.isInteger(raw.total) && raw.total >= 0 ? raw.total : 0;
      return { v: STATE_VERSION, shas, total };
    }
    return emptyState();
  }

  function extensionAlive() {
    return Boolean(chrome.runtime && chrome.runtime.id);
  }

  async function loadState(key) {
    if (!extensionAlive()) return emptyState();
    try {
      const stored = await chrome.storage.local.get(key);
      return normalizeState(stored[key]);
    } catch {
      console.warn(LOG_PREFIX, "could not read saved progress.");
      return emptyState();
    }
  }

  async function saveState(key, shas, total) {
    if (!extensionAlive()) return;
    try {
      selfWrites += 1;
      await chrome.storage.local.set({ [key]: { v: STATE_VERSION, shas, total } });
    } catch {
      selfWrites = Math.max(0, selfWrites - 1);
      console.warn(LOG_PREFIX, "could not save progress.");
    }
  }

  /* ------------------------------------------------------------------ *
   * DOM discovery
   * ------------------------------------------------------------------ */

  /**
   * The SHA of the single commit being viewed, or null on any other PR page.
   * @returns {string|null}
   */
  function currentCommitSha() {
    const match = PR_COMMIT_PATH_REGEX.exec(location.pathname);
    return match ? match[1] : null;
  }

  /**
   * Recognises the "Next" commit control by rel, accessible name, or visible text.
   * Only ever consulted on a single-commit page, so a substring match on the
   * accessible name is safe.
   */
  function isNextControl(element) {
    if (NEXT_CONTROL_SELECTORS.some((selector) => element.matches(selector))) return true;

    const named = ["aria-label", "title", "data-testid", "data-hotkey"]
      .map((name) => element.getAttribute(name) || "")
      .join(" ")
      .toLowerCase();
    if (named.includes(NEXT_KEYWORD) || named.replace(/\s+/g, "").includes(NEXT_HOTKEY)) return true;

    const text = (element.textContent || "").trim().toLowerCase();
    if (NEXT_CONTROL_LABELS.includes(text) || text.startsWith(NEXT_KEYWORD)) return true;

    // Icon-only control: a right chevron/arrow inside it means "next".
    return NEXT_ICON_SELECTORS.some((selector) => element.querySelector(selector));
  }

  /**
   * The commit paginator control the checkbox should sit before: "Prev" when
   * present, otherwise "Next". Used on pages that have no legacy commit-meta box.
   * @returns {Element|null}
   */
  function findPaginatorControl() {
    const controls = [...document.querySelectorAll(CLICKABLE_SELECTOR)];
    for (const element of controls) {
      const named = (element.getAttribute("aria-label") || "").toLowerCase();
      if (named.includes(PREV_KEYWORD)) return element;
    }
    for (const element of controls) {
      if (element.querySelector(PREV_ICON_SELECTOR)) return element;
    }
    for (const element of controls) {
      if (isNextControl(element)) return element;
    }
    return null;
  }

  /** The nearest ancestor of a paginator control that holds both Prev and Next. */
  function paginatorGroup(control) {
    let node = control.parentElement;
    for (let depth = 0; node && depth < PAGINATOR_GROUP_MAX_DEPTH; depth += 1) {
      if (node.querySelectorAll(CLICKABLE_SELECTOR).length >= 2) return node;
      node = node.parentElement;
    }
    return control.parentElement || control;
  }

  /** True when a container lays its children out one below the other. */
  function stacksVertically(element) {
    const style = window.getComputedStyle(element);
    if (VERTICAL_DISPLAYS.includes(style.display)) return true;
    if (FLEX_DISPLAYS.includes(style.display)) return style.flexDirection.startsWith("column");
    return false;
  }

  /**
   * The node to insert after so the label lands on its own line: the highest
   * descendant of a vertically-stacking container that still holds the paginator.
   * Without this the label becomes another item of the buttons' flex row.
   * @returns {Element}
   */
  function verticalInsertionPoint(group) {
    let node = group;
    for (let depth = 0; node.parentElement && depth < BLOCK_ANCESTOR_MAX_DEPTH; depth += 1) {
      if (stacksVertically(node.parentElement)) return node;
      node = node.parentElement;
    }
    return group;
  }

  function isReference(element) {
    return NON_ROW_ANCESTOR_SELECTORS.some((selector) => element.closest(selector));
  }

  function commitLinkSha(link, repoPathPrefix) {
    const href = link.getAttribute("href") || "";
    if (!href.includes(repoPathPrefix)) return null;
    const match = COMMIT_HREF_REGEX.exec(href);
    return match ? match[1] : null;
  }

  /**
   * Extracts the commit SHA of a row plus the anchor the checkbox should follow:
   * the hash link ("41d2677") when present, otherwise the last commit link.
   * @returns {{sha: string, anchor: Element}|null}
   */
  function commitInfoFromRow(row, repoPathPrefix) {
    let sha = null;
    let anchor = null;
    let hashAnchor = null;

    for (const link of row.querySelectorAll("a[href]")) {
      const linkSha = commitLinkSha(link, repoPathPrefix);
      if (!linkSha) continue;
      if (!sha) sha = linkSha;
      anchor = link;
      if (SHORT_SHA_TEXT_REGEX.test((link.textContent || "").trim())) hashAnchor = link;
    }

    if (!sha) {
      const clipboard = row.querySelector("[data-clipboard-text]");
      const value = clipboard ? (clipboard.getAttribute("data-clipboard-text") || "").trim() : "";
      if (!/^[0-9a-f]{7,40}$/.test(value)) return null;
      sha = value;
      anchor = clipboard;
    }

    return { sha, anchor: hashAnchor || anchor || row };
  }

  function closestRow(element) {
    for (const selector of ROW_ANCESTOR_SELECTORS) {
      const row = element.closest(selector);
      if (row) return row;
    }
    return element.parentElement;
  }

  /**
   * Collects unique commit rows currently rendered on the page.
   * @returns {Array<{row: Element, sha: string}>}
   */
  function findCommitRows(ctx) {
    const repoPathPrefix = `/${ctx.owner}/${ctx.repo}/`;
    const seenRows = new Set();
    const seenShas = new Set();
    const rows = [];

    const push = (row) => {
      if (!row || seenRows.has(row) || isReference(row)) return;
      const info = commitInfoFromRow(row, repoPathPrefix);
      if (!info || seenShas.has(info.sha)) return;
      seenRows.add(row);
      seenShas.add(info.sha);
      rows.push({ row, sha: info.sha, anchor: info.anchor });
    };

    for (const selector of COMMIT_ROW_SELECTORS) {
      for (const row of document.querySelectorAll(selector)) push(row);
    }

    // Timeline coverage: commit links outside a comment body, climbed to their row.
    for (const link of document.querySelectorAll(`a[href*="${repoPathPrefix}"]`)) {
      if (isReference(link)) continue;
      if (!commitLinkSha(link, repoPathPrefix)) continue;
      push(closestRow(link));
    }

    return rows;
  }

  /** The PR's "Commits" tab link, located by href rather than by class name. */
  function commitsTabLink() {
    for (const link of document.querySelectorAll('a[href*="/pull/"]')) {
      if (/\/pull\/\d+\/commits\/?$/.test(link.getAttribute("href") || "")) return link;
    }
    return null;
  }

  function firstNumberIn(text) {
    const match = /\d+/.exec(String(text).replace(/[,\s]/g, ""));
    if (!match) return null;
    const value = Number.parseInt(match[0], 10);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  /**
   * Reads the PR's authoritative commit count from GitHub's nav counter.
   * The counter is abbreviated for large numbers ("250+"), so the full value is
   * taken from its title attribute when present.
   * @returns {number|null} null when the counter is absent or unparseable.
   */
  function readCommitTotal() {
    for (const selector of COMMIT_TOTAL_SELECTORS) {
      const element = document.querySelector(selector);
      if (!element) continue;
      const fromTitle = firstNumberIn(element.getAttribute("title") || "");
      if (fromTitle) return fromTitle;
      const fromText = firstNumberIn(element.textContent || "");
      if (fromText) return fromText;
    }
    // Newer header: read the digits off the "Commits 36" tab link itself.
    const tab = commitsTabLink();
    return tab ? firstNumberIn(tab.textContent || "") : null;
  }

  function firstMatch(selectors) {
    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) return element;
    }
    return null;
  }

  /**
   * Ordered strategies for locating a visible host for the badge. GitHub's newer PR
   * header is React-rendered and drops the legacy class names, so class-based
   * lookups cannot be the only option.
   * @returns {Element|null}
   */
  function findHeaderContainer() {
    const strategies = [
      // Legacy header: the "wants to merge N commits into X from Y" line.
      () => firstMatch(HEADER_SELECTORS.slice(0, 2)),
      // Modern header: the row holding the base/head branch labels.
      () => {
        const ref = firstMatch(REF_LABEL_SELECTORS);
        return ref ? ref.parentElement : null;
      },
      // The PR tab bar, found through the Commits tab link (no class names involved).
      () => {
        const tab = commitsTabLink();
        return tab ? tab.closest("nav") : null;
      },
      // Legacy header wrappers.
      () => firstMatch(HEADER_SELECTORS.slice(2)),
      // Last resort: whatever contains the PR title.
      () => {
        const title = document.querySelector('.js-issue-title, [data-testid="issue-title"], h1');
        return title ? title.parentElement : null;
      },
    ];

    for (const strategy of strategies) {
      const container = strategy();
      if (container) return container;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Injection + rendering
   * ------------------------------------------------------------------ */

  function createCheckbox(sha) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = CLASS_CHECKBOX;
    checkbox.setAttribute(ATTR_SHA, sha);
    checkbox.setAttribute("aria-label", `Mark commit ${sha.slice(0, 7)} as reviewed`);
    checkbox.title = "Mark this commit as reviewed";
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", onToggle);
    return checkbox;
  }

  /**
   * Injects a labelled checkbox on a single-commit page, next to the commit hash.
   * The paginator links point at other commits, so the row scan is not used here.
   */
  function injectCommitPageCheckbox(sha) {
    if (document.querySelector(`.${CLASS_CHECKBOX}[${ATTR_SHA}="${sha}"]`)) return;

    let anchor = null;
    for (const element of document.querySelectorAll("[data-clipboard-text]")) {
      const value = (element.getAttribute("data-clipboard-text") || "").trim();
      if (value && (value.startsWith(sha) || sha.startsWith(value))) {
        anchor = element;
        break;
      }
    }

    const paginator = anchor ? null : findPaginatorControl();
    const host = anchor || paginator || firstMatch(COMMIT_PAGE_HOST_SELECTORS) || findHeaderContainer();
    if (!host) return;

    const label = document.createElement("label");
    label.className = CLASS_LABEL;
    label.appendChild(createCheckbox(sha));
    label.appendChild(document.createTextNode(LABEL_TEXT_REVIEWED));

    if (anchor) {
      anchor.insertAdjacentElement("afterend", label);
    } else if (paginator) {
      // Own line under the Prev/Next row, not another item of its flex row.
      const group = paginatorGroup(paginator);
      label.classList.add(CLASS_LABEL_BLOCK);
      verticalInsertionPoint(group).insertAdjacentElement("afterend", label);
    } else {
      host.appendChild(label);
    }
  }

  function injectCheckboxes(rows) {
    for (const { row, sha, anchor } of rows) {
      if (row.classList.contains(CLASS_PROCESSED)) continue;
      row.classList.add(CLASS_PROCESSED);
      const checkbox = createCheckbox(sha);
      // Sit to the right of the commit hash link; fall back to the end of the row.
      if (anchor && anchor !== row && anchor.parentElement) {
        anchor.insertAdjacentElement("afterend", checkbox);
      } else {
        row.appendChild(checkbox);
      }
    }
  }

  function syncCheckboxes(reviewed) {
    for (const checkbox of document.querySelectorAll(`.${CLASS_CHECKBOX}`)) {
      const sha = checkbox.getAttribute(ATTR_SHA);
      checkbox.checked = Boolean(sha) && reviewed.has(sha);
    }
  }

  function badgeState(reviewedCount, total) {
    if (reviewedCount === 0) return BADGE_STATE.EMPTY;
    if (reviewedCount >= total) return BADGE_STATE.COMPLETE;
    return BADGE_STATE.PARTIAL;
  }

  /**
   * Puts the badge in the PR header, next to the branch line's copy icon, falling
   * back to just after the PR tab bar.
   * @returns {boolean} false when no host exists yet (a later sync retries).
   */
  function placeBadge(badge) {
    const container = findHeaderContainer();
    if (!container) {
      if (!warnedMissingHeader) {
        warnedMissingHeader = true;
        console.warn(LOG_PREFIX, "could not find a PR header element to host the badge.");
      }
      return false;
    }
    if (badge.parentElement !== container) container.appendChild(badge);
    return true;
  }

  function renderBadge(reviewedCount, total) {
    const existing = document.getElementById(BADGE_ID);

    if (total === 0) {
      if (existing) existing.remove();
      return;
    }

    const badge = existing || document.createElement("span");
    if (!existing) {
      badge.id = BADGE_ID;
      badge.className = CLASS_BADGE;
    }
    if (!placeBadge(badge)) return;

    const percent = Math.round((reviewedCount / total) * 100);
    badge.textContent = `Reviewed: ${reviewedCount}/${total} (${percent}%)`;
    badge.title = "Commits you have marked as reviewed on this pull request";
    badge.dataset.state = badgeState(reviewedCount, total);
  }

  function removeCheckboxes() {
    for (const label of document.querySelectorAll(`.${CLASS_LABEL}`)) label.remove();
    for (const checkbox of document.querySelectorAll(`.${CLASS_CHECKBOX}`)) checkbox.remove();
    for (const row of document.querySelectorAll(`.${CLASS_PROCESSED}`)) {
      row.classList.remove(CLASS_PROCESSED);
    }
  }

  function removeInjectedNodes() {
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
    removeCheckboxes();
  }

  /* ------------------------------------------------------------------ *
   * Sync cycle
   * ------------------------------------------------------------------ */

  async function onToggle(event) {
    const checkbox = event.currentTarget;
    const sha = checkbox.getAttribute(ATTR_SHA);
    const ctx = parsePrContext();
    if (!ctx || !sha) return;

    const key = storageKey(ctx);
    const state = await loadState(key);
    const reviewed = new Set(state.shas);
    if (checkbox.checked) reviewed.add(sha);
    else reviewed.delete(sha);

    await saveState(key, [...reviewed], state.total);
    await performSync();
  }

  async function markReviewed(sha) {
    const ctx = parsePrContext();
    if (!ctx || !sha) return;
    const key = storageKey(ctx);
    const state = lastKey === key && lastState ? lastState : await loadState(key);
    if (state.shas.includes(sha)) return;

    const shas = [...state.shas, sha];
    lastKey = key;
    lastState = { v: STATE_VERSION, shas, total: state.total };
    // Not awaited: the click is about to navigate away, so the write must not wait
    // on a render pass. saveState reports its own failures.
    void saveState(key, shas, state.total);
    void performSync();
  }

  /** On a single-commit page, clicking "Next" marks the commit just read as reviewed. */
  function onDocumentClick(event) {
    const sha = currentCommitSha();
    if (!sha) return;
    const target = event.target instanceof Element ? event.target : null;
    const control = target ? target.closest(CLICKABLE_SELECTOR) : null;
    if (!control || !isNextControl(control)) return;
    void markReviewed(sha);
  }

  async function performSync() {
    if (syncInFlight) {
      resyncRequested = true;
      return;
    }
    syncInFlight = true;
    try {
      const ctx = parsePrContext();
      if (!ctx) {
        removeInjectedNodes();
        return;
      }

      const key = storageKey(ctx);
      const state = await loadState(key);
      lastKey = key;
      lastState = state;
      const reviewed = new Set(state.shas);

      // Pause observation so our own DOM writes do not re-trigger a sync.
      if (observer) observer.disconnect();
      try {
        // Viewing one commit: a labelled checkbox plus the "Next" control both mark it.
        const commitSha = currentCommitSha();
        if (commitSha) {
          injectCommitPageCheckbox(commitSha);
          syncCheckboxes(reviewed);
          const commitPageTotal = readCommitTotal() || state.total;
          renderBadge(Math.min(reviewed.size, commitPageTotal), commitPageTotal);
          if (commitPageTotal > 0 && commitPageTotal !== state.total) {
            void saveState(key, [...reviewed], commitPageTotal);
          }
          return;
        }

        const rows = findCommitRows(ctx);
        injectCheckboxes(rows);
        syncCheckboxes(reviewed);

        // Prefer GitHub's own counter: the page can render a subset of the PR's
        // commits (Conversation timeline, pagination), which would understate the total.
        const total = readCommitTotal() || rows.length;
        const pageShas = new Set(rows.map(({ sha }) => sha));
        const showsEveryCommit = total > 0 && pageShas.size >= total;

        // Stale SHAs (rebase, force-push) are dropped only when every commit is on
        // screen; otherwise commits we cannot see would lose their reviewed state.
        const nextShas = showsEveryCommit
          ? [...reviewed].filter((sha) => pageShas.has(sha))
          : [...reviewed];

        renderBadge(Math.min(nextShas.length, total), total);

        const totalChanged = total !== state.total;
        const shasChanged = nextShas.length !== state.shas.length;
        if (total > 0 && (totalChanged || shasChanged)) {
          // Cache the total so the popup can render progress without the page DOM.
          void saveState(key, nextShas, total);
        }
      } finally {
        startObserving();
      }
    } catch (error) {
      console.error(LOG_PREFIX, "sync failed.", error);
    } finally {
      syncInFlight = false;
      if (resyncRequested) {
        resyncRequested = false;
        scheduleSync();
      }
    }
  }

  function scheduleSync() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void performSync();
    }, DEBOUNCE_MS);
  }

  function handleMutations() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      removeInjectedNodes();
    }
    scheduleSync();
  }

  function startObserving() {
    if (!observer) observer = new MutationObserver(handleMutations);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   * Bootstrap
   * ------------------------------------------------------------------ */

  if (extensionAlive()) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const ctx = parsePrContext();
      if (!ctx || !(storageKey(ctx) in changes)) return;
      if (selfWrites > 0) {
        selfWrites -= 1;
        return;
      }
      scheduleSync();
    });
  }

  document.addEventListener("click", onDocumentClick, true);
  window.addEventListener("popstate", handleMutations);
  window.addEventListener("pageshow", scheduleSync);

  startObserving();
  void performSync();
})();

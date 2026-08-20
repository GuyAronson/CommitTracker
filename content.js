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
  const COMMIT_HREF_REGEX = /\/(?:commit|commits)\/([0-9a-f]{7,40})(?:[/?#]|$)/;

  const CLASS_CHECKBOX = "ct-review-checkbox";
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

  function shaFromElement(element, repoPathPrefix) {
    const links = element.querySelectorAll("a[href]");
    for (const link of links) {
      const href = link.getAttribute("href") || "";
      if (!href.includes(repoPathPrefix)) continue;
      const match = COMMIT_HREF_REGEX.exec(href);
      if (match) return match[1];
    }
    const clipboard = element.querySelector("[data-clipboard-text]");
    if (clipboard) {
      const value = (clipboard.getAttribute("data-clipboard-text") || "").trim();
      if (/^[0-9a-f]{7,40}$/.test(value)) return value;
    }
    return null;
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
    const rows = [];

    const push = (row, sha) => {
      if (!row || !sha || seenRows.has(row)) return;
      seenRows.add(row);
      rows.push({ row, sha });
    };

    for (const selector of COMMIT_ROW_SELECTORS) {
      for (const row of document.querySelectorAll(selector)) {
        push(row, shaFromElement(row, repoPathPrefix));
      }
    }

    // Fallback / timeline coverage: find commit links, then climb to their row.
    for (const link of document.querySelectorAll(`a[href*="${repoPathPrefix}"]`)) {
      const href = link.getAttribute("href") || "";
      const match = COMMIT_HREF_REGEX.exec(href);
      if (!match) continue;
      if (link.closest(`.${CLASS_BADGE}`)) continue;
      push(closestRow(link), match[1]);
    }

    return rows;
  }

  function findHeaderContainer() {
    for (const selector of HEADER_SELECTORS) {
      const container = document.querySelector(selector);
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

  function injectCheckboxes(rows) {
    for (const { row, sha } of rows) {
      if (row.classList.contains(CLASS_PROCESSED)) continue;
      row.classList.add(CLASS_PROCESSED);
      row.insertBefore(createCheckbox(sha), row.firstChild);
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

  function renderBadge(reviewedCount, total) {
    const existing = document.getElementById(BADGE_ID);

    if (total === 0) {
      if (existing) existing.remove();
      return;
    }

    const container = findHeaderContainer();
    if (!container) return;

    const badge = existing || document.createElement("span");
    if (!existing) {
      badge.id = BADGE_ID;
      badge.className = CLASS_BADGE;
    }
    if (badge.parentElement !== container) container.appendChild(badge);

    const percent = Math.round((reviewedCount / total) * 100);
    badge.textContent = `Reviewed: ${reviewedCount}/${total} (${percent}%)`;
    badge.title = "Commits you have marked as reviewed on this pull request";
    badge.dataset.state = badgeState(reviewedCount, total);
  }

  function removeInjectedNodes() {
    const badge = document.getElementById(BADGE_ID);
    if (badge) badge.remove();
    for (const checkbox of document.querySelectorAll(`.${CLASS_CHECKBOX}`)) checkbox.remove();
    for (const row of document.querySelectorAll(`.${CLASS_PROCESSED}`)) {
      row.classList.remove(CLASS_PROCESSED);
    }
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
      const reviewed = new Set(state.shas);

      // Pause observation so our own DOM writes do not re-trigger a sync.
      if (observer) observer.disconnect();
      try {
        const rows = findCommitRows(ctx);
        injectCheckboxes(rows);
        syncCheckboxes(reviewed);

        const total = rows.length;
        const reviewedOnPage = rows.filter(({ sha }) => reviewed.has(sha)).length;
        renderBadge(reviewedOnPage, total);

        if (total > 0 && total !== state.total) {
          // Cache the page total so the popup can render progress without the DOM.
          void saveState(key, [...reviewed], total);
        }
      } finally {
        startObserving();
      }
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

  window.addEventListener("popstate", handleMutations);
  window.addEventListener("pageshow", scheduleSync);

  startObserving();
  void performSync();
})();

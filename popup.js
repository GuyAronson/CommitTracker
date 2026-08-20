/**
 * PR Commit Tracker - popup logic.
 *
 * Shows the review progress stored for the pull request in the active tab and
 * lets the user clear it.
 */
(() => {
  "use strict";

  const STORAGE_KEY_PREFIX = "pr_reviewed_commits";
  const PR_PATH_REGEX = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const GITHUB_HOSTNAME = "github.com";

  const MESSAGE_NOT_A_PR = "Open a GitHub pull request to see progress.";
  const MESSAGE_READ_FAILED = "Could not read saved progress.";
  const MESSAGE_RESET_FAILED = "Could not reset progress.";
  const MESSAGE_NO_COMMITS = "No commits tracked yet.";

  const prLabel = document.getElementById("pr-label");
  const progressLabel = document.getElementById("progress");
  const resetButton = document.getElementById("reset");

  /** @returns {{owner: string, repo: string, prId: string}|null} */
  function parsePrContext(rawUrl) {
    if (!rawUrl) return null;
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return null;
    }
    if (url.hostname !== GITHUB_HOSTNAME) return null;
    const match = PR_PATH_REGEX.exec(url.pathname);
    if (!match) return null;
    return { owner: match[1], repo: match[2], prId: match[3] };
  }

  function storageKey({ owner, repo, prId }) {
    return `${STORAGE_KEY_PREFIX}_${owner}_${repo}_pull_${prId}`;
  }

  function normalizeState(raw) {
    if (Array.isArray(raw)) {
      return { shas: raw.filter((s) => typeof s === "string"), total: 0 };
    }
    if (raw && typeof raw === "object") {
      return {
        shas: Array.isArray(raw.shas) ? raw.shas.filter((s) => typeof s === "string") : [],
        total: Number.isInteger(raw.total) && raw.total >= 0 ? raw.total : 0,
      };
    }
    return { shas: [], total: 0 };
  }

  function renderProgress(state) {
    const reviewed = state.shas.length;
    const total = Math.max(state.total, reviewed);
    if (total === 0) {
      progressLabel.textContent = MESSAGE_NO_COMMITS;
      return;
    }
    const percent = Math.round((reviewed / total) * 100);
    progressLabel.textContent = `Reviewed: ${reviewed}/${total} (${percent}%)`;
  }

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function init() {
    const tab = await getActiveTab();
    const ctx = parsePrContext(tab && tab.url);

    if (!ctx || !tab) {
      prLabel.textContent = MESSAGE_NOT_A_PR;
      progressLabel.textContent = "";
      resetButton.disabled = true;
      return;
    }

    prLabel.textContent = `${ctx.owner}/${ctx.repo} #${ctx.prId}`;
    const key = storageKey(ctx);

    try {
      const stored = await chrome.storage.local.get(key);
      renderProgress(normalizeState(stored[key]));
    } catch {
      progressLabel.textContent = MESSAGE_READ_FAILED;
    }

    resetButton.disabled = false;
    resetButton.addEventListener("click", async () => {
      resetButton.disabled = true;
      try {
        await chrome.storage.local.remove(key);
        await chrome.tabs.reload(tab.id);
        window.close();
      } catch {
        progressLabel.textContent = MESSAGE_RESET_FAILED;
        resetButton.disabled = false;
      }
    });
  }

  void init();
})();

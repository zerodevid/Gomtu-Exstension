function formatValue(raw) {
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return "–";
  const abs = Math.abs(num);
  if (abs >= 1000) return Math.round(num).toLocaleString();
  if (abs >= 100) return num.toFixed(0);
  return num.toFixed(1);
}

function formatTooltipValue(num) {
  const value = typeof num === "number" ? num : Number(num);
  if (!Number.isFinite(value)) return "N/A";
  const abs = Math.abs(value);
  if (abs >= 1000) return Math.round(value).toLocaleString();
  if (abs >= 1) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  }
  if (abs === 0) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 4, minimumFractionDigits: 2 });
}

const MAX_LEADERBOARD_VISIBLE = 3;
const LEADERBOARD_DURATION_PRIORITY = ["7D", "30D", "3M", "6M", "12M", "90D", "ALL"];
const LEADERBOARD_PRIORITY_MAP = LEADERBOARD_DURATION_PRIORITY.reduce((map, key, idx) => {
  map[key] = idx;
  return map;
}, {});

const DEFAULT_SETTINGS = Object.freeze({
  extensionEnabled: true,
  showStatus: true,
  showYaps: true,
  showLeaderboard: true,
  autoReplyEnabled: true,
  autoScrollEnabled: true,
  autoScrollDelayMs: 3500,
  minSmartFollowers: 0,
  minTotalYaps: 0,
  leaderboardProjectFilter: "",
  projectYappingList: [],
});

let currentSettings = { ...DEFAULT_SETTINGS };
let settingsReady = false;
let settingsPromise = null;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        console.warn("Failed to load settings:", chrome.runtime.lastError);
      }
      const merged = { ...DEFAULT_SETTINGS };
      Object.keys(DEFAULT_SETTINGS).forEach((key) => {
        merged[key] = resolveSettingValue(key, items[key]);
      });
      currentSettings = merged;
      updateDerivedSettings(currentSettings);
      settingsReady = true;
      resolve(currentSettings);
    });
  });
}

async function getSettings() {
  if (settingsReady) return currentSettings;
  if (!settingsPromise) settingsPromise = loadSettings();
  return settingsPromise;
}

settingsPromise = loadSettings();

const AUTO_SCROLL_INITIAL_DELAY_MS = 2000;
const AUTO_SCROLL_DEFAULT_DELAY_MS = DEFAULT_SETTINGS.autoScrollDelayMs;
const AUTO_SCROLL_MIN_DELAY_MS = 500;
const AUTO_SCROLL_MAX_DELAY_MS = 60000;
const AUTO_SCROLL_STEP_RATIO = 0.75;
const AUTO_REPLY_DELAY_AFTER_SEND = 50000;
const AUTO_REPLY_GAP = 1200;

const autoReplyStates = new WeakMap();
const autoReplyQueue = [];
let autoReplyActive = false;
let autoScrollTimer = null;
let leaderboardFilterTokens = [];
const processedTweetStates = new Map();

function isExtensionEnabled(settings = currentSettings) {
  return settings?.extensionEnabled !== false;
}

function teardownExtensionUi() {
  document.querySelectorAll(".gomtu-badge-row, .gomtu-leaderboard-toggle").forEach((node) => node.remove());
  document.querySelectorAll("[data-gomtu-eligible]").forEach((article) => {
    article.removeAttribute("data-gomtu-eligible");
    article.removeAttribute("data-gomtu-processed");
  });
  document.querySelectorAll("[data-gomtu-tweet-id]").forEach((article) => article.removeAttribute("data-gomtu-tweet-id"));
  document.querySelectorAll("[data-gomtu-tweet-key]").forEach((article) => article.removeAttribute("data-gomtu-tweet-key"));
  processedTweetStates.clear();
}

function markTweetState(tweetKey, status) {
  if (!tweetKey) return;
  processedTweetStates.set(tweetKey, status);
}

function clearAutoReplyQueue(markStatus = "skipped") {
  if (!autoReplyQueue.length) return;
  const pending = autoReplyQueue.splice(0);
  pending.forEach((task) => {
    const tweetKey = task?.tweetKey || task?.article?.dataset?.gomtuTweetKey || null;
    markTweetState(tweetKey, markStatus);
    if (task.article) {
      autoReplyStates.set(task.article, {
        status: markStatus,
        username: task.username,
        tweetKey,
      });
      task.article.dataset.gomtuEligible = "false";
    }
  });
}

function resolveSettingValue(key, rawValue) {
  if (rawValue === undefined) return DEFAULT_SETTINGS[key];
  switch (key) {
    case "extensionEnabled":
    case "showStatus":
    case "showYaps":
    case "showLeaderboard":
    case "autoReplyEnabled":
    case "autoScrollEnabled":
      return Boolean(rawValue);
    case "autoScrollDelayMs": {
      const num = Number(rawValue);
      if (!Number.isFinite(num)) return AUTO_SCROLL_DEFAULT_DELAY_MS;
      if (num < AUTO_SCROLL_MIN_DELAY_MS) return AUTO_SCROLL_MIN_DELAY_MS;
      if (num > AUTO_SCROLL_MAX_DELAY_MS) return AUTO_SCROLL_MAX_DELAY_MS;
      return num;
    }
    case "minSmartFollowers":
    case "minTotalYaps": {
      const num = Number(rawValue);
      if (!Number.isFinite(num) || num < 0) return 0;
      return Math.floor(num);
    }
    case "leaderboardProjectFilter": {
      if (typeof rawValue !== "string") return "";
      return rawValue.trim();
    }
    case "projectYappingList":
      return Array.isArray(rawValue) ? rawValue : [];
    default:
      return rawValue;
  }
}

function parseLeaderboardFilter(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw
    .split(/[,;\n]+/)
    .map((token) => token.trim().toUpperCase())
    .filter((token) => token.length);
}

function updateDerivedSettings(settings) {
  leaderboardFilterTokens = parseLeaderboardFilter(settings.leaderboardProjectFilter);
}

function extractTweetId(article) {
  if (!article) return null;
  const direct = article.getAttribute("data-tweet-id");
  if (direct) return direct;
  const existing = article.dataset?.gomtuTweetId;
  if (existing) return existing;

  const statusLink =
    article.querySelector('a[href*="/status/"]') ||
    article.querySelector('a[href*="x.com/"][href*="/status/"]');
  if (statusLink) {
    const href = statusLink.getAttribute("href") || statusLink.href || "";
    const match = href.match(/status\/(\d+)/);
    if (match) {
      article.dataset.gomtuTweetId = match[1];
      return match[1];
    }
  }

  const timeEl = article.querySelector("time");
  if (timeEl?.parentElement) {
    const href = timeEl.parentElement.getAttribute("href") || timeEl.parentElement.href || "";
    const match = href.match(/status\/(\d+)/);
    if (match) {
      article.dataset.gomtuTweetId = match[1];
      return match[1];
    }
  }

  return null;
}

function buildFallbackKey(article, username) {
  const namePart = (username || "").toLowerCase();
  const text = (article?.innerText || article?.textContent || "").trim().slice(0, 140);
  const timestamp = article?.querySelector("time")?.getAttribute("datetime") || "";
  const base = text || timestamp;
  return base ? `${namePart}:${base}` : namePart || null;
}

function getArticleKey(article, username) {
  if (!article) return null;
  if (article.dataset?.gomtuTweetKey) return article.dataset.gomtuTweetKey;
  const tweetId = extractTweetId(article);
  const key = tweetId || buildFallbackKey(article, username);
  if (key) {
    article.dataset.gomtuTweetKey = key;
  }
  return key;
}

function findArticleByKey(tweetKey, username) {
  if (!tweetKey) return null;
  const articles = document.querySelectorAll('[role="article"]');
  for (const article of articles) {
    const key = article.dataset?.gomtuTweetKey || getArticleKey(article, username);
    if (key === tweetKey) return article;
  }
  return null;
}

function handleAutomationSettingsChange(changedKeys) {
  if (!Array.isArray(changedKeys) || !changedKeys.length) return;
  const touchedAutoScroll = changedKeys.some((key) =>
    key === "autoScrollEnabled" || key === "autoScrollDelayMs"
  );
  const touchedAutoReply = changedKeys.includes("autoReplyEnabled");
  const touchedThresholds = changedKeys.some((key) =>
    ["minSmartFollowers", "minTotalYaps", "leaderboardProjectFilter"].includes(key)
  );
  const touchedExtensionEnabled = changedKeys.includes("extensionEnabled");

  if (touchedAutoScroll) {
    if (currentSettings.autoScrollEnabled && isExtensionEnabled()) scheduleAutoScroll(true);
    else stopAutoScroll();
  }

  if (touchedAutoReply && (!currentSettings.autoReplyEnabled || !isExtensionEnabled())) {
    clearAutoReplyQueue("skipped");
  }

  if (touchedThresholds && isExtensionEnabled()) {
    clearAutoReplyQueue("skipped");
  }

  if (touchedExtensionEnabled) {
    if (isExtensionEnabled()) {
      processTweets();
      if (currentSettings.autoScrollEnabled) startAutoScroll();
    } else {
      clearAutoReplyQueue("skipped");
      stopAutoScroll();
      teardownExtensionUi();
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, { timeout = 5000, interval = 100 } = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    function check() {
      let result = null;
      try {
        result = predicate();
      } catch (err) {
        console.warn("waitFor predicate error:", err);
      }
      if (result) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= timeout) {
        resolve(null);
        return;
      }
      setTimeout(check, interval);
    }
    check();
  });
}

function getTotalYaps(yapsData) {
  if (!yapsData || typeof yapsData !== "object") return 0;
  const metrics = ["yaps_l24h", "yaps_l48h", "yaps_l7d", "yaps_l30d"];
  return metrics.reduce((sum, key) => {
    const value = Number(yapsData[key]);
    return Number.isFinite(value) ? sum + Math.max(value, 0) : sum;
  }, 0);
}

function matchesLeaderboardFilter(entries) {
  if (!leaderboardFilterTokens.length) return true;
  if (!Array.isArray(entries) || !entries.length) return false;

  return entries.some((entry) => {
    if (!entry) return false;
    const topic = entry.topic || {};
    const candidates = [topic.ticker, topic.name, entry.topic_id]
      .map((bit) => (bit == null ? "" : String(bit).toUpperCase().trim()))
      .filter(Boolean);

    return candidates.some((value) =>
      leaderboardFilterTokens.some((token) => value.includes(token))
    );
  });
}

function shouldAutoReply(data, settings = currentSettings) {
  if (!data || !settings?.autoReplyEnabled || settings.extensionEnabled === false) return false;

  const smartFollowers = Number(data?.status?.smart_follower_count) || 0;
  const totalYaps = getTotalYaps(data?.yaps);

  const minSmart = Math.max(Number(settings.minSmartFollowers) || 0, 0);
  const minYaps = Math.max(Number(settings.minTotalYaps) || 0, 0);

  if (smartFollowers < minSmart) return false;
  if (totalYaps < minYaps) return false;

  const hasScore = smartFollowers > 0 || totalYaps > 0;
  if (!hasScore) return false;

  if (!matchesLeaderboardFilter(data.leaderboard)) return false;

  return true;
}

function findAutoReplyButton(article) {
  if (!article) return null;
  const buttons = Array.from(article.querySelectorAll("button, div[role='button']"));
  return (
    buttons.find((btn) => /auto\s*repl/i.test((btn.textContent || "").trim())) || null
  );
}

function isButtonDisabled(btn) {
  if (!btn) return true;
  if (btn.hasAttribute("disabled")) return true;
  const aria = btn.getAttribute("aria-disabled");
  if (aria === "true") return true;
  return btn.classList.contains("disabled");
}

function findSendButton(root = document) {
  if (!root) return null;
  const selectors = [
    "button[data-testid='tweetButton']",
    "button[data-testid='tweetButtonInline']",
    "div[data-testid='tweetButton']",
    "div[data-testid='tweetButtonInline']",
  ];
  for (const selector of selectors) {
    const candidate = root.querySelector(selector);
    if (candidate) return candidate;
  }
  const buttons = Array.from(root.querySelectorAll("button, div[role='button']"));
  return (
    buttons.find((btn) => /send\s+reply|balas|reply/i.test((btn.textContent || "").trim())) ||
    null
  );
}

function normalizeUsername(value) {
  return (value || "").toString().replace(/^@/, "").toLowerCase();
}

function composerMatchesTarget(composerRoot, username, tweetKey) {
  if (!composerRoot) return false;
  const normalized = normalizeUsername(username);
  if (!normalized) return true;

  const headerAnchors = composerRoot.querySelectorAll('a[href^="/"]');
  for (const anchor of headerAnchors) {
    const href = anchor.getAttribute("href") || anchor.href || "";
    const match = href.match(/^\/([^/?#]+)/);
    if (match && normalizeUsername(match[1]) === normalized) {
      if (tweetKey) {
        const idMatch = href.match(/status\/(\d+)/);
        if (idMatch && tweetKey.includes(idMatch[1])) {
          return true;
        }
      } else {
        return true;
      }
    }
  }

  const labelNode = composerRoot.querySelector('[data-testid="User-Name"]');
  if (labelNode) {
    const text = labelNode.textContent || "";
    if (text.toLowerCase().includes(`@${normalized}`)) {
      return true;
    }
  }

  const rootText = composerRoot.textContent || "";
  if (rootText.toLowerCase().includes(`@${normalized}`)) {
    return true;
  }

  return false;
}

async function performAutoReply({ article, username, tweetKey }) {
  const autoButton = await waitFor(() => findAutoReplyButton(article), {
    timeout: 6000,
    interval: 150,
  });
  if (!autoButton) {
    throw new Error(`Auto Reply button not found for ${username}`);
  }

  autoButton.click();

  const composer = await waitFor(
    () => document.querySelector('[data-testid^="tweetTextarea"]'),
    { timeout: 8000, interval: 150 }
  );

  if (!composer) {
    throw new Error("Reply composer did not appear");
  }

  const composerRoot =
    composer.closest('[role="dialog"]') ||
    composer.closest('[data-testid="sheetDialog"]') ||
    document;

  const textGenerated = await waitFor(() => {
    if (!composer.isConnected) return null;
    const text = (composer.innerText || composer.textContent || "").trim();
    return text.length > 0 ? composer : null;
  }, {
    timeout: 20000,
    interval: 200,
  });

  if (!textGenerated) {
    throw new Error("Auto reply text was not generated");
  }

  if (!composerMatchesTarget(composerRoot, username, tweetKey)) {
    throw new Error("Composer target mismatch, skipping reply");
  }

  const sendButton = await waitFor(() => findSendButton(composerRoot), {
    timeout: 8000,
    interval: 150,
  });

  if (!sendButton) {
    throw new Error("Send reply button not found");
  }

  const readyButton = await waitFor(
    () => (!isButtonDisabled(sendButton) ? sendButton : null),
    { timeout: 8000, interval: 150 }
  );

  if (!readyButton) {
    throw new Error("Send reply button stayed disabled");
  }

  readyButton.click();

  const sendAcknowledged = await waitFor(
    () => !document.contains(readyButton) || isButtonDisabled(readyButton),
    { timeout: 5000, interval: 150 }
  );

  if (!sendAcknowledged) {
    throw new Error("Send reply button did not activate");
  }

  await delay(AUTO_REPLY_DELAY_AFTER_SEND);

  const composerClosed = await waitFor(() => !document.contains(composer), {
    timeout: 8000,
    interval: 200,
  });

  if (!composerClosed) {
    throw new Error("Reply composer stayed open after send");
  }

  await focusNextTargetAfterReply(article);
  return true;
}

async function processAutoReplyQueue() {
  if (!isExtensionEnabled()) {
    clearAutoReplyQueue("skipped");
    return;
  }
  if (autoReplyActive) return;
  if (!autoReplyQueue.length) return;
  autoReplyActive = true;

  try {
    while (autoReplyQueue.length) {
      const task = autoReplyQueue.shift();
      const tweetKey = task.tweetKey || getArticleKey(task.article, task.username);
      let article = task.article;
      if (!article || !document.contains(article)) {
        article = findArticleByKey(tweetKey, task.username);
      }

      if (!currentSettings.autoReplyEnabled) {
        markTweetState(tweetKey, "skipped");
        if (article) {
          autoReplyStates.set(article, { status: "skipped", username: task.username, tweetKey });
          article.dataset.gomtuEligible = "false";
        }
        continue;
      }
      if (!shouldAutoReply(task.data, currentSettings)) {
        markTweetState(tweetKey, "skipped");
        if (article) {
          autoReplyStates.set(article, { status: "skipped", username: task.username, tweetKey });
          article.dataset.gomtuEligible = "false";
        }
        continue;
      }
      if (!article) {
        markTweetState(tweetKey, "failed");
        continue;
      }

      markTweetState(tweetKey, "in-progress");
      autoReplyStates.set(article, { status: "in-progress", username: task.username, tweetKey });

      try {
        const visible = await ensureArticleVisible(article);
        if (!visible) {
          throw new Error("Target tweet not visible for auto reply");
        }
        const success = await performAutoReply({ article, username: task.username, tweetKey });
        markTweetState(tweetKey, success ? "completed" : "failed");
        if (success) {
          article.dataset.gomtuEligible = "false";
          article.dataset.gomtuProcessed = "true";
        }
        autoReplyStates.set(article, {
          status: success ? "completed" : "failed",
          username: task.username,
          tweetKey,
        });
      } catch (err) {
        console.warn("Auto reply failed:", err);
        markTweetState(tweetKey, "failed");
        autoReplyStates.set(article, { status: "failed", username: task.username, tweetKey });
      }

      await delay(AUTO_REPLY_GAP);
    }
  } finally {
    autoReplyActive = false;
  }
}

function enqueueAutoReply(article, username, data, settings) {
  if (!article) return;
  const controls = settings || currentSettings;
  if (controls.extensionEnabled === false) return;
  const tweetKey = getArticleKey(article, username);
  if (!tweetKey) return;

  const eligible = shouldAutoReply(data, controls);
  if (!eligible) {
    article.dataset.gomtuEligible = "false";
    return;
  }

  const existingState = processedTweetStates.get(tweetKey);
  if (existingState && ["queued", "in-progress", "completed"].includes(existingState)) {
    if (existingState === "completed") {
      article.dataset.gomtuEligible = "false";
      article.dataset.gomtuProcessed = "true";
    } else {
      article.dataset.gomtuEligible = "true";
    }
    autoReplyStates.set(article, { status: existingState, username, tweetKey });
    return;
  }

  article.dataset.gomtuEligible = "true";
  markTweetState(tweetKey, "queued");
  autoReplyStates.set(article, { status: "queued", username, tweetKey });
  autoReplyQueue.push({ article, username, data, tweetKey });
  processAutoReplyQueue();
}

function getAutoScrollDelayMs() {
  const value = Number(currentSettings.autoScrollDelayMs);
  if (!Number.isFinite(value)) return AUTO_SCROLL_DEFAULT_DELAY_MS;
  if (value < AUTO_SCROLL_MIN_DELAY_MS) return AUTO_SCROLL_MIN_DELAY_MS;
  if (value > AUTO_SCROLL_MAX_DELAY_MS) return AUTO_SCROLL_MAX_DELAY_MS;
  return value;
}

function stopAutoScroll() {
  if (autoScrollTimer !== null) {
    clearTimeout(autoScrollTimer);
    autoScrollTimer = null;
  }
}

function scheduleAutoScroll(useInitialDelay = false) {
  stopAutoScroll();
  if (!currentSettings.autoScrollEnabled || !isExtensionEnabled()) return;
  const delay = useInitialDelay ? AUTO_SCROLL_INITIAL_DELAY_MS : getAutoScrollDelayMs();
  autoScrollTimer = setTimeout(() => {
    autoScrollStep().catch((err) => {
      console.warn("Auto scroll step failed:", err);
    });
  }, delay);
}

function startAutoScroll() {
  if (!currentSettings.autoScrollEnabled || !isExtensionEnabled()) {
    stopAutoScroll();
    return;
  }
  scheduleAutoScroll(true);
}

function isElementMostlyInView(el) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.height === 0) return false;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  if (viewportHeight === 0) return false;
  const visibleTop = Math.max(rect.top, 0);
  const visibleBottom = Math.min(rect.bottom, viewportHeight);
  const visibleHeight = Math.max(visibleBottom - visibleTop, 0);
  const required = Math.min(rect.height * 0.75, viewportHeight * 0.5);
  return visibleHeight >= required;
}

function findNextTargetArticle(currentArticle = null) {
  const allTargets = Array.from(
    document.querySelectorAll('[role="article"][data-gomtu-eligible="true"]')
  );
  if (!allTargets.length) return null;

  const pending = allTargets.filter((article) => {
    const state = autoReplyStates.get(article);
    const tweetKey = article.dataset?.gomtuTweetKey;
    const processedState = tweetKey ? processedTweetStates.get(tweetKey) : null;

    if (processedState === "completed" || processedState === "in-progress") {
      article.dataset.gomtuEligible = "false";
      return false;
    }

    if (state && state.status === "in-progress") return false;
    return !state || state.status === "queued" || state.status === "failed";
  });

  if (!pending.length) return null;

  if (currentArticle && pending.includes(currentArticle)) {
    return currentArticle;
  }

  const viewportCenter =
    (window.innerHeight || document.documentElement.clientHeight || 0) / 2;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  pending.forEach((article) => {
    const rect = article.getBoundingClientRect();
    if (!rect) return;
    const center = rect.top + rect.height / 2;
    const distance = Math.abs(center - viewportCenter);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = article;
    }
  });

  return best || pending[0] || null;
}

async function ensureArticleVisible(article) {
  if (!article) return false;
  if (!article.isConnected) return false;
  article.scrollIntoView({ behavior: "smooth", block: "center" });
  const result = await waitFor(
    () => {
      if (!article.isConnected) return null;
      return isElementMostlyInView(article) ? article : null;
    },
    { timeout: 6000, interval: 120 }
  );
  return Boolean(result);
}

async function bringNextTargetIntoView(currentArticle = null, { maxAttempts = 5 } = {}) {
  if (!currentSettings.autoScrollEnabled || !isExtensionEnabled()) return false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const nextTarget = findNextTargetArticle(currentArticle);
    if (nextTarget) {
      const visible = await ensureArticleVisible(nextTarget);
      if (visible) return true;
    }

    window.scrollBy({
      top: window.innerHeight * AUTO_SCROLL_STEP_RATIO,
      left: 0,
      behavior: "smooth",
    });

    await delay(300 + attempt * 150);
    currentArticle = null;
  }

  return false;
}

async function focusNextTargetAfterReply(_currentArticle) {
  if (!currentSettings.autoScrollEnabled || !isExtensionEnabled()) return;
  scheduleAutoScroll();
}

async function autoScrollStep() {
  if (!currentSettings.autoScrollEnabled || !isExtensionEnabled()) {
    stopAutoScroll();
    return;
  }

  if (autoReplyActive) {
    scheduleAutoScroll();
    return;
  }

  const hasVisibleTarget = await bringNextTargetIntoView(null, { maxAttempts: 4 });
  if (!hasVisibleTarget) {
    window.scrollBy({
      top: window.innerHeight * AUTO_SCROLL_STEP_RATIO,
      left: 0,
      behavior: "smooth",
    });
  }

  scheduleAutoScroll();
}

function createBadge(label, value, variant = "primary") {
  const badge = document.createElement("span");
  badge.className = `gomtu-badge gomtu-badge--${variant}`;

  const labelEl = document.createElement("span");
  labelEl.className = "gomtu-badge-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "gomtu-badge-value";
  valueEl.textContent = formatValue(value);

  badge.title = `${label}: ${formatTooltipValue(value)}`;
  badge.append(labelEl, valueEl);
  return badge;
}

function placeAfter(parent, node, reference) {
  if (!parent || !node) return;
  if (!reference || reference.parentElement !== parent) {
    parent.appendChild(node);
    return;
  }
  const next = reference.nextSibling;
  if (next === node) return;
  parent.insertBefore(node, next);
}

function ensureBadgeRow(parent, className) {
  const selector = className
    .split(" ")
    .filter(Boolean)
    .map((cls) => `.${cls}`)
    .join("");
  let row = parent.querySelector(selector);
  if (!row) {
    row = document.createElement("div");
    row.className = className;
  }
  return row;
}

function createFallbackAvatar(name = "") {
  const el = document.createElement("div");
  el.className = "gomtu-leaderboard-card-avatar";
  const initial = (name || "?").trim().charAt(0).toUpperCase() || "?";
  el.textContent = initial;
  return el;
}

function createLeaderboardCard(entry) {
  const topic = entry.topic || {};
  const card = document.createElement("div");
  card.className = "gomtu-leaderboard-card";

  let avatar;
  if (topic.imgUrl) {
    avatar = document.createElement("img");
    avatar.className = "gomtu-leaderboard-card-avatar";
    avatar.src = topic.imgUrl;
    avatar.alt = topic.name || topic.ticker || "Project";
  } else {
    avatar = createFallbackAvatar(topic.name || topic.ticker || "");
  }

  const textWrap = document.createElement("div");
  textWrap.className = "gomtu-leaderboard-card-text";

  const nameEl = document.createElement("div");
  nameEl.className = "gomtu-leaderboard-card-name";
  nameEl.textContent = topic.name || topic.ticker || `ID ${entry.topic_id}`;

  const duration = (entry.duration || "").toString().toUpperCase();
  const rankText = Number.isFinite(entry.rank) ? `#${entry.rank}` : "#?";
  const detailEl = document.createElement("div");
  detailEl.className = "gomtu-leaderboard-card-detail";
  detailEl.textContent = duration ? `${duration} · ${rankText}` : rankText;

  textWrap.append(nameEl, detailEl);
  card.append(avatar, textWrap);

  const tooltipBits = [];
  if (topic.ticker) tooltipBits.push(`Ticker: ${topic.ticker}`);
  if (entry.mindshare != null) tooltipBits.push(`Mindshare: ${formatTooltipValue(entry.mindshare)}`);
  if (entry.tier) tooltipBits.push(`Tier: ${entry.tier}`);
  card.title = tooltipBits.join("\n");

  return card;
}

function applyLeaderboardVisibility(container, expanded, limit) {
  const cards = container.querySelectorAll(".gomtu-leaderboard-card");
  cards.forEach((card, idx) => {
    const hide = idx >= limit && !expanded;
    card.classList.toggle("gomtu-leaderboard-card--hidden", hide);
  });
}

function getDurationPriority(durationRaw) {
  const duration = (durationRaw || "").toString().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(LEADERBOARD_PRIORITY_MAP, duration)) {
    return LEADERBOARD_PRIORITY_MAP[duration];
  }
  return LEADERBOARD_DURATION_PRIORITY.length;
}

if (chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    let relevant = false;
    const changedKeys = [];
    Object.keys(DEFAULT_SETTINGS).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(changes, key)) {
        currentSettings[key] = resolveSettingValue(key, changes[key].newValue);
        relevant = true;
        changedKeys.push(key);
      }
    });
    if (relevant) {
      settingsReady = true;
      settingsPromise = Promise.resolve(currentSettings);
      updateDerivedSettings(currentSettings);
      processTweets();
      handleAutomationSettingsChange(changedKeys);
    }
  });
}

async function getScore(username) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_SCORE", username }, (resp) => {
      if (resp?.ok) resolve(resp.data);
      else resolve(null);
    });
  });
}

async function insertBadge(el, username) {
  if (!el) return;
  const nameBlock = el.querySelector('[data-testid="User-Name"]');
  if (!nameBlock) return;
  const parent = nameBlock.parentElement;
  if (!parent) return;

  const [settings, data] = await Promise.all([getSettings(), getScore(username)]);
  if (!data) return;
  if (settings.extensionEnabled === false) return;

  let lastRow = nameBlock;

  const statusData = data.status;
  const existingStatusRow = parent.querySelector(".gomtu-badge-row--status");

  if (settings.showStatus && statusData) {
    const statusRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--status");
    placeAfter(parent, statusRow, lastRow);
    statusRow.textContent = "";

    const statusMetrics = [
      { label: "Smart Followers", value: statusData.smart_follower_count },
      { label: "Followers", value: statusData.follower_count },
    ];

    statusMetrics.forEach(({ label, value }) => {
      if (typeof value === "number") {
        statusRow.appendChild(createBadge(label, value, "secondary"));
      }
    });

    lastRow = statusRow;
  } else if (existingStatusRow) {
    existingStatusRow.remove();
  }

  const yapsData = data.yaps;
  const existingYapsRow = parent.querySelector(".gomtu-badge-row--yaps");
  let yapsRow = null;

  if (settings.showYaps && yapsData) {
    yapsRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--yaps");
    placeAfter(parent, yapsRow, lastRow);
    yapsRow.textContent = "";

    const metrics = [
      { label: "24h", value: yapsData.yaps_l24h },
      { label: "48h", value: yapsData.yaps_l48h },
      { label: "7d", value: yapsData.yaps_l7d },
      { label: "30d", value: yapsData.yaps_l30d },
    ];

    metrics.forEach(({ label, value }) => {
      if (typeof value === "number") {
        yapsRow.appendChild(createBadge(label, value, "primary"));
      }
    });

    lastRow = yapsRow;
  } else if (existingYapsRow) {
    existingYapsRow.remove();
  }

  const leaderboardEntries = Array.isArray(data.leaderboard) ? data.leaderboard : [];
  const existingLeaderboardRow = parent.querySelector(".gomtu-badge-row--leaderboard");

  if (settings.showLeaderboard && leaderboardEntries.length) {
    const leaderboardRow = ensureBadgeRow(parent, "gomtu-badge-row gomtu-badge-row--leaderboard");
    const wasExpanded = leaderboardRow.dataset.expanded === "true";
    placeAfter(parent, leaderboardRow, lastRow);
    leaderboardRow.textContent = "";

    const cardsWrapper = document.createElement("div");
    cardsWrapper.className = "gomtu-leaderboard-cards";
    leaderboardRow.appendChild(cardsWrapper);

    const bestByTopic = new Map();
    leaderboardEntries.forEach((entry) => {
      if (!entry) return;
      const topicKey = (entry.topic?.ticker || entry.topic_id || "").toString().toUpperCase();
      if (!topicKey) return;
      const priority = getDurationPriority(entry.duration);
      const current = bestByTopic.get(topicKey);
      if (
        !current ||
        priority < current.priority ||
        (priority === current.priority && (entry.updatedAt || 0) > (current.entry.updatedAt || 0))
      ) {
        bestByTopic.set(topicKey, { entry, priority });
      }
    });

    const sortedEntries = Array.from(bestByTopic.values())
      .map((item) => item.entry)
      .sort((a, b) => {
        const rankA = Number.isFinite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
        const rankB = Number.isFinite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
        if (rankA !== rankB) return rankA - rankB;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });

    const total = sortedEntries.length;
    const limit = MAX_LEADERBOARD_VISIBLE;

    if (total) {
      sortedEntries.forEach((entry) => {
        cardsWrapper.appendChild(createLeaderboardCard(entry));
      });

      if (total > limit) {
        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "gomtu-leaderboard-toggle";

        const updateState = (expanded) => {
          leaderboardRow.dataset.expanded = expanded ? "true" : "false";
          applyLeaderboardVisibility(cardsWrapper, expanded, limit);
          const remaining = Math.max(total - limit, 0);
          toggleBtn.textContent = expanded ? "Show less" : `Show ${remaining} more`;
        };

        updateState(wasExpanded);
        toggleBtn.addEventListener("click", () => {
          const expanded = leaderboardRow.dataset.expanded === "true";
          updateState(!expanded);
        });

        leaderboardRow.appendChild(toggleBtn);
      } else {
        leaderboardRow.dataset.expanded = "true";
        applyLeaderboardVisibility(cardsWrapper, true, limit);
      }

      lastRow = leaderboardRow;
    } else {
      leaderboardRow.remove();
    }
  } else if (existingLeaderboardRow) {
    existingLeaderboardRow.remove();
  }

  const article = el.closest('[role="article"]');
  if (article) enqueueAutoReply(article, username, data, settings);
}

function findUsernameFromEl(el) {
  // Coba ambil href / text @username
  const a = el.querySelector('a[href^="/"]');
  if (a) {
    const href = a.getAttribute("href");
    if (href && href !== "/" && href.length > 2) {
      return href.replace("/", "").replace("@", "").split("/")[0];
    }
  }
  const txt = el.innerText || "";
  const match = txt.match(/@([a-zA-Z0-9_]+)/);
  return match ? match[1] : null;
}

function processTweets(root = document) {
  if (!isExtensionEnabled()) return;
  const tweets = root.querySelectorAll('[data-testid="User-Name"], [role="article"]');
  tweets.forEach((tweet) => {
    const username = findUsernameFromEl(tweet);
    if (username) insertBadge(tweet, username);
  });
}

// Observe halaman biar auto-update pas scroll
const observer = new MutationObserver((muts) => {
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) processTweets(node);
    }
  }
});

observer.observe(document, { childList: true, subtree: true });
processTweets();
settingsPromise.then(() => {
  if (currentSettings.autoScrollEnabled && isExtensionEnabled()) {
    startAutoScroll();
  }
});

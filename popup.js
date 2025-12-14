const DEFAULT_SETTINGS = {
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
  grokProxyUrl: "",
};

const AUTO_SCROLL_DELAY_MIN = 500;
const AUTO_SCROLL_DELAY_MAX = 60000;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const POPUP_DEFAULT_TAB = "projects";
const KAITO_LEADERBOARD_ENDPOINT = "https://gomtu.xyz/api/kaito/leaderboard";
const {
  GROK_MESSAGE_TYPE,
  GROK_OPEN_WITH_PROMPT,
  buildGrokPromptFromProject,
  requestGrokTweet,
  copyGrokPrompt,
  openGrokWithPrompt,
  openTweetIntent,
} = window.Grok || {};

function generateProjectId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `project-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function getTodayKey() {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

function parseDateKey(key) {
  if (!DATE_KEY_PATTERN.test(key)) return null;
  const [y, m, d] = key.split("-").map((part) => Number(part));
  if (!y || !m || !d) return null;
  return { y, m, d };
}

function dateKeyToUtcTime(key) {
  const parts = parseDateKey(key);
  if (!parts) return null;
  return Date.UTC(parts.y, parts.m - 1, parts.d);
}

function diffDateKeys(a, b) {
  const ta = dateKeyToUtcTime(a);
  const tb = dateKeyToUtcTime(b);
  if (ta == null || tb == null) return null;
  const diff = ta - tb;
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

function sanitizeProjectEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return null;
  const account = typeof entry.account === "string" ? entry.account.trim() : "";
  const iconUrl = typeof entry.iconUrl === "string" ? entry.iconUrl.trim() : "";
  const keyword = typeof entry.keyword === "string" ? entry.keyword.trim() : "";
  const streakCount =
    typeof entry.streakCount === "number" && Number.isFinite(entry.streakCount) && entry.streakCount > 0
      ? Math.floor(entry.streakCount)
      : 0;
  const lastCheckedDate =
    typeof entry.lastCheckedDate === "string" && DATE_KEY_PATTERN.test(entry.lastCheckedDate)
      ? entry.lastCheckedDate
      : null;
  const normalizedStreak = streakCount || (lastCheckedDate ? 1 : 0);

  return {
    id: typeof entry.id === "string" && entry.id.trim() ? entry.id : generateProjectId(),
    name,
    account,
    iconUrl,
    keyword,
    streakCount: normalizedStreak,
    lastCheckedDate,
  };
}

function sanitizeProjectYappingList(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return rawValue
    .map((entry) => sanitizeProjectEntry(entry))
    .filter((entry) => Boolean(entry));
}

function normalizeAccountUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@/, "");
  if (!handle) return "";
  return `https://x.com/${handle}`;
}

function extractHandle(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  const urlMatch = trimmed.match(/(?:x\.com|twitter\.com)\/([^/]+)/i);
  if (urlMatch && urlMatch[1]) return urlMatch[1].replace(/^@/, "");
  return trimmed.replace(/^@/, "");
}

function buildSearchUrl(keyword) {
  if (!keyword) return "";
  const encoded = encodeURIComponent(keyword);
  return `https://x.com/search?q=${encoded}&src=typed_query&f=live`;
}

function openExternalUrl(url) {
  if (!url) return;
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function formatStreakText(count) {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return "Streak: 0";
  return `Streak: ${value} hari`;
}

function createProjectAvatar(project) {
  const wrapper = document.createElement("div");
  wrapper.className = "yapping-project__avatar";

  const iconUrl = typeof project.iconUrl === "string" ? project.iconUrl.trim() : "";
  const fallbackText = (project.name || "P")[0]?.toUpperCase() || "P";

  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      wrapper.textContent = fallbackText;
      wrapper.classList.add("yapping-project__avatar--fallback");
      img.remove();
    });
    wrapper.appendChild(img);
  } else {
    wrapper.textContent = fallbackText;
    wrapper.classList.add("yapping-project__avatar--fallback");
  }

  return wrapper;
}

function createProjectAvatarFromCatalog(entry) {
  const wrapper = document.createElement("div");
  wrapper.className = "yapping-project__avatar catalog-item__avatar";

  const iconUrl = typeof entry?.imgUrl === "string" ? entry.imgUrl.trim() : "";
  const fallbackText = (entry?.name || entry?.ticker || "P")[0]?.toUpperCase() || "P";

  if (iconUrl) {
    const img = document.createElement("img");
    img.src = iconUrl;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      wrapper.textContent = fallbackText;
      wrapper.classList.add("yapping-project__avatar--fallback");
      img.remove();
    });
    wrapper.appendChild(img);
  } else {
    wrapper.textContent = fallbackText;
    wrapper.classList.add("yapping-project__avatar--fallback");
  }

  return wrapper;
}

function renderStreakBarChart(container, items) {
  container.innerHTML = "";
  if (!Array.isArray(items) || !items.length) {
    const empty = document.createElement("p");
    empty.className = "stats__hint";
    empty.textContent = "Belum ada streak.";
    container.appendChild(empty);
    return;
  }
  const max = Math.max(...items.map((item) => item.streak), 1);
  items.slice(0, 6).forEach((item) => {
    const row = document.createElement("div");
    row.className = "stats-chart__row";

    const label = document.createElement("span");
    label.className = "stats-chart__label";
    label.textContent = item.name;

    const barWrap = document.createElement("div");
    barWrap.className = "stats-chart__bar-wrap";

    const bar = document.createElement("div");
    bar.className = "stats-chart__bar";
    const width = Math.max(6, Math.round((item.streak / max) * 100));
    bar.style.width = `${width}%`;
    bar.textContent = `${item.streak}h`;

    barWrap.appendChild(bar);
    row.append(label, barWrap);
    container.appendChild(row);
  });
}

async function fetchCatalogDirect() {
  const res = await fetch(KAITO_LEADERBOARD_ENDPOINT, { method: "GET" });
  if (!res.ok) {
    throw new Error(`Gagal memuat catalog langsung (HTTP ${res.status})`);
  }
  const payload = await res.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function fetchGomtuAvatar(handle) {
  const username = extractHandle(handle);
  if (!username) throw new Error("Handle kosong.");
  const res = await fetch(`https://gomtu.xyz/api/yap/open?username=${encodeURIComponent(username)}`, {
    method: "GET",
  });
  if (!res.ok) throw new Error(`Gagal ambil icon (HTTP ${res.status})`);
  const payload = await res.json();
  const avatar = extractAvatarFromPayload(payload);
  if (!avatar) throw new Error("Icon tidak ditemukan di Gomtu.");
  return avatar;
}

function extractAvatarFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const candidates = [
    payload?.data?.avatar,
    payload?.data?.image,
    payload?.data?.image_url,
    payload?.data?.profile_image_url,
    payload?.avatar,
    payload?.image,
    payload?.image_url,
    payload?.profile_image_url,
  ];
  return candidates.find((val) => typeof val === "string" && val.trim())?.trim() || "";
}

function sendCatalogRequest(forceRefresh = false) {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error("Runtime messaging tidak tersedia"));
      return;
    }
    chrome.runtime.sendMessage(
      { type: "FETCH_LEADERBOARD_CATALOG", forceRefresh },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("Tidak ada respons catalog"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || "Gagal memuat catalog"));
          return;
        }
        resolve(Array.isArray(response.data) ? response.data : []);
      },
    );
  });
}

async function requestLeaderboardCatalog(forceRefresh = false) {
  if (!chrome?.runtime?.sendMessage) {
    return fetchCatalogDirect();
  }

  try {
    return await sendCatalogRequest(forceRefresh);
  } catch (error) {
    const fallbackErrors = ["message port closed", "receiving end does not exist"];
    const message = String(error?.message || "").toLowerCase();
    const shouldFallback = fallbackErrors.some((text) => message.includes(text));
    if (!shouldFallback) throw error;
    console.warn("Catalog via background gagal, fallback fetch langsung:", error);
    return fetchCatalogDirect();
  }
}

function sanitizeNumberSetting(key, value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_SETTINGS[key];
  if (key === "autoScrollDelayMs") {
    const clamped = Math.min(Math.max(num, AUTO_SCROLL_DELAY_MIN), AUTO_SCROLL_DELAY_MAX);
    const rounded = Math.round(clamped / 100) * 100;
    return Math.min(Math.max(rounded, AUTO_SCROLL_DELAY_MIN), AUTO_SCROLL_DELAY_MAX);
  }
  if (key === "minSmartFollowers" || key === "minTotalYaps") {
    return Math.max(Math.floor(num), 0);
  }
  return num;
}

function sanitizeStringSetting(key, value) {
  if (typeof value !== "string") return DEFAULT_SETTINGS[key];
  const trimmed = value.trim();
  return trimmed.length ? trimmed : "";
}

function resolveSettingValue(key, rawValue) {
  switch (key) {
    case "extensionEnabled":
    case "showStatus":
    case "showYaps":
    case "showLeaderboard":
    case "autoReplyEnabled":
    case "autoScrollEnabled":
      return rawValue === undefined ? DEFAULT_SETTINGS[key] : Boolean(rawValue);
    case "autoScrollDelayMs":
      return sanitizeNumberSetting(key, rawValue);
    case "minSmartFollowers":
    case "minTotalYaps":
      return sanitizeNumberSetting(key, rawValue);
    case "leaderboardProjectFilter":
    case "grokProxyUrl":
      return sanitizeStringSetting(key, rawValue);
    case "projectYappingList":
      return sanitizeProjectYappingList(rawValue);
    default:
      return rawValue === undefined ? DEFAULT_SETTINGS[key] : rawValue;
  }
}

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(DEFAULT_SETTINGS, (items) => {
      if (chrome.runtime.lastError) {
        console.error("Unable to read settings:", chrome.runtime.lastError);
      }
      const merged = { ...DEFAULT_SETTINGS };
      Object.keys(DEFAULT_SETTINGS).forEach((key) => {
        merged[key] = resolveSettingValue(key, items[key]);
      });
      resolve(merged);
    });
  });
}

function saveSetting(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error("Unable to save setting:", chrome.runtime.lastError);
      }
      resolve();
    });
  });
}

function initPopupTabs(defaultTab = POPUP_DEFAULT_TAB) {
  const sidePanelBtn = document.getElementById("open-sidepanel");
  if (sidePanelBtn) {
    sidePanelBtn.addEventListener("click", () => {
      openSidePanel();
    });
  }

  const tabButtons = Array.from(document.querySelectorAll("[data-tab-target]"));
  if (!tabButtons.length) return;

  const panels = new Map();
  tabButtons.forEach((button) => {
    const target = button.dataset.tabTarget;
    if (!target) return;
    const panel = document.querySelector(`[data-tab-panel='${target}']`);
    if (panel) panels.set(target, panel);
  });

  if (!panels.size) return;

  const initialTab = panels.has(defaultTab) ? defaultTab : tabButtons[0]?.dataset.tabTarget;
  if (!initialTab) return;

  function activateTab(tabName) {
    if (!panels.has(tabName)) return;
    tabButtons.forEach((button) => {
      const target = button.dataset.tabTarget;
      const isActive = target === tabName;
      button.classList.toggle("tabs__button--active", isActive);
      if (button.hasAttribute("aria-selected")) {
        button.setAttribute("aria-selected", String(isActive));
      }
    });

    panels.forEach((panel, key) => {
      const isActive = key === tabName;
      panel.classList.toggle("tab-panel--active", isActive);
      panel.setAttribute("aria-hidden", String(!isActive));
    });
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const target = button.dataset.tabTarget;
      if (target) activateTab(target);
    });
  });

  activateTab(initialTab);
}

function openSidePanel() {
  const panel = chrome?.sidePanel;
  if (!panel?.open || !panel?.setOptions) {
    fallbackOpenPopupTab();
    return;
  }
  const url = chrome?.runtime?.getURL ? chrome.runtime.getURL("popup.html") : "popup.html";
  panel
    .setOptions({ windowId: chrome.windows.WINDOW_ID_CURRENT, path: url, enabled: true })
    .then(() => panel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }))
    .catch((err) => {
      console.warn("Failed to open side panel:", err);
      fallbackOpenPopupTab();
    });
}

function fallbackOpenPopupTab() {
  const url = chrome?.runtime?.getURL ? chrome.runtime.getURL("popup.html") : "popup.html";
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initPopupTabs();

  const settings = await loadSettings();
  const form = document.getElementById("settings-form");
  const inputs = form ? Array.from(form.querySelectorAll("input[name]")) : [];
  const globalToggle = document.getElementById("extension-enabled-toggle");
  const globalToggleLabel = document.getElementById("extension-enabled-label");

  const updateGlobalToggle = (value) => {
    if (!globalToggle) return;
    const checked = Boolean(value);
    globalToggle.checked = checked;
    if (globalToggleLabel) {
      globalToggleLabel.textContent = checked ? "Extension On" : "Extension Off";
    }
  };

  inputs.forEach((input) => {
    const key = input.name;
    if (!Object.prototype.hasOwnProperty.call(settings, key)) return;
    if (input.type === "checkbox") {
      input.checked = Boolean(settings[key]);
    } else if (input.type === "number") {
      input.value = sanitizeNumberSetting(key, settings[key]);
    } else if (input.type === "text") {
      input.value = sanitizeStringSetting(key, settings[key]);
    }
  });

  updateGlobalToggle(settings.extensionEnabled);
  globalToggle?.addEventListener("change", () => {
    const value = Boolean(globalToggle.checked);
    updateGlobalToggle(value);
    saveSetting("extensionEnabled", value);
  });

  form?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const key = target.name;
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return;

    if (target.type === "checkbox") {
      saveSetting(key, target.checked);
    } else if (target.type === "number") {
      const value = sanitizeNumberSetting(key, target.value);
      target.value = value;
      saveSetting(key, value);
    } else if (target.type === "text") {
      const value = sanitizeStringSetting(key, target.value);
      target.value = value;
      saveSetting(key, value);
    }
  });

  initProjectYapping(settings.projectYappingList);
});

function initProjectYapping(initialProjects) {
  const listContainer = document.getElementById("project-yapping-list");
  const searchInput = document.getElementById("project-search");
  const openDialogBtn = document.getElementById("open-project-dialog");
  const dialog = document.getElementById("project-dialog");
  const manualForm = document.getElementById("project-manual-form");
  const nameInput = document.getElementById("project-name-input");
  const accountInput = document.getElementById("project-account-input");
  const iconInput = document.getElementById("project-icon-input");
  const iconFetchBtn = document.getElementById("project-icon-fetch");
  const keywordInput = document.getElementById("project-keyword-input");
  const formHint = document.getElementById("project-form-hint");
  const catalogList = document.getElementById("catalog-list");
  const catalogStatus = document.getElementById("catalog-status");
  const catalogSearch = document.getElementById("catalog-search");
  const refreshCatalogBtn = document.getElementById("refresh-catalog");
  const dialogBody = dialog?.querySelector(".project-dialog__body");
  const dialogCloseButtons = dialog ? Array.from(dialog.querySelectorAll("[data-dialog-close]")) : [];
  const stats = {
    totalProjects: document.getElementById("stats-total-projects"),
    checkedToday: document.getElementById("stats-checked-today"),
    totalStreak: document.getElementById("stats-total-streak"),
    longestStreak: document.getElementById("stats-longest-streak"),
    longestProject: document.getElementById("stats-longest-project"),
    topList: document.getElementById("stats-top-streak-list"),
    barChart: document.getElementById("stats-bar-chart"),
  };

  if (
    !listContainer ||
    !openDialogBtn ||
    !dialog ||
    !manualForm ||
    !nameInput ||
    !accountInput ||
    !keywordInput
  ) {
    return;
  }

  let projects = sanitizeProjectYappingList(initialProjects);
  let catalogEntries = [];
  let catalogLoading = false;
  let catalogLoaded = false;
  let catalogLoadingPromise = null;
  let draggingId = null;

  renderProjects();
  updateYappingStats();

  searchInput?.addEventListener("input", () => renderProjects());

  openDialogBtn.addEventListener("click", () => {
    openDialog();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      closeDialog();
    }
  });

  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeDialog();
  });

  dialogCloseButtons.forEach((button) => {
    button.addEventListener("click", () => closeDialog());
  });

  manualForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = sanitizeProjectEntry({
      id: manualForm.dataset.editingId,
      name: nameInput.value,
      account: accountInput.value,
      iconUrl: iconInput?.value,
      keyword: keywordInput.value,
      lastCheckedDate: null,
    });
    if (!entry) {
      setFormHint("Nama project wajib diisi.");
      nameInput.focus();
      return;
    }
    const isEdit = Boolean(manualForm.dataset.editingId);
    if (isEdit) {
      commitProjects(
        projects.map((p) =>
          p.id === entry.id
            ? {
                ...p,
                ...entry,
                lastCheckedDate: p.lastCheckedDate,
                streakCount: p.streakCount,
              }
            : p,
        ),
      );
    } else {
      commitProjects([
        ...projects,
        {
          ...entry,
          lastCheckedDate: null,
        },
      ]);
    }
    closeDialog();
  });

  iconFetchBtn?.addEventListener("click", async () => {
    const nameTerm = nameInput?.value || "";
    const handle = accountInput?.value || "";
    const keyword = keywordInput?.value || "";
    const searchTerm = nameTerm || handle || keyword;
    if (!searchTerm.trim()) {
      setFormHint("Isi nama project dulu (atau akun/keyword) untuk ambil icon.");
      (nameInput || accountInput)?.focus();
      return;
    }
    iconFetchBtn.disabled = true;
    setFormHint("Mencari icon...");
    try {
      const entries = await ensureCatalogLoaded();
      const catalogIcon = findCatalogIconExact(nameTerm, entries) || findCatalogIcon(searchTerm, entries);
      if (catalogIcon) {
        if (iconInput) iconInput.value = catalogIcon;
        setFormHint("Icon terisi dari katalog.");
        return;
      }

      const avatar = await fetchGomtuAvatar(handle || keyword || nameTerm);
      if (iconInput) iconInput.value = avatar;
      setFormHint("Icon terisi dari Gomtu. Simpan project untuk menyimpan.");
    } catch (error) {
      setFormHint(error?.message || "Gagal mengambil icon.");
    } finally {
      iconFetchBtn.disabled = false;
    }
  });

  catalogSearch?.addEventListener("input", () => renderCatalogList());
  refreshCatalogBtn?.addEventListener("click", () => ensureCatalogLoaded(true));

  function openDialog() {
    if (!dialog.open) dialog.showModal();
    manualForm.reset();
    manualForm.dataset.editingId = "";
    setFormHint("");
    nameInput.focus();
    if (iconInput) iconInput.value = "";
    if (dialogBody) dialogBody.scrollTop = 0;
    ensureCatalogLoaded();
  }

  function closeDialog() {
    if (dialog.open) dialog.close();
    manualForm.reset();
    manualForm.dataset.editingId = "";
    setFormHint("");
  }

  function openDialogForEdit(project) {
    if (!project) return;
    openDialog();
    manualForm.dataset.editingId = project.id;
    nameInput.value = project.name || "";
    accountInput.value = project.account || "";
    keywordInput.value = project.keyword || "";
    if (iconInput) iconInput.value = project.iconUrl || "";
    setFormHint("Edit project lalu Simpan.");
  }

  function setFormHint(message = "") {
    if (formHint) {
      formHint.textContent = message;
    }
  }

  function updateCatalogStatus(message = "") {
    if (catalogStatus) {
      catalogStatus.textContent = message;
    }
  }

  function commitProjects(nextProjects) {
    projects = sanitizeProjectYappingList(nextProjects);
    renderProjects();
    saveSetting("projectYappingList", projects);
    updateYappingStats();
  }

  function updateYappingStats() {
    if (!stats || !stats.totalProjects || !stats.checkedToday || !stats.totalStreak || !stats.longestStreak) {
      return;
    }
    const today = getTodayKey();
    let total = projects.length;
    let checkedToday = 0;
    let totalStreak = 0;
    let longestStreak = 0;
    let longestProject = "";
    const streakList = [];

    projects.forEach((entry) => {
      const streak = Math.max(0, Number(entry.streakCount) || 0);
      totalStreak += streak;
      if (entry.lastCheckedDate === today) checkedToday += 1;
      if (streak > longestStreak) {
        longestStreak = streak;
        longestProject = entry.name || "";
      }
      if (streak > 0) streakList.push({ name: entry.name || "Tanpa nama", streak });
    });

    stats.totalProjects.textContent = total;
    stats.checkedToday.textContent = checkedToday;
    stats.totalStreak.textContent = totalStreak;
    stats.longestStreak.textContent = longestStreak;
    if (stats.longestProject) {
      stats.longestProject.textContent = longestProject ? `• ${longestProject}` : "";
    }

    const sorted = streakList.sort((a, b) => b.streak - a.streak);

    if (stats.topList) {
      stats.topList.innerHTML = "";
      sorted.slice(0, 5).forEach((item) => {
        const li = document.createElement("li");
        li.className = "stats__item";
        li.textContent = `${item.name} — ${item.streak} hari`;
        stats.topList.appendChild(li);
      });
    }

    if (stats.barChart) {
      renderStreakBarChart(stats.barChart, sorted);
    }
  }

  function renderProjects() {
    listContainer.innerHTML = "";
    const keyword = (searchInput?.value || "").trim().toLowerCase();
    const visible = !keyword
      ? projects
      : projects.filter((entry) => {
          const name = (entry?.name || "").toLowerCase();
          const ticker = (entry?.keyword || "").toLowerCase();
          return name.includes(keyword) || ticker.includes(keyword);
        });
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "yapping__empty";
      empty.textContent = projects.length ? "Tidak ada project yang cocok." : "Belum ada project. Klik Tambah Project.";
      listContainer.appendChild(empty);
      return;
    }

    visible.forEach((project) => {
      listContainer.appendChild(createProjectCard(project));
    });
  }

  function createProjectCard(project) {
    const item = document.createElement("div");
    item.className = "yapping-project";
    item.dataset.projectId = project.id;
    item.draggable = true;

    item.addEventListener("dragstart", (e) => {
      draggingId = project.id;
      item.classList.add("yapping-project--dragging");
      e.dataTransfer.effectAllowed = "move";
    });

    item.addEventListener("dragend", () => {
      draggingId = null;
      item.classList.remove("yapping-project--dragging");
    });

    item.addEventListener("dragover", (e) => {
      if (!draggingId || draggingId === project.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    item.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggingId || draggingId === project.id) return;
      reorderProjects(draggingId, project.id);
    });

    const header = document.createElement("div");
    header.className = "yapping-project__header";

    const headerMeta = document.createElement("div");
    headerMeta.className = "yapping-project__meta";

    const avatar = createProjectAvatar(project);

    const nameEl = document.createElement("p");
    nameEl.className = "yapping-project__name";
    nameEl.textContent = project.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "yapping-project__remove";
    removeBtn.textContent = "Hapus";
    removeBtn.addEventListener("click", () => {
      commitProjects(projects.filter((entry) => entry.id !== project.id));
    });

    headerMeta.append(avatar, nameEl);

    header.append(headerMeta, removeBtn);

    const checkLabel = document.createElement("label");
    checkLabel.className = "yapping-project__check";
    checkLabel.htmlFor = `${project.id}-checkbox`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = `${project.id}-checkbox`;
    checkbox.className = "yapping-project__checkbox";
    const todayKey = getTodayKey();
    checkbox.checked = project.lastCheckedDate === todayKey;

    const checkText = document.createElement("span");
    checkText.textContent = "Checklist harian";

    const status = document.createElement("span");
    status.className = "yapping-project__status";
    status.textContent = checkbox.checked ? "Sudah yap" : "Belum yap";

    const streak = document.createElement("span");
    streak.className = "yapping-project__streak";
    streak.textContent = formatStreakText(project.streakCount);

    checkbox.addEventListener("change", () => {
      const isChecked = checkbox.checked;
      const todayKey = getTodayKey();
      const diffFromPrev = project.lastCheckedDate ? diffDateKeys(todayKey, project.lastCheckedDate) : null;
      const previousStreak = Math.max(0, Number(project.streakCount) || 0);
      const nextStreak = isChecked
        ? diffFromPrev === 1
          ? previousStreak + 1
          : diffFromPrev === 0
            ? Math.max(previousStreak, 1)
            : 1
        : 0;

      status.textContent = isChecked ? "Sudah yap" : "Belum yap";
      streak.textContent = formatStreakText(nextStreak);

      commitProjects(
        projects.map((entry) =>
          entry.id === project.id
            ? {
                ...entry,
                streakCount: nextStreak,
                lastCheckedDate: isChecked ? todayKey : null,
              }
            : entry,
        ),
      );
    });

    checkLabel.append(checkbox, checkText, status, streak);

    const actions = document.createElement("div");
    actions.className = "yapping-project__actions";

    const accountUrl = normalizeAccountUrl(project.account);
    const accountBtn = document.createElement("button");
    accountBtn.type = "button";
    accountBtn.className = "yapping-project__action";
    accountBtn.textContent = "Akun utama";
    accountBtn.disabled = !accountUrl;
    if (accountUrl) {
      accountBtn.addEventListener("click", () => openExternalUrl(accountUrl));
    } else {
      accountBtn.title = "Isi akun utama untuk mengaktifkan tombol";
    }

    const keyword = project.keyword || project.name;
    const searchUrl = buildSearchUrl(keyword);
    const searchBtn = document.createElement("button");
    searchBtn.type = "button";
    searchBtn.className = "yapping-project__action";
    searchBtn.textContent = "Cari di X";
    searchBtn.disabled = !searchUrl;
    if (searchUrl) {
      searchBtn.addEventListener("click", () => openExternalUrl(searchUrl));
    }

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "yapping-project__action";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => {
      openDialogForEdit(project);
    });

    actions.append(accountBtn, searchBtn, editBtn);

    const automation = document.createElement("div");
    automation.className = "yapping-project__automation";

    const copyPromptBtn = document.createElement("button");
    copyPromptBtn.type = "button";
    copyPromptBtn.className = "yapping-project__action";
    copyPromptBtn.textContent = "Copy Prompt";

    const openGrokBtn = document.createElement("button");
    openGrokBtn.type = "button";
    openGrokBtn.className = "yapping-project__action yapping-project__action--primary";
    openGrokBtn.textContent = "Buka Grok + Isi Prompt";

    const grokOutput = document.createElement("p");
    grokOutput.className = "yapping-project__grok-output";
    grokOutput.textContent = "Belum ada tweet Grok.";

    copyPromptBtn.addEventListener("click", () => {
      copyGrokPrompt(project, grokOutput, copyPromptBtn);
    });

    openGrokBtn.addEventListener("click", () => {
      openGrokWithPrompt(project, grokOutput, openGrokBtn);
    });

    automation.append(openGrokBtn, copyPromptBtn, grokOutput);

    item.append(header, checkLabel, actions, automation);
    return item;
  }

  function reorderProjects(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const current = [...projects];
    const fromIndex = current.findIndex((p) => p.id === sourceId);
    const toIndex = current.findIndex((p) => p.id === targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    const [moved] = current.splice(fromIndex, 1);
    const insertAt = fromIndex < toIndex ? toIndex : toIndex;
    current.splice(insertAt, 0, moved);
    commitProjects(current);
  }

  async function ensureCatalogLoaded(force = false) {
    if (!catalogList && !force) return Promise.resolve(catalogEntries);
    if (catalogLoadingPromise) return catalogLoadingPromise;
    if (!force && catalogLoaded) return Promise.resolve(catalogEntries);
    catalogLoading = true;
    catalogLoadingPromise = (async () => {
      updateCatalogStatus("Memuat catalog...");
      if (catalogList) catalogList.innerHTML = "";
      try {
        catalogEntries = await requestLeaderboardCatalog(force);
        catalogLoaded = true;
        renderCatalogList();
        updateCatalogStatus(
          catalogEntries.length ? "Pilih project untuk mengisi form." : "Catalog kosong untuk sekarang.",
        );
        return catalogEntries;
      } catch (error) {
        updateCatalogStatus(`Gagal memuat catalog: ${error.message}`);
        throw error;
      } finally {
        catalogLoading = false;
        catalogLoadingPromise = null;
      }
    })();
    return catalogLoadingPromise;
  }

  function renderCatalogList() {
    if (!catalogList) return;
    catalogList.innerHTML = "";
    const keyword = (catalogSearch?.value || "").trim().toLowerCase();
    const filtered = !keyword
      ? catalogEntries
      : catalogEntries.filter((entry) => {
          const name = (entry?.name || "").toLowerCase();
          const ticker = (entry?.ticker || "").toLowerCase();
          return name.includes(keyword) || ticker.includes(keyword);
        });

    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "yapping__empty";
      empty.textContent = catalogEntries.length
        ? "Tidak ada hasil untuk kata kunci tersebut."
        : "Catalog belum dimuat.";
      catalogList.appendChild(empty);
      return;
    }

    filtered.slice(0, 60).forEach((entry) => {
      const item = document.createElement("div");
      item.className = "catalog-item";

      const meta = document.createElement("div");
      meta.className = "catalog-item__meta";

      const avatar = createProjectAvatarFromCatalog(entry);
      meta.appendChild(avatar);

      const nameBlock = document.createElement("div");
      nameBlock.className = "catalog-item__text";

      const nameEl = document.createElement("p");
      nameEl.className = "catalog-item__name";
      nameEl.textContent = entry?.name || entry?.ticker || "Tanpa nama";

      const tickerEl = document.createElement("span");
      tickerEl.className = "catalog-item__ticker";
      const ticker = entry?.ticker ? entry.ticker.toUpperCase() : "";
      const category = entry?.category || "";
      tickerEl.textContent = ticker || category ? [ticker, category].filter(Boolean).join(" • ") : "–";

      nameBlock.append(nameEl, tickerEl);

      meta.append(avatar, nameBlock);

      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "catalog-item__use";
      useBtn.textContent = "Gunakan";
      useBtn.addEventListener("click", () => {
        applyCatalogEntry(entry);
      });

      item.append(meta, useBtn);
      catalogList.appendChild(item);
    });
  }

  function applyCatalogEntry(entry) {
    if (!entry) return;
    nameInput.value = entry.name || entry.ticker || "";
    keywordInput.value = entry.ticker || entry.name || "";
    accountInput.value = "";
    if (iconInput) iconInput.value = entry.imgUrl || entry.iconUrl || "";
    setFormHint("Nama & keyword sudah diisi, lengkapi akun sebelum simpan.");
    updateCatalogStatus("Project sudah diisi ke form manual di atas.");
    if (dialogBody) dialogBody.scrollTop = 0;
    nameInput.focus();
  }

  function findCatalogIconExact(term, entries = catalogEntries) {
    if (!term || !entries?.length) return "";
    const q = term.trim().toLowerCase();
    const match = entries.find((entry) => {
      const name = (entry?.name || "").toLowerCase();
      const ticker = (entry?.ticker || "").toLowerCase();
      return q && (name === q || ticker === q);
    });
    return match ? match.imgUrl || match.iconUrl || "" : "";
  }

  function findCatalogIcon(term, entries = catalogEntries) {
    if (!term || !entries?.length) return "";
    const q = term.trim().toLowerCase();
    const match = entries.find((entry) => {
      const name = (entry?.name || "").toLowerCase();
      const ticker = (entry?.ticker || "").toLowerCase();
      return (name && name.includes(q)) || (ticker && ticker.includes(q));
    });
    return match ? match.imgUrl || match.iconUrl || "" : "";
  }
}

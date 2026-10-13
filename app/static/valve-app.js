/**
 * VaporFetch Revival - Valve Steam Client Application Controller
 * Complete implementation of Valve Desktop Client & Steam Deck Panorama UI.
 */

// Application State
const state = {
  activeTab: "library",
  libraryViewMode: "hero", // "hero", "grid", "list"
  libraryFilter: "all",    // "all", "installed", "favorites"
  games: [],
  filteredGames: [],
  selectedGame: null,
  installedGames: [],
  storageInfo: null,
  queue: { items: [], active_id: null },
  activeDownloadItem: null,
  userSession: null,
  batchMode: false,
  batchSelectedAppIds: new Set(),
  favorites: new Set(JSON.parse(localStorage.getItem("vf_favorites") || "[]")),
  speedHistory: [], // [{ net: bps, disk: bps }]
  bigPictureMode: false,
  qrSession: null,
  qrTimer: null,
  sseSource: null,
  currentHeroSubTab: "overview",
  currentNews: [],
  gamePropertiesTargetAppId: null,
};

// ==========================================================================
// INITIALIZATION
// ==========================================================================

document.addEventListener("DOMContentLoaded", async () => {
  setupNavigationTabs();
  setupEventListeners();
  initSpeedCanvas();
  connectTelemetryStream();
  await checkUserSession();
  await loadSettings();
  await refreshStorageInfo();
  await loadInstalledGames();

  if (state.userSession && state.userSession.authenticated) {
    await loadGamesLibrary();
  } else {
    showLoginPrompt();
  }

  checkUpdates(false);
});

// ==========================================================================
// NAVIGATION TABS & VIEW SWITCHING
// ==========================================================================

function setupNavigationTabs() {
  document.querySelectorAll(".nav-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      switchTab(target);
    });
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  valveSound.playSelect();

  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${tabName}`);
  });

  if (tabName === "downloads") {
    renderDownloadsView();
    setTimeout(() => {
      const canvas = document.getElementById("speedCanvas");
      if (canvas && canvas.parentElement) {
        canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
        canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
        drawSpeedGraph();
      }
    }, 50);
  } else if (tabName === "storage") {
    refreshStorageInfo();
    loadInstalledGames();
  } else if (tabName === "community") {
    loadCommunityFeed();
  } else if (tabName === "store") {
    const input = document.getElementById("storeSearchInput");
    if (!input || !input.value.trim()) {
      loadStoreFeatured();
    }
  }
}

function toggleBigPictureMode() {
  state.bigPictureMode = !state.bigPictureMode;
  document.body.classList.toggle("mode-bigpicture", state.bigPictureMode);
  const deckOverlay = document.getElementById("deckOverlay");

  if (state.bigPictureMode) {
    valveSound.playSelect();
    if (deckOverlay) deckOverlay.style.display = "flex";
    updateDeckClock();
    renderBigPictureCarousel();
    setTimeout(() => {
      const firstCard = document.querySelector("#deckHomeCarousel .deck-game-card");
      if (firstCard) firstCard.focus();
    }, 100);
  } else {
    valveSound.playBack();
    if (deckOverlay) deckOverlay.style.display = "none";
  }
}

function updateDeckClock() {
  const clockEl = document.getElementById("deckClock");
  if (clockEl) {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const deckStorage = document.getElementById("deckStorageStatus");
  if (deckStorage && state.storageInfo) {
    const freeGb = (state.storageInfo.free_bytes / (1024 ** 3)).toFixed(1);
    deckStorage.textContent = `NAS: ${freeGb} GB Free`;
  }
}


// ==========================================================================
// USER AUTHENTICATION & STEAM GUARD QR
// ==========================================================================

async function checkUserSession() {
  try {
    const res = await fetch("/api/auth/session");
    const data = await res.json();
    if (data.authenticated && data.session) {
      state.userSession = data.session;
      updateUserUI(data.session);
    } else {
      state.userSession = null;
      updateUserUI(null);
    }
  } catch (e) {
    console.error("Session check error:", e);
  }
}

function updateUserUI(session) {
  const profileArea = document.getElementById("userProfileCapsule");
  const loginBtn = document.getElementById("navLoginBtn");

  if (session && session.authenticated) {
    if (profileArea) profileArea.style.display = "flex";
    if (loginBtn) loginBtn.style.display = "none";

    const nameEl = document.getElementById("profilePersonaName");
    const avatarEl = document.getElementById("profileAvatarImg");
    const levelEl = document.getElementById("profileLevelBadge");
    if (nameEl) nameEl.textContent = session.personaname || session.account_name || "Steam User";
    if (avatarEl) avatarEl.src = session.avatar || "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
    if (levelEl) levelEl.textContent = session.level ? `LVL ${session.level}` : "LVL 1";
  } else {
    if (profileArea) profileArea.style.display = "none";
    if (loginBtn) loginBtn.style.display = "flex";
  }
}

async function openQrLoginModal() {
  valveSound.playModalOpen();
  const modal = document.getElementById("qrLoginModal");
  if (modal) modal.style.display = "flex";
  await startQrAuthSession();
}

function closeQrLoginModal() {
  if (state.qrTimer) clearInterval(state.qrTimer);
  const modal = document.getElementById("qrLoginModal");
  if (modal) modal.style.display = "none";
}

async function startQrAuthSession() {
  const qrImg = document.getElementById("qrCodeImage");
  const statusText = document.getElementById("qrStatusMessage");
  if (statusText) statusText.textContent = "Requesting Steam challenge...";

  try {
    const res = await fetch("/api/auth/qr/begin", { method: "POST" });
    const data = await res.json();
    state.qrSession = data;

    if (qrImg) qrImg.src = data.qr_data_url;
    if (statusText) statusText.textContent = "Scan using the Steam Mobile app";

    if (state.qrTimer) clearInterval(state.qrTimer);
    state.qrTimer = setInterval(pollQrSession, (data.interval || 3) * 1000);
  } catch (e) {
    if (statusText) statusText.textContent = "Failed to start QR session. Check internet connection.";
  }
}

async function pollQrSession() {
  if (!state.qrSession) return;
  try {
    const res = await fetch("/api/auth/qr/poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: state.qrSession.client_id,
        request_id: state.qrSession.request_id,
      }),
    });
    const data = await res.json();

    if (data.status === "confirmed") {
      clearInterval(state.qrTimer);
      valveSound.playComplete();
      showToast("Signed in with Steam Guard!", "success");
      closeQrLoginModal();
      await checkUserSession();
      await loadGamesLibrary();
    }
  } catch (e) {}
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
    state.userSession = null;
    updateUserUI(null);
    state.games = [];
    state.filteredGames = [];
    state.selectedGame = null;
    renderSidebarGames();
    showLoginPrompt();
    showToast("Logged out of Steam.", "info");
  } catch (e) {}
}

function showLoginPrompt() {
  const mainPane = document.getElementById("libraryMainPane");
  if (!mainPane) return;
  mainPane.innerHTML = `
    <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px; text-align: center;">
      <svg class="valve-icon" style="width: 72px; height: 72px; margin-bottom: 20px; color: var(--steam-blue-light);" viewBox="0 0 24 24">
        <path d="M12 2C6.48 2 2 6.48 2 12c0 4.84 3.44 8.87 8 9.8V15.2l-2.4-1.2v-.03c-.34-.17-.6-.46-.73-.83L2.24 11.2C2.08 11.46 2 11.72 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10S17.52 2 12 2zm3.3 14.1c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z" fill="currentColor"/>
      </svg>
      <h2 style="font-size: 26px; font-weight: 800; color: #fff; margin-bottom: 12px;">Steam Sign-in Required</h2>
      <p style="color: var(--steam-text-secondary); max-width: 480px; margin-bottom: 28px; line-height: 1.6;">
        Sign in with your Steam Guard Mobile Authenticator to view your games library and batch-download games directly to your NAS.
      </p>
      <button class="btn-steam-green" onclick="openQrLoginModal()">
        Scan Steam Guard QR Code
      </button>
    </div>
  `;
}

// ==========================================================================
// GAME LIBRARY & HERO VIEW
// ==========================================================================

async function loadGamesLibrary() {
  const sidebarList = document.getElementById("sidebarGameList");
  if (sidebarList) sidebarList.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--steam-text-dim);">Loading Steam library...</div>`;

  try {
    const res = await fetch("/api/games");
    if (res.status === 401 || res.status === 403) {
      showLoginPrompt();
      return;
    }
    const data = await res.json();
    state.games = data.games || [];
    applyLibraryFilters();

    if (state.filteredGames.length > 0 && !state.selectedGame) {
      selectGame(state.filteredGames[0].appid);
    }
  } catch (e) {
    console.error("Library fetch error:", e);
  }
}

function setLibraryFilter(filter, buttonEl) {
  state.libraryFilter = filter;
  valveSound.playSelect();

  document.querySelectorAll(".filter-pill").forEach((btn) => btn.classList.remove("active"));
  if (buttonEl) buttonEl.classList.add("active");

  applyLibraryFilters();
}

function applyLibraryFilters() {
  const searchInput = document.getElementById("librarySearchInput");
  const query = searchInput ? searchInput.value.toLowerCase().trim() : "";

  state.filteredGames = state.games.filter((g) => {
    const matchQuery = !query || g.name.toLowerCase().includes(query) || String(g.appid).includes(query);
    if (!matchQuery) return false;

    if (state.libraryFilter === "installed") {
      return state.installedGames.some((ig) => ig.appid === g.appid);
    } else if (state.libraryFilter === "favorites") {
      return state.favorites.has(g.appid);
    }
    return true;
  });

  renderSidebarGames();

  if (state.libraryViewMode === "grid") {
    renderGridView();
  } else if (state.libraryViewMode === "list") {
    renderListView();
  } else if (state.selectedGame) {
    renderHeroGameView(state.selectedGame);
  }
}

function setLibraryViewMode(mode) {
  state.libraryViewMode = mode;
  valveSound.playSelect();

  document.querySelectorAll(".view-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });

  if (mode === "grid") {
    renderGridView();
  } else if (mode === "list") {
    renderListView();
  } else {
    if (state.selectedGame) {
      renderHeroGameView(state.selectedGame);
    } else if (state.filteredGames.length > 0) {
      selectGame(state.filteredGames[0].appid);
    }
  }
}

function renderSidebarGames() {
  const sidebarList = document.getElementById("sidebarGameList");
  if (!sidebarList) return;

  if (state.filteredGames.length === 0) {
    sidebarList.innerHTML = `<div style="padding: 24px 16px; text-align: center; color: var(--steam-text-dim); font-size: 12px;">No games match filter.</div>`;
    return;
  }

  const installedAppIds = new Set(state.installedGames.map((ig) => ig.appid));
  const activeAppId = state.activeDownloadItem ? state.activeDownloadItem.appid : null;

  let html = `<div class="collection-group">
    <div class="collection-header">
      <span>${state.libraryFilter === "favorites" ? "Favorites" : state.libraryFilter === "installed" ? "Installed on NAS" : "All Games"}</span>
      <span class="collection-count">${state.filteredGames.length}</span>
    </div>`;

  state.filteredGames.forEach((game) => {
    const isSelected = state.selectedGame && state.selectedGame.appid === game.appid;
    const isInstalled = installedAppIds.has(game.appid);
    const isDownloading = activeAppId === game.appid;
    const isChecked = state.batchSelectedAppIds.has(game.appid);

    let statusIcon = "";
    if (isDownloading) {
      statusIcon = `<svg class="item-status-icon status-downloading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    } else if (isInstalled) {
      statusIcon = `<svg class="item-status-icon status-downloaded" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    }

    const fallbackIcon = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%232a475e%22/><text x=%2250%22 y=%2260%22 font-size=%2250%22 text-anchor=%22middle%22 fill=%22white%22>🎮</text></svg>";

    const checkboxHtml = state.batchMode ? `
      <input type="checkbox" class="sidebar-batch-checkbox" ${isChecked ? "checked" : ""} onclick="event.stopPropagation(); toggleBatchSelect(${game.appid});">
    ` : "";

    html += `
      <div class="game-list-item ${isSelected ? "selected" : ""}" onclick="selectGame(${game.appid})" oncontextmenu="openContextMenu(event, ${game.appid})">
        ${checkboxHtml}
        <img class="item-icon" src="${game.icon_url || fallbackIcon}" onerror="this.src='${fallbackIcon}'">
        <span class="item-title">${escapeHtml(game.name)}</span>
        ${statusIcon}
      </div>
    `;
  });

  html += `</div>`;
  sidebarList.innerHTML = html;
}

async function selectGame(appid) {
  const game = state.games.find((g) => g.appid === appid);
  if (!game) return;
  state.selectedGame = game;
  renderSidebarGames();

  if (state.libraryViewMode === "hero") {
    renderHeroGameView(game);
  }
}

async function renderHeroGameView(game) {
  const mainPane = document.getElementById("libraryMainPane");
  if (!mainPane) return;

  const isInstalled = state.installedGames.some((ig) => ig.appid === game.appid);
  const isQueued = state.queue.items.some((qi) => qi.appid === game.appid && (qi.status === "queued" || qi.status === "running"));
  const isDownloading = state.activeDownloadItem && state.activeDownloadItem.appid === game.appid;

  let btnLabel = "Install";
  let btnClass = "btn-steam-green";
  if (isDownloading) {
    btnLabel = `Downloading (${state.activeDownloadItem.progress.toFixed(1)}%)`;
    btnClass = "btn-steam-green downloading";
  } else if (isQueued) {
    btnLabel = "Queued in Batch";
    btnClass = "btn-steam-green";
  } else if (isInstalled) {
    btnLabel = "Installed on NAS";
    btnClass = "btn-steam-green";
  }

  const playtimeHrs = (game.playtime_forever / 60).toFixed(1);

  mainPane.innerHTML = `
    <div class="hero-view-container">
      <div class="hero-banner-backdrop" style="background-image: url('${game.hero_url || game.header_url}')">
        <div class="hero-gradient-overlay"></div>
        <div class="hero-content">
          <div class="hero-title-group">
            <h1 class="hero-game-title">${escapeHtml(game.name)}</h1>
            <div class="hero-stats-row">
              <div class="stat-chip">
                <span class="stat-chip-label">AppID</span>
                <span class="stat-chip-val">${game.appid}</span>
              </div>
              <div class="stat-chip">
                <span class="stat-chip-label">Play Time</span>
                <span class="stat-chip-val">${playtimeHrs} hrs</span>
              </div>
              <div class="stat-chip">
                <span class="stat-chip-label">NAS Status</span>
                <span class="stat-chip-val" style="color: ${isInstalled ? "var(--steam-in-game-green)" : "var(--steam-text-secondary)"}">
                  ${isInstalled ? "Downloaded & Ready" : "Not Downloaded"}
                </span>
              </div>
            </div>
          </div>

          <div class="hero-action-bar">
            <button class="${btnClass}" onclick="handleHeroInstallClick(${game.appid})">
              ${btnLabel}
            </button>
            <button class="btn-steam-action" id="btnGoldbergHero" onclick="toggleGoldbergForGame(${game.appid})" title="DRM-Free Offline Wrapper">
              Goldberg Wrapper
            </button>
            <button class="btn-steam-action" onclick="openGamePropertiesModal(${game.appid})" title="Game Properties">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle;">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div class="hero-tabs-header">
        <button class="hero-sub-tab ${state.currentHeroSubTab === "overview" ? "active" : ""}" onclick="switchHeroSubTab('overview')">Overview</button>
        <button class="hero-sub-tab ${state.currentHeroSubTab === "news" ? "active" : ""}" onclick="switchHeroSubTab('news')">News & Updates</button>
        <button class="hero-sub-tab ${state.currentHeroSubTab === "files" ? "active" : ""}" onclick="switchHeroSubTab('files')">Files on NAS</button>
      </div>

      <div class="hero-tab-content">
        <div class="hero-main-column" id="heroMainContent">
          <div class="steam-panel-box" id="heroStoreDetailsPanel">
            <div class="panel-title">About the Game</div>
            <p id="heroDescription" style="color: var(--steam-text-main); font-size: 13px; line-height: 1.6;">Loading game information from Steam...</p>
          </div>
        </div>

        <div class="hero-sidebar-column">
          <div class="steam-panel-box">
            <div class="panel-title">Metadata</div>
            <div id="heroMetaBox" style="font-size: 12px; color: var(--steam-text-secondary); display: flex; flex-direction: column; gap: 8px;">
              <div><strong>AppID:</strong> ${game.appid}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  fetchGameStoreDetails(game.appid);
  fetchGameNews(game.appid);
  checkGoldbergStatusForHero(game.appid);
}

function switchHeroSubTab(tabName) {
  state.currentHeroSubTab = tabName;
  valveSound.playSelect();

  document.querySelectorAll(".hero-sub-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.textContent.toLowerCase().includes(tabName));
  });

  const mainCol = document.getElementById("heroMainContent");
  if (!mainCol || !state.selectedGame) return;

  if (tabName === "news") {
    if (state.currentNews.length === 0) {
      mainCol.innerHTML = `
        <div class="steam-panel-box">
          <div class="panel-title">Developer News & Updates</div>
          <p style="color: var(--steam-text-secondary); font-size: 13px;">No news items available for this title.</p>
        </div>
      `;
    } else {
      let newsHtml = `
        <div class="steam-panel-box">
          <div class="panel-title">Recent Patch Notes & Announcements</div>
      `;
      state.currentNews.forEach((item) => {
        const dateStr = item.date ? new Date(item.date * 1000).toLocaleDateString() : "--";
        newsHtml += `
          <div class="news-card">
            <a href="${item.url || '#'}" target="_blank" class="news-title">${escapeHtml(item.title)}</a>
            <div class="news-meta">Posted by ${escapeHtml(item.author)} on ${dateStr}</div>
            <div class="news-body">${escapeHtml(item.contents)}</div>
          </div>
        `;
      });
      newsHtml += `</div>`;
      mainCol.innerHTML = newsHtml;
    }
  } else if (tabName === "files") {
    const installed = state.installedGames.find((ig) => ig.appid === state.selectedGame.appid);
    if (installed) {
      const sizeGb = (installed.size_bytes / (1024 ** 3)).toFixed(2);
      mainCol.innerHTML = `
        <div class="steam-panel-box">
          <div class="panel-title">Installed Files on NAS</div>
          <div style="font-size: 13px; color: var(--steam-text-main); display: flex; flex-direction: column; gap: 12px;">
            <div><strong>Location:</strong> <code>${escapeHtml(installed.path)}</code></div>
            <div><strong>Size on Disk:</strong> ${sizeGb} GB</div>
            <div><strong>ACF Manifest:</strong> ${installed.has_manifest ? "Present (Build ID: " + installed.buildid + ")" : "Not detected"}</div>
            <div><strong>Goldberg Emulator:</strong> ${installed.goldberg_patched ? "Applied (DRM-Free)" : "Original Steam DRM"}</div>
            <div style="margin-top: 16px;">
              <button class="menu-button" style="color: var(--steam-red); border: 1px solid var(--steam-red); padding: 8px 16px;" onclick="deleteGameFromNas('${escapeHtml(installed.folder_name)}')">
                Delete Game from NAS
              </button>
            </div>
          </div>
        </div>
      `;
    } else {
      mainCol.innerHTML = `
        <div class="steam-panel-box">
          <div class="panel-title">Files on NAS</div>
          <p style="color: var(--steam-text-secondary); font-size: 13px;">This game is not currently downloaded to your NAS share (/downloads).</p>
        </div>
      `;
    }
  } else {
    // Overview
    renderHeroGameView(state.selectedGame);
  }
}

function renderGridView() {
  const mainPane = document.getElementById("libraryMainPane");
  if (!mainPane) return;

  let html = `<div class="library-grid-view">`;
  state.filteredGames.forEach((game) => {
    const isChecked = state.batchSelectedAppIds.has(game.appid);
    const playtimeHrs = (game.playtime_forever / 60).toFixed(1);
    html += `
      <div class="game-capsule-card" onclick="selectGame(${game.appid}); setLibraryViewMode('hero');">
        <input type="checkbox" class="capsule-checkbox" ${isChecked ? "checked" : ""} onclick="event.stopPropagation(); toggleBatchSelect(${game.appid});">
        <img class="capsule-artwork" src="${game.capsule_url || game.header_url}" loading="lazy">
        <div class="capsule-overlay">
          <div class="capsule-title">${escapeHtml(game.name)}</div>
          <div class="capsule-subtext">${playtimeHrs} hrs played</div>
        </div>
      </div>
    `;
  });
  html += `</div>`;
  mainPane.innerHTML = html;
}

function renderListView() {
  const mainPane = document.getElementById("libraryMainPane");
  if (!mainPane) return;

  const installedAppIds = new Set(state.installedGames.map((ig) => ig.appid));
  let html = `
    <div style="padding: 24px 32px;">
      <div class="queue-table-container">
        <div class="queue-section-header">
          <span>Steam Games List (${state.filteredGames.length})</span>
        </div>
  `;

  state.filteredGames.forEach((game) => {
    const isInstalled = installedAppIds.has(game.appid);
    const playtimeHrs = (game.playtime_forever / 60).toFixed(1);
    html += `
      <div class="queue-row" onclick="selectGame(${game.appid}); setLibraryViewMode('hero');" style="cursor: pointer;">
        <div class="queue-col-title">
          <img src="${game.icon_url}" style="width: 20px; height: 20px; border-radius: 2px;">
          <span>${escapeHtml(game.name)}</span>
        </div>
        <div class="queue-col-status">${playtimeHrs} hrs played</div>
        <div class="queue-col-status" style="color: ${isInstalled ? "var(--steam-in-game-green)" : "var(--steam-text-dim)"}">
          ${isInstalled ? "Installed on NAS" : "Uninstalled"}
        </div>
      </div>
    `;
  });
  html += `</div></div>`;
  mainPane.innerHTML = html;
}

// Batch Select Controls
function toggleBatchMode() {
  state.batchMode = !state.batchMode;
  renderSidebarGames();
  updateBatchBarUI();
}

function toggleBatchSelect(appid) {
  if (state.batchSelectedAppIds.has(appid)) {
    state.batchSelectedAppIds.delete(appid);
  } else {
    state.batchSelectedAppIds.add(appid);
  }
  valveSound.playHover();
  renderSidebarGames();
  updateBatchBarUI();
}

function selectAllBatch() {
  state.filteredGames.forEach((g) => state.batchSelectedAppIds.add(g.appid));
  renderSidebarGames();
  updateBatchBarUI();
}

function deselectAllBatch() {
  state.batchSelectedAppIds.clear();
  renderSidebarGames();
  updateBatchBarUI();
}

function updateBatchBarUI() {
  let bar = document.getElementById("batchActionBar");
  if (!bar) return;

  if (state.batchSelectedAppIds.size > 0) {
    bar.style.display = "flex";
    const countEl = document.getElementById("batchSelectedCountText");
    if (countEl) countEl.textContent = `${state.batchSelectedAppIds.size} games selected`;
  } else {
    bar.style.display = "none";
  }
}

async function queueBatchSelectedGames() {
  if (state.batchSelectedAppIds.size === 0) return;
  valveSound.playSelect();

  const gamesToQueue = state.games
    .filter((g) => state.batchSelectedAppIds.has(g.appid))
    .map((g) => ({ appid: g.appid, name: g.name }));

  const requireGoldberg = document.getElementById("batchRequireGoldbergCheck")?.checked || false;

  try {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: gamesToQueue, require_goldberg: requireGoldberg }),
    });
    if (res.ok) {
      showToast(`Added ${gamesToQueue.length} games to download queue!`, "success");
      deselectAllBatch();
      switchTab("downloads");
    }
  } catch (e) {
    showToast("Error adding batch to queue.", "error");
  }
}

// Context Menu (Right Click on Game)
function openContextMenu(e, appid) {
  e.preventDefault();
  closeContextMenu();

  const game = state.games.find((g) => g.appid === appid);
  if (!game) return;

  const isFavorite = state.favorites.has(appid);
  const isInstalled = state.installedGames.some((ig) => ig.appid === appid);

  const menu = document.createElement("div");
  menu.id = "customContextMenu";
  menu.className = "dropdown-menu show";
  menu.style.position = "fixed";
  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.style.zIndex = "3000";

  menu.innerHTML = `
    <button class="dropdown-item" onclick="handleHeroInstallClick(${appid}); closeContextMenu();">
      ${isInstalled ? "Install / Re-validate" : "Download to NAS"}
    </button>
    <button class="dropdown-item" onclick="toggleFavorite(${appid}); closeContextMenu();">
      ${isFavorite ? "Remove from Favorites" : "Add to Favorites"}
    </button>
    <button class="dropdown-item" onclick="toggleGoldbergForGame(${appid}); closeContextMenu();">
      Toggle Goldberg DRM
    </button>
    <button class="dropdown-item" onclick="openGamePropertiesModal(${appid}); closeContextMenu();">
      Properties...
    </button>
  `;

  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener("click", closeContextMenu, { once: true });
  }, 10);
}

function closeContextMenu() {
  const m = document.getElementById("customContextMenu");
  if (m) m.remove();
}

function toggleFavorite(appid) {
  if (state.favorites.has(appid)) {
    state.favorites.delete(appid);
    showToast("Removed from Favorites.", "info");
  } else {
    state.favorites.add(appid);
    showToast("Added to Favorites!", "success");
  }
  localStorage.setItem("vf_favorites", JSON.stringify([...state.favorites]));
  applyLibraryFilters();
}

// Game Properties Modal & Offline Emulator Management
function openGamePropertiesModal(appid) {
  state.gamePropertiesTargetAppId = appid;
  const game = state.games.find((g) => g.appid === appid);
  if (!game) return;

  valveSound.playModalOpen();
  const modal = document.getElementById("gamePropertiesModal");
  if (!modal) return;

  const titleEl = document.getElementById("propGameTitle");
  if (titleEl) titleEl.textContent = `${game.name} — Properties`;

  const appIdEl = document.getElementById("propAppIdDisplay");
  if (appIdEl) appIdEl.textContent = String(game.appid);

  const installed = state.installedGames.find((ig) => ig.appid === appid);
  const pathEl = document.getElementById("propFilePathDisplay");
  const sizeEl = document.getElementById("propFileSizeDisplay");
  const goldbergStatusEl = document.getElementById("propGoldbergStatusDisplay");

  if (installed) {
    if (pathEl) pathEl.textContent = installed.path || `/downloads/steamapps/common/${installed.folder_name}`;
    if (sizeEl) sizeEl.textContent = `${(installed.size_bytes / (1024 ** 3)).toFixed(2)} GB`;
    if (goldbergStatusEl) {
      goldbergStatusEl.innerHTML = installed.goldberg_patched
        ? '<span style="color: var(--steam-gold); font-weight: 700;">★ Applied (DRM-Free)</span>'
        : '<span style="color: var(--steam-text-secondary);">Original Steam DRM</span>';
    }
  } else {
    if (pathEl) pathEl.textContent = "Not installed on NAS";
    if (sizeEl) sizeEl.textContent = "--";
    if (goldbergStatusEl) goldbergStatusEl.textContent = "Not installed on NAS";
  }

  switchPropSubtab("general");
  modal.style.display = "flex";
}

function closeGamePropertiesModal() {
  const modal = document.getElementById("gamePropertiesModal");
  if (modal) modal.style.display = "none";
}

function switchPropSubtab(tabName, btn) {
  valveSound.playSelect();
  document.querySelectorAll("#gamePropertiesModal .settings-tab-btn").forEach((b) => {
    b.classList.remove("active");
  });
  if (btn) {
    btn.classList.add("active");
  } else {
    const defaultBtn = document.querySelector("#gamePropertiesModal .settings-tab-btn");
    if (defaultBtn) defaultBtn.classList.add("active");
  }

  const panes = {
    general: document.getElementById("propPaneGeneral"),
    files: document.getElementById("propPaneFiles"),
    goldberg: document.getElementById("propPaneGoldberg"),
  };

  Object.keys(panes).forEach((key) => {
    if (panes[key]) panes[key].style.display = key === tabName ? "block" : "none";
  });
}

async function checkGoldbergStatusForHero(appid) {
  const btn = document.getElementById("btnGoldbergHero");
  if (!btn) return;
  try {
    const res = await fetch(`/api/games/${appid}/goldberg`);
    if (!res.ok) {
      btn.style.display = "none";
      return;
    }
    const data = await res.json();
    btn.style.display = "inline-flex";
    if (data.patched) {
      btn.innerHTML = `<span style="color: var(--steam-gold); font-weight: 700;">★ DRM-Free</span>`;
      btn.title = "Goldberg emulator applied. Click to restore original Steam DRM.";
    } else {
      btn.innerHTML = `<span>Goldberg Wrapper</span>`;
      btn.title = "Click to apply Goldberg DRM-Free wrapper.";
    }
  } catch (e) {
    btn.style.display = "none";
  }
}

async function toggleGoldbergForGame(appid) {
  if (!appid) return;
  valveSound.playSelect();
  try {
    const statusRes = await fetch(`/api/games/${appid}/goldberg`);
    const statusData = await statusRes.json();
    const endpoint = statusData.patched ? `/api/games/${appid}/goldberg/revert` : `/api/games/${appid}/goldberg/apply`;
    const res = await fetch(endpoint, { method: "POST" });
    const result = await res.json();
    if (result.success) {
      valveSound.playSuccess();
      showToast(statusData.patched ? "Restored original Steam DRM DLLs." : "Applied Goldberg DRM-Free wrapper!", "success");
      await checkGoldbergStatusForHero(appid);
      await loadInstalledGames();
      if (state.gamePropertiesTargetAppId === appid) {
        const goldbergStatusEl = document.getElementById("propGoldbergStatusDisplay");
        if (goldbergStatusEl) {
          goldbergStatusEl.innerHTML = !statusData.patched
            ? '<span style="color: var(--steam-gold); font-weight: 700;">★ Applied (DRM-Free)</span>'
            : '<span style="color: var(--steam-text-secondary);">Original Steam DRM</span>';
        }
      }
    } else {
      showToast(result.message || "Failed to toggle Goldberg emulator.", "error");
    }
  } catch (e) {
    showToast("Error toggling Goldberg wrapper.", "error");
  }
}

async function applyGoldbergToGame(appid) {
  if (!appid) return;
  valveSound.playSelect();
  try {
    const res = await fetch(`/api/games/${appid}/goldberg/apply`, { method: "POST" });
    const result = await res.json();
    if (result.success) {
      valveSound.playSuccess();
      showToast("Goldberg DRM-free wrapper applied!", "success");
      await loadInstalledGames();
      await checkGoldbergStatusForHero(appid);
    } else {
      showToast(result.message || "Could not apply Goldberg wrapper.", "error");
    }
  } catch (e) {
    showToast("Error applying Goldberg.", "error");
  }
}

async function deleteGameFromNasByAppId(appid) {
  if (!appid) return;
  const installed = state.installedGames.find((ig) => ig.appid === appid);
  if (!installed) {
    showToast("Game files not found on NAS.", "info");
    return;
  }
  if (confirm(`Are you sure you want to delete '${installed.folder_name}' from your NAS?`)) {
    closeGamePropertiesModal();
    await deleteGameFromNas(installed.folder_name);
  }
}

function toggleBatchMode() {
  state.batchMode = !state.batchMode;
  valveSound.playSelect();
  const toggleBtn = document.getElementById("batchModeToggleBtn");
  if (toggleBtn) toggleBtn.classList.toggle("active", state.batchMode);
  renderSidebarGames();
  updateBatchBarUI();
}

function clearLibrarySearch() {
  const input = document.getElementById("librarySearchInput");
  if (input) {
    input.value = "";
    const clearBtn = document.getElementById("librarySearchClearBtn");
    if (clearBtn) clearBtn.style.display = "none";
    applyLibraryFilters();
  }
}


// ==========================================================================
// STORE EXPLORER (SEARCH ANY APP ON STEAM)
// ==========================================================================

async function executeStoreSearch() {
  const input = document.getElementById("storeSearchInput");
  const query = input ? input.value.trim() : "";
  if (!query) return;

  valveSound.playSelect();
  const grid = document.getElementById("storeSearchResultsGrid");
  if (grid) grid.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Searching Steam Store...</div>`;

  try {
    const res = await fetch(`/api/store/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      if (grid) grid.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">No store titles found matching '${escapeHtml(query)}'.</div>`;
      return;
    }

    let html = "";
    results.forEach((item) => {
      html += `
        <div class="game-capsule-card" style="aspect-ratio: 16/9; max-width: 320px;">
          <img class="capsule-artwork" src="${item.header_url}">
          <div class="capsule-overlay" style="opacity: 1; background: linear-gradient(to top, rgba(0,0,0,0.95), transparent);">
            <div class="capsule-title">${escapeHtml(item.name)}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
              <span style="font-size: 11px; color: var(--steam-blue-light);">${item.price > 0 ? "$" + item.price.toFixed(2) : "Free"}</span>
              <button class="btn-steam-green" style="padding: 4px 10px; font-size: 11px;" onclick="queueStoreGame(${item.appid}, '${escapeHtml(item.name)}')">
                Download to NAS
              </button>
            </div>
          </div>
        </div>
      `;
    });
    if (grid) grid.innerHTML = html;
  } catch (e) {
    if (grid) grid.innerHTML = `<div style="padding: 24px; color: var(--steam-red);">Error searching Steam Store.</div>`;
  }
}

async function queueStoreGame(appid, name) {
  valveSound.playSelect();
  try {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: [{ appid, name }] }),
    });
    if (res.ok) {
      showToast(`Added '${name}' to download queue!`, "success");
      switchTab("downloads");
    }
  } catch (e) {
    showToast("Error queuing store game.", "error");
  }
}

// ==========================================================================
// COMMUNITY NEWS FEED
// ==========================================================================

async function loadCommunityFeed() {
  const container = document.getElementById("communityNewsList");
  if (!container) return;

  container.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Loading developer patch notes and announcements...</div>`;

  const appids = [];
  if (state.selectedGame) appids.push(state.selectedGame.appid);
  state.installedGames.forEach((ig) => { if (!appids.includes(ig.appid)) appids.push(ig.appid); });
  state.games.slice(0, 4).forEach((g) => { if (!appids.includes(g.appid)) appids.push(g.appid); });
  if (appids.length === 0) appids.push(730, 400, 220);

  try {
    const allNews = [];
    const targets = appids.slice(0, 4);

    for (const aid of targets) {
      try {
        const res = await fetch(`/api/games/${aid}/news`);
        if (res.ok) {
          const data = await res.json();
          const items = data.news || [];
          allNews.push(...items);
        }
      } catch (e) {}
    }

    if (allNews.length === 0) {
      container.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">No community news available.</div>`;
      return;
    }

    allNews.sort((a, b) => (b.date || 0) - (a.date || 0));

    let html = "";
    allNews.slice(0, 8).forEach((item) => {
      const dateStr = item.date ? new Date(item.date * 1000).toLocaleDateString() : "--";
      html += `
        <div class="steam-panel-box">
          <div class="panel-title">${escapeHtml(item.title)}</div>
          <div style="font-size: 11px; color: var(--steam-text-dim); margin-bottom: 8px;">Posted by ${escapeHtml(item.author)} on ${dateStr}</div>
          <div style="font-size: 13px; color: var(--steam-text-main); line-height: 1.6;">${escapeHtml(item.contents)}</div>
        </div>
      `;
    });
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Could not fetch community feed.</div>`;
  }
}

// ==========================================================================
// DOWNLOADS & REAL-TIME DUAL-SPEED CHART
// ==========================================================================

function initSpeedCanvas() {
  const canvas = document.getElementById("speedCanvas");
  if (!canvas) return;

  function resizeCanvas() {
    if (!canvas.parentElement) return;
    canvas.width = canvas.parentElement.clientWidth * window.devicePixelRatio;
    canvas.height = canvas.parentElement.clientHeight * window.devicePixelRatio;
    drawSpeedGraph();
  }

  window.addEventListener("resize", resizeCanvas);
  setTimeout(resizeCanvas, 100);
}

function drawSpeedGraph() {
  const canvas = document.getElementById("speedCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  // Background grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
  ctx.lineWidth = 1;
  const gridSteps = 4;
  for (let i = 1; i < gridSteps; i++) {
    const y = (h / gridSteps) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (state.speedHistory.length < 2) return;

  const maxSpeed = Math.max(...state.speedHistory.map((pt) => Math.max(pt.net, pt.disk)), 1024 * 1024);
  const stepX = w / (state.speedHistory.length - 1);

  // 1. Network Download Speed Area & Curve (Cyan)
  ctx.beginPath();
  ctx.moveTo(0, h);
  state.speedHistory.forEach((pt, idx) => {
    const x = idx * stepX;
    const y = h - (pt.net / maxSpeed) * (h * 0.85);
    if (idx === 0) ctx.lineTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(w, h);
  ctx.closePath();

  const netGradient = ctx.createLinearGradient(0, 0, 0, h);
  netGradient.addColorStop(0, "rgba(26, 159, 255, 0.35)");
  netGradient.addColorStop(1, "rgba(26, 159, 255, 0.0)");
  ctx.fillStyle = netGradient;
  ctx.fill();

  ctx.beginPath();
  state.speedHistory.forEach((pt, idx) => {
    const x = idx * stepX;
    const y = h - (pt.net / maxSpeed) * (h * 0.85);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#1a9fff";
  ctx.lineWidth = 2 * window.devicePixelRatio;
  ctx.stroke();

  // 2. Disk Activity Curve (Dashed Green)
  ctx.beginPath();
  ctx.setLineDash([4 * window.devicePixelRatio, 4 * window.devicePixelRatio]);
  state.speedHistory.forEach((pt, idx) => {
    const x = idx * stepX;
    const y = h - (pt.disk / maxSpeed) * (h * 0.85);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "#90ba3c";
  ctx.lineWidth = 1.5 * window.devicePixelRatio;
  ctx.stroke();
  ctx.setLineDash([]);
}

function connectTelemetryStream() {
  if (state.sseSource) state.sseSource.close();
  state.sseSource = new EventSource("/api/queue/stream");

  state.sseSource.onmessage = (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.event === "queue_update") {
        state.queue = payload.data;
        updateActiveDownloadItem();
        renderDownloadsView();
      } else if (payload.event === "item_update") {
        updateItemInQueue(payload.data);
        renderDownloadsView();
      } else if (payload.event === "item_log") {
        appendConsoleLog(payload.data.line);
        recordSpeedSample(payload.data.speed_bps || 0, payload.data.disk_speed_bps || 0);
      }
    } catch (err) {}
  };
}

function recordSpeedSample(netBps, diskBps) {
  state.speedHistory.push({ net: netBps, disk: diskBps });
  if (state.speedHistory.length > 50) {
    state.speedHistory.shift();
  }
  drawSpeedGraph();
}

function updateActiveDownloadItem() {
  state.activeDownloadItem = state.queue.items.find((i) => i.status === "running") || null;
  const countBadge = document.getElementById("queueCountBadge");
  const activeCount = state.queue.items.filter((i) => i.status === "queued" || i.status === "running").length;
  if (countBadge) {
    countBadge.textContent = activeCount;
    countBadge.style.display = activeCount > 0 ? "inline-block" : "none";
  }
}

function updateItemInQueue(updatedItem) {
  const idx = state.queue.items.findIndex((i) => i.id === updatedItem.id);
  if (idx !== -1) {
    state.queue.items[idx] = updatedItem;
  } else {
    state.queue.items.push(updatedItem);
  }
  updateActiveDownloadItem();
}

function renderDownloadsView() {
  const activeSection = document.getElementById("activeDownloadHero");
  const queueTable = document.getElementById("upcomingQueueTable");

  if (state.activeDownloadItem) {
    if (activeSection) activeSection.style.display = "flex";
    const item = state.activeDownloadItem;

    const titleEl = document.getElementById("activeHeroTitle");
    const bannerEl = document.getElementById("activeHeroBanner");
    const speedEl = document.getElementById("telemetrySpeed");
    const etaEl = document.getElementById("telemetryEta");
    const downloadedEl = document.getElementById("telemetryDownloaded");
    const progressEl = document.getElementById("telemetryProgress");
    const stageEl = document.getElementById("activeHeroStage");

    if (titleEl) titleEl.textContent = item.name;
    if (bannerEl) bannerEl.src = item.header_url || `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${item.appid}/header.jpg`;
    if (speedEl) speedEl.textContent = `${(item.speed_bps / (1024 * 1024)).toFixed(1)} MB/s`;
    if (etaEl) etaEl.textContent = formatEta(item.eta_seconds);
    if (downloadedEl) downloadedEl.textContent = `${(item.current_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB / ${(item.total_bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    if (progressEl) progressEl.textContent = `${item.progress.toFixed(1)}%`;
    if (stageEl) stageEl.textContent = item.step;
  } else {
    if (activeSection) activeSection.style.display = "none";
  }

  if (queueTable) {
    const queuedItems = state.queue.items.filter((i) => i.status === "queued");
    if (queuedItems.length === 0) {
      queueTable.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--steam-text-dim);">No queued downloads pending.</div>`;
    } else {
      let html = "";
      queuedItems.forEach((item, idx) => {
        html += `
          <div class="queue-row">
            <div class="queue-col-title">
              <span>${idx + 1}.</span>
              <span>${escapeHtml(item.name)}</span>
            </div>
            <div class="queue-col-status">${item.step}</div>
            <div class="queue-col-actions">
              <button class="menu-button" onclick="changeQueuePriority('${item.id}', 'up')" title="Move Up">▲</button>
              <button class="menu-button" onclick="changeQueuePriority('${item.id}', 'down')" title="Move Down">▼</button>
              <button class="menu-button" onclick="cancelQueueItem('${item.id}')" title="Cancel">✕</button>
            </div>
          </div>
        `;
      });
      queueTable.innerHTML = html;
    }
  }
}

async function cancelActiveDownload() {
  if (!state.activeDownloadItem) return;
  cancelQueueItem(state.activeDownloadItem.id);
}

async function changeQueuePriority(itemId, direction) {
  try {
    await fetch(`/api/queue/${itemId}/priority`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction }),
    });
  } catch (e) {}
}

async function cancelQueueItem(itemId) {
  try {
    await fetch(`/api/queue/${itemId}`, { method: "DELETE" });
  } catch (e) {}
}

async function clearCompletedQueue() {
  try {
    await fetch("/api/queue/clear-completed", { method: "POST" });
  } catch (e) {}
}

// ==========================================================================
// VALVE DEVELOPER CONSOLE
// ==========================================================================

function appendConsoleLog(line) {
  const terminal = document.getElementById("consoleTerminal");
  if (!terminal) return;
  const p = document.createElement("div");
  p.textContent = line;
  terminal.appendChild(p);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearConsoleLog() {
  const terminal = document.getElementById("consoleTerminal");
  if (terminal) terminal.innerHTML = "";
}

async function executeConsoleInput(e) {
  if (e.key !== "Enter") return;
  const input = document.getElementById("consoleCommandInput");
  if (!input || !input.value.trim()) return;

  const cmd = input.value.trim();
  input.value = "";
  appendConsoleLog(`] ${cmd}`);

  try {
    const res = await fetch("/api/console/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: cmd }),
    });
    const data = await res.json();
    if (data.output) appendConsoleLog(data.output);
  } catch (err) {
    appendConsoleLog(`Error executing command: ${err}`);
  }
}

// ==========================================================================
// STORAGE & NAS MANAGER
// ==========================================================================

async function refreshStorageInfo() {
  try {
    const res = await fetch("/api/storage/status");
    const data = await res.json();
    state.storageInfo = data;

    const totalGb = (data.total_bytes / (1024 ** 3)).toFixed(1);
    const freeGb = (data.free_bytes / (1024 ** 3)).toFixed(1);
    const usedGb = (data.used_bytes / (1024 ** 3)).toFixed(1);

    const txt = document.getElementById("storageNavText");
    if (txt) txt.textContent = `${freeGb} GB Free`;

    const barUsed = document.getElementById("storageBarUsed");
    if (barUsed) barUsed.style.width = `${data.used_percent}%`;

    const statsDetail = document.getElementById("storageDetailText");
    if (statsDetail) statsDetail.textContent = `${usedGb} GB used of ${totalGb} GB (${data.used_percent}%)`;
  } catch (e) {}
}

async function loadInstalledGames() {
  try {
    const res = await fetch("/api/storage/games");
    const data = await res.json();
    state.installedGames = data.games || [];
    renderInstalledGamesTable();
  } catch (e) {}
}

function renderInstalledGamesTable() {
  const container = document.getElementById("installedGamesTableBody");
  if (!container) return;

  if (state.installedGames.length === 0) {
    container.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--steam-text-dim);">No games installed on NAS yet.</div>`;
    return;
  }

  let html = "";
  state.installedGames.forEach((game) => {
    const sizeGb = (game.size_bytes / (1024 ** 3)).toFixed(2);
    html += `
      <div class="queue-row">
        <div class="queue-col-title">
          <span>${escapeHtml(game.name)}</span>
        </div>
        <div class="queue-col-status">
          ${sizeGb} GB | ${game.goldberg_patched ? "DRM-Free" : "Authentic Steam"}
        </div>
        <div class="queue-col-actions">
          <button class="menu-button" onclick="selectGame(${game.appid}); switchTab('library');">View in Library</button>
          <button class="menu-button" style="color: var(--steam-red);" onclick="deleteGameFromNas('${escapeHtml(game.folder_name)}')">Delete</button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

async function deleteGameFromNas(folderName) {
  if (!confirm(`Are you sure you want to delete '${folderName}' from your NAS storage?`)) return;
  try {
    const res = await fetch(`/api/storage/games/${encodeURIComponent(folderName)}`, { method: "DELETE" });
    if (res.ok) {
      showToast(`Deleted '${folderName}' from NAS.`, "info");
      await refreshStorageInfo();
      await loadInstalledGames();
      applyLibraryFilters();
    }
  } catch (e) {}
}

// ==========================================================================
// STEAM DECK / BIG PICTURE CAROUSEL
// ==========================================================================

function renderBigPictureCarousel() {
  let container = document.getElementById("deckHomeCarousel");
  if (!container) return;

  const displayGames = state.filteredGames.slice(0, 15);
  let html = "";
  displayGames.forEach((game) => {
    const playtimeHrs = (game.playtime_forever / 60).toFixed(1);
    html += `
      <div class="deck-game-card" tabindex="0" onclick="selectGame(${game.appid}); toggleBigPictureMode();">
        <img class="deck-card-banner" src="${game.header_url || game.capsule_url}">
        <div class="deck-card-info">
          <div class="deck-card-title">${escapeHtml(game.name)}</div>
          <div class="deck-card-time">${playtimeHrs} hrs played</div>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

// ==========================================================================
// SETTINGS & SYSTEM UPDATES
// ==========================================================================

async function loadSettings() {
  try {
    const res = await fetch("/api/settings");
    const data = await res.json();
    const apiKeyInput = document.getElementById("cfgSteamApiKey");
    const platformSelect = document.getElementById("cfgForcePlatform");
    const goldbergCheck = document.getElementById("cfgEnableGoldberg");
    const soundCheck = document.getElementById("cfgEnableSound");

    if (apiKeyInput) apiKeyInput.value = data.steam_api_key || "";
    if (platformSelect) platformSelect.value = data.force_platform || "windows";
    if (goldbergCheck) goldbergCheck.checked = !!data.enable_goldberg;
    if (soundCheck) soundCheck.checked = data.ui_sound_enabled !== false;
  } catch (e) {}
}

async function saveSettings(e) {
  if (e) e.preventDefault();
  valveSound.playSelect();

  const apiKey = document.getElementById("cfgSteamApiKey")?.value;
  const platform = document.getElementById("cfgForcePlatform")?.value;
  const goldberg = document.getElementById("cfgEnableGoldberg")?.checked;
  const sound = document.getElementById("cfgEnableSound")?.checked;

  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steam_api_key: apiKey,
        force_platform: platform,
        enable_goldberg: goldberg,
        ui_sound_enabled: sound,
      }),
    });
    if (res.ok) {
      valveSound.setMute(!sound);
      showToast("Steam settings saved!", "success");
      closeSettingsModal();
    }
  } catch (err) {
    showToast("Error saving settings.", "error");
  }
}

function toggleMenuDropdown(menuId, event) {
  if (event) event.stopPropagation();
  valveSound.playSelect();
  const menu = document.getElementById(menuId);
  if (!menu) return;

  const isShown = menu.classList.contains("show");
  document.querySelectorAll(".dropdown-menu").forEach((m) => m.classList.remove("show"));

  if (!isShown) {
    menu.classList.add("show");
    setTimeout(() => {
      document.addEventListener("click", () => {
        menu.classList.remove("show");
      }, { once: true });
    }, 10);
  }
}

function openSettingsModal(defaultTab = "account") {
  valveSound.playModalOpen();
  const modal = document.getElementById("settingsModal");
  if (!modal) return;

  const accNameEl = document.getElementById("settingsAccountNameDisplay");
  if (accNameEl) {
    if (state.userSession && state.userSession.authenticated) {
      accNameEl.textContent = `${state.userSession.personaname || state.userSession.account_name} (${state.userSession.steamid || "Steam Guard Authorized"})`;
    } else {
      accNameEl.textContent = "Not signed in";
    }
  }

  switchSettingsSubtab(defaultTab);
  modal.style.display = "flex";
}

function closeSettingsModal() {
  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "none";
}

function switchSettingsSubtab(tabName, btn) {
  valveSound.playSelect();
  document.querySelectorAll("#settingsModal .settings-tab-btn").forEach((b) => {
    b.classList.remove("active");
  });
  if (btn) {
    btn.classList.add("active");
  } else {
    const matchingBtn = Array.from(document.querySelectorAll("#settingsModal .settings-tab-btn")).find(
      (b) => b.textContent.toLowerCase().includes(tabName)
    );
    if (matchingBtn) matchingBtn.classList.add("active");
  }

  const panes = {
    account: document.getElementById("settingsPaneAccount"),
    downloads: document.getElementById("settingsPaneDownloads"),
    storage: document.getElementById("settingsPaneStorage"),
    goldberg: document.getElementById("settingsPaneGoldberg"),
    interface: document.getElementById("settingsPaneInterface"),
  };

  Object.keys(panes).forEach((key) => {
    if (panes[key]) panes[key].style.display = key === tabName ? "flex" : "none";
  });
}

function switchLoginAuthMode(mode) {
  valveSound.playSelect();
  const tabQr = document.getElementById("loginTabQrBtn");
  const tabCreds = document.getElementById("loginTabCredsBtn");
  const modeQr = document.getElementById("loginModeQr");
  const modeCreds = document.getElementById("loginModeCreds");

  if (mode === "creds") {
    if (tabQr) tabQr.classList.remove("active");
    if (tabCreds) tabCreds.classList.add("active");
    if (modeQr) modeQr.style.display = "none";
    if (modeCreds) modeCreds.style.display = "flex";
  } else {
    if (tabQr) tabQr.classList.add("active");
    if (tabCreds) tabCreds.classList.remove("active");
    if (modeQr) modeQr.style.display = "flex";
    if (modeCreds) modeCreds.style.display = "none";
    startQrAuthSession();
  }
}

async function submitCredentialsLogin(e) {
  if (e) e.preventDefault();
  valveSound.playSelect();

  const user = document.getElementById("loginUsername")?.value.trim();
  const pass = document.getElementById("loginPassword")?.value;
  const code = document.getElementById("login2faCode")?.value.trim();
  const statusEl = document.getElementById("loginCredsStatus");
  const submitBtn = document.getElementById("loginCredsSubmitBtn");

  if (!user || !pass) {
    if (statusEl) statusEl.textContent = "Please enter both username and password.";
    return;
  }

  if (statusEl) statusEl.textContent = "Logging into SteamCMD session...";
  if (submitBtn) submitBtn.disabled = true;

  try {
    let res;
    if (code) {
      res = await fetch("/api/auth/steamcmd/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
    } else {
      res = await fetch("/api/auth/steamcmd/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
    }
    const data = await res.json();
    if (data.status === "requires_2fa") {
      const group2fa = document.getElementById("login2faGroup");
      if (group2fa) group2fa.style.display = "block";
      if (statusEl) statusEl.textContent = "Steam Guard code required. Check your Steam Mobile app or Email.";
      showToast("Steam Guard 2FA code required.", "info");
    } else if (data.status === "authorized" || data.authenticated) {
      valveSound.playSuccess();
      showToast("Successfully logged into Steam!", "success");
      closeQrLoginModal();
      await checkUserSession();
      await loadGamesLibrary();
    } else {
      if (statusEl) statusEl.textContent = data.message || "Failed to log in. Check credentials.";
      showToast(data.message || "Login failed.", "error");
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = "Error communicating with server.";
    showToast("Server error during login.", "error");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openAboutModal() {
  valveSound.playModalOpen();
  const modal = document.getElementById("aboutModal");
  if (modal) modal.style.display = "flex";
}

function closeAboutModal() {
  const modal = document.getElementById("aboutModal");
  if (modal) modal.style.display = "none";
}

async function loadStoreFeatured() {
  const grid = document.getElementById("storeSearchResultsGrid");
  if (!grid) return;
  grid.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Loading featured Steam Store titles...</div>`;

  try {
    const res = await fetch("/api/store/featured");
    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      grid.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Ready to search Steam Store. Type any title above.</div>`;
      return;
    }

    let html = "";
    results.forEach((item) => {
      html += `
        <div class="game-capsule-card" style="aspect-ratio: 16/9; max-width: 340px;">
          <img class="capsule-artwork" src="${item.header_url}" loading="lazy">
          <div class="capsule-overlay" style="opacity: 1; background: linear-gradient(to top, rgba(0,0,0,0.95), transparent);">
            <div class="capsule-title">${escapeHtml(item.name)}</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 6px;">
              <span style="font-size: 11px; color: var(--steam-blue-light); font-weight: 700;">${item.price > 0 ? "$" + item.price.toFixed(2) : "Free to Play"}</span>
              <button class="btn-steam-green" style="padding: 5px 12px; font-size: 11px;" onclick="queueStoreGame(${item.appid}, '${escapeHtml(item.name)}')">
                Download to NAS
              </button>
            </div>
          </div>
        </div>
      `;
    });
    grid.innerHTML = html;
  } catch (e) {
    grid.innerHTML = `<div style="padding: 24px; color: var(--steam-text-dim);">Ready to search Steam Store. Type a game title above.</div>`;
  }
}

async function checkUpdates(force = false) {
  try {
    const res = await fetch(`/api/system/update/check?force=${force}`);
    const data = await res.json();
    if (data.update_available) {
      showToast("A new container release is available! Recreate container to update.", "info");
    } else if (force) {
      showToast("VaporFetch Client is up to date (v2.0.0).", "info");
    }
  } catch (e) {
    if (force) showToast("Could not check for updates.", "error");
  }
}

// ==========================================================================
// TOAST NOTIFICATIONS & UTILITIES
// ==========================================================================

function showToast(msg, type = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `steam-toast toast-${type}`;
  toast.innerHTML = `
    <span style="color: var(--steam-blue-light); font-weight: 700;">Steam</span>
    <span>${escapeHtml(msg)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(100%)";
    toast.style.transition = "all 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return "--";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function setupEventListeners() {
  const searchInput = document.getElementById("librarySearchInput");
  const searchClear = document.getElementById("librarySearchClearBtn");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      if (searchClear) {
        searchClear.style.display = e.target.value ? "inline-block" : "none";
      }
      applyLibraryFilters();
    });
  }

  const consoleInput = document.getElementById("consoleCommandInput");
  if (consoleInput) {
    consoleInput.addEventListener("keydown", executeConsoleInput);
  }

  // Keyboard navigation & shortcuts
  document.addEventListener("keydown", (e) => {
    if (state.bigPictureMode) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const cards = Array.from(document.querySelectorAll("#deckHomeCarousel .deck-game-card"));
        if (cards.length > 0) {
          const activeIdx = cards.indexOf(document.activeElement);
          let nextIdx = 0;
          if (activeIdx !== -1) {
            nextIdx = e.key === "ArrowRight" ? Math.min(activeIdx + 1, cards.length - 1) : Math.max(activeIdx - 1, 0);
          }
          cards[nextIdx].focus();
          cards[nextIdx].scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
          valveSound.playHover();
        }
      } else if (e.key === "Enter" && document.activeElement && document.activeElement.classList.contains("deck-game-card")) {
        document.activeElement.click();
      } else if (e.key === "Escape") {
        toggleBigPictureMode();
      }
    } else {
      if (e.key === "Escape") {
        closeSettingsModal();
        closeGamePropertiesModal();
        closeQrLoginModal();
        closeAboutModal();
      }
    }
  });
}


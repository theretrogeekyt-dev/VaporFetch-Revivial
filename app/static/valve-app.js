/**
 * VaporFetch - Valve Steam Client Application Controller
 * Provides authentic Steam desktop & Steam Deck Big Picture UI logic.
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
  batchSelectedAppIds: new Set(),
  favorites: new Set(JSON.parse(localStorage.getItem("vf_favorites") || "[]")),
  speedHistory: [], // [{ net: bps, disk: bps }]
  bigPictureMode: false,
  qrSession: null,
  qrTimer: null,
  sseSource: null,
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

  // If authenticated, load library
  if (state.userSession && state.userSession.authenticated) {
    await loadGamesLibrary();
  } else {
    showLoginPrompt();
  }

  // Check for container updates
  checkUpdates(false);
});

// ==========================================================================
// NAVIGATION & VIEWS
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
  document.querySelectorAll(".nav-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabName);
  });
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${tabName}`);
  });

  if (tabName === "downloads") {
    renderDownloadsView();
  } else if (tabName === "storage") {
    refreshStorageInfo();
    loadInstalledGames();
  }
}

function toggleBigPictureMode() {
  state.bigPictureMode = !state.bigPictureMode;
  document.body.classList.toggle("mode-bigpicture", state.bigPictureMode);
  if (state.bigPictureMode) {
    valveSound.playSelect();
    renderBigPictureCarousel();
  } else {
    valveSound.playBack();
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
    if (nameEl) nameEl.textContent = session.personaname || session.account_name || "Steam User";
    if (avatarEl) avatarEl.src = session.avatar || "https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg";
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
    if (statusText) statusText.textContent = "Failed to start QR session. Check internet.";
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
        <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M2 12h20" fill="none" stroke="currentColor" stroke-width="2"/>
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

    // Select first game by default
    if (state.filteredGames.length > 0 && !state.selectedGame) {
      selectGame(state.filteredGames[0].appid);
    }
  } catch (e) {
    console.error("Library fetch error:", e);
  }
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
      <span>All Games</span>
      <span class="collection-count">${state.filteredGames.length}</span>
    </div>`;

  state.filteredGames.forEach((game) => {
    const isSelected = state.selectedGame && state.selectedGame.appid === game.appid;
    const isInstalled = installedAppIds.has(game.appid);
    const isDownloading = activeAppId === game.appid;

    let statusIcon = "";
    if (isDownloading) {
      statusIcon = `<svg class="item-status-icon status-downloading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    } else if (isInstalled) {
      statusIcon = `<svg class="item-status-icon status-downloaded" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    }

    const fallbackIcon = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><rect width=%22100%22 height=%22100%22 fill=%22%232a475e%22/><text x=%2250%22 y=%2260%22 font-size=%2250%22 text-anchor=%22middle%22 fill=%22white%22>🎮</text></svg>";

    html += `
      <div class="game-list-item ${isSelected ? "selected" : ""}" onclick="selectGame(${game.appid})" oncontextmenu="openContextMenu(event, ${game.appid})">
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
  const isQueued = state.queue.items.some((qi) => qi.appid === game.appid && qi.status in { queued: 1, running: 1 });
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
              ⚙️
            </button>
          </div>
        </div>
      </div>

      <div class="hero-tabs-header">
        <button class="hero-sub-tab active" onclick="switchHeroSubTab('overview')">Overview</button>
        <button class="hero-sub-tab" onclick="switchHeroSubTab('news')">News & Updates</button>
        <button class="hero-sub-tab" onclick="switchHeroSubTab('files')">Files & NAS</button>
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
            <div class="panel-title">Developer & Genres</div>
            <div id="heroMetaBox" style="font-size: 12px; color: var(--steam-text-secondary); display: flex; flex-direction: column; gap: 8px;">
              <div><strong>AppID:</strong> ${game.appid}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Fetch live store details & news asynchronously
  fetchGameStoreDetails(game.appid);
  fetchGameNews(game.appid);
  checkGoldbergStatusForHero(game.appid);
}

async function fetchGameStoreDetails(appid) {
  try {
    const res = await fetch(`/api/games/${appid}/details`);
    if (!res.ok) return;
    const data = await res.json();

    const descEl = document.getElementById("heroDescription");
    if (descEl && data.short_description) {
      descEl.textContent = data.short_description;
    }

    const metaBox = document.getElementById("heroMetaBox");
    if (metaBox) {
      metaBox.innerHTML = `
        <div><strong>AppID:</strong> ${appid}</div>
        <div><strong>Release Date:</strong> ${data.release_date || "--"}</div>
        <div><strong>Developers:</strong> ${(data.developers || []).join(", ") || "--"}</div>
        <div><strong>Publishers:</strong> ${(data.publishers || []).join(", ") || "--"}</div>
        <div><strong>Genres:</strong> ${(data.genres || []).join(", ") || "--"}</div>
      `;
    }
  } catch (e) {}
}

async function fetchGameNews(appid) {
  try {
    const res = await fetch(`/api/games/${appid}/news`);
    if (!res.ok) return;
    const data = await res.json();
    state.currentNews = data.news || [];
  } catch (e) {}
}

async function checkGoldbergStatusForHero(appid) {
  try {
    const res = await fetch(`/api/games/${appid}/goldberg`);
    if (!res.ok) return;
    const data = await res.json();
    const btn = document.getElementById("btnGoldbergHero");
    if (btn) {
      if (data.patched) {
        btn.classList.add("goldberg-active");
        btn.textContent = "DRM-Free (Goldberg Active)";
      } else {
        btn.classList.remove("goldberg-active");
        btn.textContent = "Apply Goldberg DRM";
      }
    }
  } catch (e) {}
}

async function toggleGoldbergForGame(appid) {
  valveSound.playSelect();
  try {
    const checkRes = await fetch(`/api/games/${appid}/goldberg`);
    if (!checkRes.ok) {
      showToast("Download the game to your NAS before applying Goldberg wrapper.", "warning");
      return;
    }
    const stat = await checkRes.json();
    if (stat.patched) {
      const revRes = await fetch(`/api/games/${appid}/goldberg/revert`, { method: "POST" });
      if (revRes.ok) {
        showToast("Reverted Goldberg wrapper back to authentic Steam DLLs.", "info");
        checkGoldbergStatusForHero(appid);
      }
    } else {
      const appRes = await fetch(`/api/games/${appid}/goldberg/apply`, { method: "POST" });
      if (appRes.ok) {
        showToast("Goldberg offline wrapper applied! Game is now DRM-free.", "success");
        checkGoldbergStatusForHero(appid);
      }
    }
  } catch (e) {
    showToast("Error updating Goldberg emulator.", "error");
  }
}

async function handleHeroInstallClick(appid) {
  const game = state.games.find((g) => g.appid === appid);
  if (!game) return;

  valveSound.playSelect();
  try {
    const res = await fetch("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ games: [{ appid: game.appid, name: game.name }] }),
    });
    if (res.ok) {
      showToast(`Added '${game.name}' to download queue!`, "success");
      switchTab("downloads");
    }
  } catch (e) {
    showToast("Failed to queue download.", "error");
  }
}

// ==========================================================================
// DOWNLOADS & REAL-TIME DUAL-SPEED CHART
// ==========================================================================

function initSpeedCanvas() {
  const canvas = document.getElementById("speedCanvas");
  if (!canvas) return;

  function resizeCanvas() {
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

  const maxSpeed = Math.max(...state.speedHistory.map((pt) => Math.max(pt.net, pt.disk)), 1024 * 1024); // at least 1 MB/s
  const stepX = w / (state.speedHistory.length - 1);

  // 1. Draw Network Download Speed Area & Curve (Cyan)
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

  // 2. Draw Disk Activity Curve (Dashed Green)
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
  const activeCount = state.queue.items.filter((i) => i.status in { queued: 1, running: 1 }).length;
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

  // Render Active Download Hero
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

  // Render Queued Items Table
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
    }
  } catch (e) {}
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

function openSettingsModal() {
  valveSound.playModalOpen();
  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "flex";
}

function closeSettingsModal() {
  const modal = document.getElementById("settingsModal");
  if (modal) modal.style.display = "none";
}

async function checkUpdates(force = false) {
  try {
    const res = await fetch(`/api/system/update/check?force=${force}`);
    const data = await res.json();
    if (data.update_available) {
      const banner = document.getElementById("updateAlertPill");
      if (banner) banner.style.display = "flex";
    }
  } catch (e) {}
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
  // Search bar input
  const searchInput = document.getElementById("librarySearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", applyLibraryFilters);
  }

  // Developer Console input
  const consoleInput = document.getElementById("consoleCommandInput");
  if (consoleInput) {
    consoleInput.addEventListener("keydown", executeConsoleInput);
  }
}


# VaporFetch 🎮

<div align="center">

```
  ██████╗ ████████╗███████╗ █████╗ ███╗   ███╗
 ██╔════╝ ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║
 ╚█████╗     ██║   █████╗  ███████║██╔████╔██║
  ╚═══██╗    ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║
 ██████╔╝    ██║   ███████╗██║  ██║██║ ╚═╝ ██║
 ╚═════╝     ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝
              V A P O R F E T C H
```

**The Valve-Authentic Steam NAS Batch Downloader**

[![Build & Publish Docker Image](https://github.com/theretrogeekyt-dev/VaporFetch/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/theretrogeekyt-dev/VaporFetch/actions/workflows/docker-publish.yml)
[![Docker Image](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/theretrogeekyt-dev/VaporFetch/pkgs/container/vaporfetch)
[![Steam Deck](https://img.shields.io/badge/Steam_Deck-Ready-1a9fff?logo=steamdeck)](https://store.steampowered.com/steamdeck)
[![Platform](https://img.shields.io/badge/platform-Unraid%20%7C%20TrueNAS%20%7C%20Synology%20%7C%20Linux-brightgreen)](https://github.com/theretrogeekyt-dev/VaporFetch)

*A self-hosted web application packaged in a single Docker container designed to look, feel, and function like an official Valve-developed application for managing and batch-downloading Steam games directly to Network Attached Storage (NAS).*

</div>

---

## 🌟 Valve-Grade Features

- 🎮 **Authentic Valve Steam Client UI**: Faithful recreation of the modern Steam Desktop client and Panorama design system. Features a split-pane library with collapsible collections, search filtering, and full **Hero Game Detail Pages** with backdrop banners, developer news, and playtime stats.
- 📺 **Steam Deck & Big Picture Mode (BPM)**: 1-click toggle switches the interface into an immersive **SteamOS 3 / Steam Deck OLED** experience with horizontal carousel navigation, game cards, and full gamepad navigation support.
- ⚡ **Iconic Valve Downloads Manager**: Dedicated downloads tab featuring a **real-time Dual-Speed Canvas Graph** plotting both Network Download Speed and Disk Activity curves simultaneously, detailed telemetry gauges (MB/s, ETA, downloaded bytes), and Up/Down priority sorting.
- 🖥️ **Integrated Valve Developer Console (`~`)**: Collapsible interactive terminal stream with live color-coded SteamCMD stdout/stderr and interactive command prompt (`status`, `app_status`, `app_info_print`).
- 📱 **Steam Guard QR Code Sign-in**: Scan once from your official Steam Mobile app. Authenticates seamlessly, extracts persistent machine sentry files (`ssfn*`), and automatically refreshes access tokens so you never sign in repeatedly.
- 🕹️ **Pre-bundled Goldberg Steam Emulator**: Bundled DRM-free offline wrapper binaries (`steam_api.dll` and `steam_api64.dll`). Supports 1-click Apply/Revert controls per game and automatic batch patching post-download.
- 🗄️ **NAS Storage & Directory Manager**: Color-coded visual breakdown of NAS disk space, directory scanner for all downloaded games in `/downloads`, actual folder size metrics, manifest inspection, and safe 1-click uninstallation.
- 🏬 **Steam Store & Depot Explorer**: Search any game, mod, or dedicated server tool across the entire Steam catalog and queue downloads directly.
- 🔊 **Valve Audio Synthesizer**: Authentic Steam UI audio feedback (hover ticks, navigation chimes, modal pops, and download completion fanfare) generated via the HTML5 Web Audio API with zero external media files.
- 🧹 **Automated Directory Flattening**: Removes nested `steamapps/common/<Game>` directories, flattens game files to the root install folder, preserves `appmanifest_<appid>.acf`, and renames `_CommonRedist` to `Redistrutables`.
- 🛡️ **True NAS Permission Management**: Full `PUID`, `PGID`, and `UMASK` support guarantees seamless read/write permissions for Unraid, Synology, TrueNAS, and QNAP.

---

## 🚀 Quick Setup with Docker Compose

Create a `docker-compose.yml` file on your NAS or server:

```yaml
services:
  vaporfetch:
    image: ghcr.io/theretrogeekyt-dev/vaporfetch:latest
    container_name: vaporfetch
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      - PUID=1000                  # Your NAS user ID (run: id -u)
      - PGID=1000                  # Your NAS group ID (run: id -g)
      - UMASK=002                  # Group-writable permissions
      - STEAM_API_KEY=             # Optional: https://steamcommunity.com/dev/apikey
      - FORCE_PLATFORM=windows     # Downloads Windows depots for Proton/NAS game shares
    volumes:
      - ./data:/app/data           # Stores auth tokens, settings, and Steam sentry files
      - /mnt/storage/games:/downloads  # Mount path to your NAS game share
      - /var/run/docker.sock:/var/run/docker.sock # Optional: 1-click in-app container updates
```

Launch the container:

```bash
docker compose up -d
```

Open your browser to: **`http://<nas-ip>:8080`**

---

## 📦 Single `docker run` Command

```bash
docker run -d \
  --name vaporfetch \
  --restart unless-stopped \
  -p 8080:8080 \
  -e PUID=1000 \
  -e PGID=1000 \
  -e UMASK=002 \
  -e FORCE_PLATFORM=windows \
  -v /path/to/nas/data:/app/data \
  -v /path/to/nas/games:/downloads \
  ghcr.io/theretrogeekyt-dev/vaporfetch:latest
```

---

## ⚙️ Environment Variables Reference

| Variable | Default | Description |
|---|---|---|
| `PUID` | `1000` | User ID for downloaded files on host storage (use `99` on Unraid) |
| `PGID` | `1000` | Group ID for downloaded files on host storage (use `100` on Unraid) |
| `UMASK` | `002` | File creation mask (`002` allows group write permissions) |
| `FORCE_PLATFORM` | `windows` | Depot platform (`windows`, `linux`, `macos`) |
| `STEAM_API_KEY` | *(empty)* | Optional Steam Web API Key for private profile libraries |
| `DATA_DIR` | `/app/data` | Container path for persistent tokens and configurations |
| `DOWNLOAD_DIR` | `/downloads` | Container path where games are downloaded and organized |

---

## 🏛️ Project Architecture

```
VaporFetch/
├── .github/
│   └── workflows/
│       └── docker-publish.yml   # Multi-arch automated CI/CD container build
├── Dockerfile                   # Debian Bookworm with 32-bit SteamCMD & Goldberg
├── docker-compose.yml           # Compose specification with NAS mounts
├── entrypoint.sh                # Non-root permission dropper & credential sync
├── requirements.txt             # Lightweight Python dependencies
├── README.md                    # Valve documentation & instructions
└── app/
    ├── __init__.py              # Application package marker
    ├── main.py                  # FastAPI REST API, SSE telemetry & console handler
    ├── auth.py                  # Steam Guard QR session manager & token refresh
    ├── steam_api.py             # Steam Web API, Storefront details, news, & search
    ├── steam_session.py         # Persistent interactive SteamCMD session manager
    ├── steamcmd_auth.py         # Device machine authorization manager
    ├── queue_manager.py         # Sequential batch download queue & post-processor
    ├── storage.py               # NAS storage calculation & installed games scanner
    ├── goldberg.py              # Goldberg Steam Emulator patcher & restoration
    ├── updater.py               # In-app Docker socket container recreation manager
    ├── config.py                # System settings & persistent credential syncing
    ├── assets/
    │   └── goldberg/            # Pre-bundled offline emulator DLLs
    │       ├── steam_api.dll
    │       └── steam_api64.dll
    └── static/
        ├── index.html           # Valve Steam Desktop & Steam Deck client interface
        ├── valve-theme.css      # Authentic Steam Desktop styling & Motiva palette
        ├── steam-deck.css       # SteamOS 3 / Big Picture Mode Panorama styles
        ├── valve-sound.js       # HTML5 Web Audio API sound synthesizer
        └── valve-app.js         # Client controller, dual-speed chart, & gamepad input
```

---

## 📜 License

Distributed under the MIT License. Steam, Steam Deck, and Valve are registered trademarks of Valve Corporation. This project is an independent community development not affiliated with Valve Corporation.

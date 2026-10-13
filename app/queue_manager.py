import re
import os
import time
import json
import uuid
import shutil
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional, Set
from pydantic import BaseModel, Field

from app.config import (
    DOWNLOAD_DIR,
    DATA_DIR,
    STEAM_HOME_DIR,
    STEAMCMD_BIN,
    load_settings,
    save_settings,
    sync_steam_credentials,
    has_steam_credentials,
    configure_steam_autologin
)
from app.auth import auth_manager
from app.steam_session import steam_session

QUEUE_FILE = DATA_DIR / "queue.json"

PROGRESS_REGEX = re.compile(
    r"Update state \((0x[0-9a-fA-F]+)\)\s+([a-zA-Z\s]+),\s+progress:\s+([0-9.]+)\s+\((\d+)\s*\/\s*(\d+)\)"
)

def sanitize_filename(name: str) -> str:
    """Sanitizes directory names to prevent illegal filesystem characters."""
    sanitized = re.sub(r'[\\/*?:"<>|]', "", name).strip()
    return sanitized or "SteamGame"

async def post_process_game_directory(
    install_path: Path,
    appid: int = 0,
    log_tail: Optional[List[str]] = None,
    require_goldberg: bool = False
):
    """
    Post-processes downloaded game directory:
    1. Flattens nested steamapps/common/<Game> hierarchy into install_path root.
    2. Moves any appmanifest_*.acf into install_path root and removes the steamapps folder.
    3. Renames any CommonRedist / _CommonRedist folder to 'Redistrutables'.
    4. Applies Goldberg Steam Emulator wrapper if enabled or requested.
    """
    def log(msg: str):
        if log_tail is not None:
            log_tail.append(f"[PostProcess] {msg}")

    # Step 1: Flatten steamapps folder
    steamapps_dirs = [
        item for item in install_path.iterdir()
        if item.is_dir() and item.name.lower() in ("steamapps", "steam apps")
    ]

    for s_dir in steamapps_dirs:
        common_dir = None
        for sub in s_dir.iterdir():
            if sub.is_dir() and sub.name.lower() == "common":
                common_dir = sub
            elif sub.is_file() and sub.name.startswith("appmanifest_"):
                target_manifest = install_path / sub.name
                if not target_manifest.exists():
                    try:
                        shutil.move(str(sub), str(target_manifest))
                    except Exception:
                        pass

        if common_dir and common_dir.exists():
            common_entries = list(common_dir.iterdir())
            if len(common_entries) == 1 and common_entries[0].is_dir():
                game_subfolder = common_entries[0]
                log(f"Flattening '{game_subfolder.name}' directly into '{install_path.name}'...")
                for game_item in list(game_subfolder.iterdir()):
                    dest = install_path / game_item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest, ignore_errors=True)
                        else:
                            dest.unlink(missing_ok=True)
                    shutil.move(str(game_item), str(dest))
            else:
                for common_item in common_entries:
                    dest = install_path / common_item.name
                    if dest.exists():
                        if dest.is_dir():
                            shutil.rmtree(dest, ignore_errors=True)
                        else:
                            dest.unlink(missing_ok=True)
                    shutil.move(str(common_item), str(dest))

        log(f"Cleaned '{s_dir.name}' hierarchy.")
        shutil.rmtree(s_dir, ignore_errors=True)

    # Step 2: Rename CommonRedist to Redistrutables
    for root, dirs, files in os.walk(install_path, topdown=False):
        for d_name in list(dirs):
            clean = d_name.lower().replace("_", "").replace("-", "").strip()
            if clean == "commonredist":
                src_dir = Path(root) / d_name
                dest_dir = Path(root) / "Redistrutables"
                if src_dir != dest_dir:
                    log(f"Renamed '{src_dir.name}' to 'Redistrutables'.")
                    if dest_dir.exists():
                        shutil.rmtree(dest_dir, ignore_errors=True)
                    src_dir.rename(dest_dir)

    # Step 3: Apply Goldberg emulator if requested
    settings = load_settings()
    should_apply_goldberg = require_goldberg or settings.get("enable_goldberg", False)
    if should_apply_goldberg and appid > 0:
        from app.goldberg import goldberg_manager
        try:
            await goldberg_manager.ensure_binaries()
            status = goldberg_manager.check_status(install_path)
            if status.get("compatible"):
                account_name = settings.get("steamcmd_username") or "Player"
                res = goldberg_manager.apply(install_path, appid=appid, account_name=account_name)
                log(f"Applied Goldberg offline wrapper ({res['patched_count']} DLLs patched). Original saved to .orig.")
            else:
                log(f"Game '{install_path.name}' does not require Goldberg DLL patching.")
        except Exception as ex:
            log(f"Notice: Goldberg patch step skipped ({ex}). Authentic game files preserved.")

class QueueItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    appid: int
    name: str
    header_url: str = ""
    capsule_url: str = ""
    status: str = "queued"  # queued, running, paused, completed, failed, cancelled
    progress: float = 0.0
    current_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    disk_speed_bps: float = 0.0
    eta_seconds: int = 0
    step: str = "Queued"
    install_dir: str = ""
    error: Optional[str] = None
    require_goldberg: bool = False
    created_at: float = Field(default_factory=time.time)
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    log_tail: List[str] = Field(default_factory=list)

class DownloadQueueManager:
    def __init__(self):
        self.items: List[QueueItem] = []
        self.active_process: Optional[asyncio.subprocess.Process] = None
        self.active_item: Optional[QueueItem] = None
        self._subscribers: Set[asyncio.Queue] = set()
        self._worker_task: Optional[asyncio.Task] = None
        self._paused: bool = False
        self._load_queue()

    def _load_queue(self):
        if QUEUE_FILE.exists():
            try:
                with open(QUEUE_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    for item_dict in data:
                        if item_dict.get("status") == "running":
                            item_dict["status"] = "queued"
                            item_dict["step"] = "Queued (interrupted)"
                        self.items.append(QueueItem(**item_dict))
            except Exception as e:
                print(f"[QueueManager] Failed to load queue file: {e}")

    def _save_queue(self):
        try:
            with open(QUEUE_FILE, "w", encoding="utf-8") as f:
                json.dump([item.model_dump() for item in self.items], f, indent=2)
        except Exception as e:
            print(f"[QueueManager] Failed to save queue: {e}")

    def start_worker(self):
        if self._worker_task is None or self._worker_task.done():
            self._worker_task = asyncio.create_task(self._process_queue_loop())

    async def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue()
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        self._subscribers.discard(q)

    async def broadcast(self, event_type: str, data: Any):
        msg = json.dumps({"event": event_type, "data": data})
        dead_queues = []
        for q in self._subscribers:
            try:
                q.put_nowait(msg)
            except Exception:
                dead_queues.append(q)
        for dq in dead_queues:
            self._subscribers.discard(dq)

    def add_to_queue(self, games: List[Dict[str, Any]], require_goldberg: bool = False) -> List[QueueItem]:
        """Adds a list of games to the sequential batch queue."""
        added = []
        for g in games:
            appid = int(g["appid"])
            name = str(g.get("name", f"App {appid}"))
            header_url = g.get("header_url") or f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"
            capsule_url = g.get("capsule_url") or f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"

            # Check for existing active/queued item
            existing = next((i for i in self.items if i.appid == appid and i.status in ("queued", "running")), None)
            if existing:
                continue

            item = QueueItem(
                appid=appid,
                name=name,
                header_url=header_url,
                capsule_url=capsule_url,
                status="queued",
                step="Queued in batch",
                require_goldberg=require_goldberg,
            )
            self.items.append(item)
            added.append(item)

        self._save_queue()
        self.start_worker()
        return added

    def remove_from_queue(self, item_id: str) -> bool:
        """Removes or cancels a queue item."""
        for idx, item in enumerate(self.items):
            if item.id == item_id:
                if item.status == "running":
                    try:
                        asyncio.create_task(steam_session.terminate_session())
                    except Exception:
                        pass
                    item.status = "cancelled"
                    item.step = "Cancelled by user"
                else:
                    self.items.pop(idx)
                self._save_queue()
                return True
        return False

    def move_priority(self, item_id: str, direction: str) -> bool:
        """Moves a queued item up or down in queue priority."""
        queued_items = [i for i in self.items if i.status == "queued"]
        idx = next((i for i, item in enumerate(queued_items) if item.id == item_id), -1)
        if idx == -1:
            return False

        if direction == "up" and idx > 0:
            target_a = queued_items[idx]
            target_b = queued_items[idx - 1]
            # Swap in main items list
            i_a = self.items.index(target_a)
            i_b = self.items.index(target_b)
            self.items[i_a], self.items[i_b] = self.items[i_b], self.items[i_a]
            self._save_queue()
            return True
        elif direction == "down" and idx < len(queued_items) - 1:
            target_a = queued_items[idx]
            target_b = queued_items[idx + 1]
            i_a = self.items.index(target_a)
            i_b = self.items.index(target_b)
            self.items[i_a], self.items[i_b] = self.items[i_b], self.items[i_a]
            self._save_queue()
            return True
        return False

    def retry_item(self, item_id: str) -> bool:
        """Resets a failed or cancelled item back to queued."""
        for item in self.items:
            if item.id == item_id and item.status in ("failed", "cancelled", "completed"):
                item.status = "queued"
                item.step = "Queued for retry"
                item.progress = 0.0
                item.error = None
                item.log_tail.clear()
                self._save_queue()
                self.start_worker()
                return True
        return False

    def clear_completed(self):
        """Clears completed and cancelled items from queue history."""
        self.items = [i for i in self.items if i.status in ("queued", "running")]
        self._save_queue()

    def get_summary(self) -> Dict[str, Any]:
        return {
            "items": [item.model_dump() for item in self.items],
            "active_id": self.active_item.id if self.active_item else None,
            "paused": self._paused,
        }

    async def _process_queue_loop(self):
        while True:
            if self._paused:
                await asyncio.sleep(1.0)
                continue

            next_item = next((i for i in self.items if i.status == "queued"), None)
            if not next_item:
                self.active_item = None
                break

            self.active_item = next_item
            await self._run_download(next_item)
            self._save_queue()
            await self.broadcast("queue_update", self.get_summary())
            await asyncio.sleep(1.0)

    async def _run_download(self, item: QueueItem):
        settings = load_settings()
        safe_name = sanitize_filename(item.name)
        install_path = DOWNLOAD_DIR / safe_name
        install_path.mkdir(parents=True, exist_ok=True)

        item.status = "running"
        item.started_at = time.time()
        item.install_dir = str(install_path)
        item.step = "Allocating Disk Space"
        item.log_tail.append(f"Starting Steam download for {item.name} (AppID: {item.appid})...")
        item.log_tail.append(f"Destination: {install_path}")
        self._save_queue()
        await self.broadcast("item_update", item.model_dump())

        platform_type = settings.get("force_platform", "windows")
        username = settings.get("steamcmd_username", "").strip()
        password = settings.get("steamcmd_password", "").strip()
        validate = settings.get("validate_downloads", True)
        custom_args = settings.get("custom_steamcmd_args", "").strip()

        session = auth_manager.get_session()
        if not username and session:
            username = session.get("account_name", "").strip()

        last_bytes = 0
        last_time = time.time()

        def on_log(line: str):
            item.log_tail.append(line)
            if len(item.log_tail) > 100:
                item.log_tail.pop(0)
            asyncio.create_task(self.broadcast("item_log", {
                "id": item.id,
                "line": line,
                "progress": item.progress,
                "step": item.step,
                "speed_bps": item.speed_bps,
                "disk_speed_bps": item.disk_speed_bps,
                "eta_seconds": item.eta_seconds,
                "current_bytes": item.current_bytes,
                "total_bytes": item.total_bytes,
            }))

        def on_progress(pct: float, cur_b: int, tot_b: int, step_name: str):
            nonlocal last_bytes, last_time
            now = time.time()
            dt = now - last_time
            if dt >= 0.8:
                if cur_b >= last_bytes and dt > 0:
                    net_rate = (cur_b - last_bytes) / dt
                    item.speed_bps = net_rate
                    # Disk write rate is generally correlated with download rate plus unpacking
                    item.disk_speed_bps = net_rate * 1.15
                if item.speed_bps > 0 and tot_b > cur_b:
                    item.eta_seconds = int((tot_b - cur_b) / item.speed_bps)
                else:
                    item.eta_seconds = 0
                last_bytes = cur_b
                last_time = now

            item.progress = pct
            item.current_bytes = cur_b
            item.total_bytes = tot_b
            item.step = step_name
            asyncio.create_task(self.broadcast("item_update", item.model_dump()))

        try:
            item.step = "Connecting SteamCMD"
            await self.broadcast("item_update", item.model_dump())

            await steam_session.run_download_job(
                appid=item.appid,
                install_path=install_path,
                platform_type=platform_type,
                validate=validate,
                custom_args=custom_args,
                username=username,
                password=password,
                log_callback=on_log,
                progress_callback=on_progress
            )

            item.step = "Cleaning directory structure"
            await post_process_game_directory(
                install_path,
                appid=item.appid,
                log_tail=item.log_tail,
                require_goldberg=item.require_goldberg
            )
            item.status = "completed"
            item.progress = 100.0
            item.step = "Download Complete"
            item.completed_at = time.time()
            item.log_tail.append(f"Successfully finished {item.name} in {install_path}.")

        except asyncio.CancelledError:
            item.status = "cancelled"
            item.step = "Cancelled by user"
            item.log_tail.append("Download cancelled by user.")
            await steam_session.terminate_session()
        except Exception as ex:
            if item.status == "cancelled":
                item.step = "Cancelled by user"
                item.log_tail.append("Download cancelled by user.")
            else:
                item.status = "failed"
                item.error = str(ex)
                item.step = "Download Failed"
                item.log_tail.append(f"Download failed: {ex}")
        finally:
            self.active_process = None
            self._save_queue()
            await self.broadcast("item_update", item.model_dump())

queue_manager = DownloadQueueManager()

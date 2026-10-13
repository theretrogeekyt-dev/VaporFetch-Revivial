import os
import json
import time
import shutil
import asyncio
from pathlib import Path
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.config import (
    DOWNLOAD_DIR,
    DATA_DIR,
    STEAMCMD_BIN,
    APP_VERSION,
    APP_COMMIT_SHA,
    load_settings,
    save_settings
)
from app.auth import auth_manager
from app.steam_api import steam_api_client
from app.queue_manager import queue_manager
from app.steamcmd_auth import steamcmd_auth_manager
from app.steam_session import steam_session
from app.storage import storage_manager
from app.goldberg import goldberg_manager
from app.updater import container_updater

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Resume any queued downloads upon container startup
    queue_manager.start_worker()
    # Check Goldberg emulator binaries in background
    asyncio.create_task(goldberg_manager.ensure_binaries())
    yield
    # Terminate persistent SteamCMD session cleanly on container stop
    await steam_session.terminate_session()

app = FastAPI(
    title="VaporFetch",
    version=APP_VERSION,
    description="Valve-Authentic Steam NAS Batch Downloader",
    lifespan=lifespan
)

STATIC_DIR = Path(__file__).resolve().parent / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Request Models
class PollRequest(BaseModel):
    client_id: str
    request_id: str

class QueueAddRequest(BaseModel):
    games: List[Dict[str, Any]]
    require_goldberg: Optional[bool] = False

class SteamCmdAuthRequest(BaseModel):
    username: Optional[str] = None
    password: Optional[str] = None
    api_key: Optional[str] = None

class SteamCmdCodeRequest(BaseModel):
    code: str

class ConsoleCommandRequest(BaseModel):
    command: str

class PriorityChangeRequest(BaseModel):
    direction: str  # "up" or "down"

class SettingsUpdateRequest(BaseModel):
    steam_api_key: Optional[str] = None
    force_platform: Optional[str] = None
    validate_downloads: Optional[bool] = None
    enable_goldberg: Optional[bool] = None
    steamcmd_username: Optional[str] = None
    steamcmd_password: Optional[str] = None
    steamcmd_authorized: Optional[bool] = None
    custom_steamcmd_args: Optional[str] = None
    ui_sound_enabled: Optional[bool] = None
    ui_theme_mode: Optional[str] = None

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return HTMLResponse(content=index_file.read_text(encoding="utf-8"))
    return HTMLResponse("<h1>VaporFetch is initializing...</h1>")

# ---------------- Authentication Endpoints ---------------- #

@app.post("/api/auth/qr/begin")
async def begin_qr_auth():
    try:
        data = await auth_manager.begin_qr_auth()
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to begin QR auth session: {str(e)}")

@app.post("/api/auth/qr/poll")
async def poll_qr_auth(req: PollRequest):
    try:
        result = await auth_manager.poll_qr_auth(req.client_id, req.request_id)
        if result.get("status") == "confirmed":
            session = result.get("session", {})
            steamid = session.get("steamid")
            if steamid:
                profile = await steam_api_client.get_player_summary(
                    steamid=steamid,
                    access_token=session.get("access_token")
                )
                if profile:
                    session.update(profile)
                    auth_manager._current_session = session
                    auth_manager._save_persisted_session()
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Polling QR auth failed: {str(e)}")

@app.get("/api/auth/session")
async def get_session():
    session = auth_manager.get_session()
    settings = load_settings()
    has_password = bool(settings.get("steamcmd_password"))
    auth_status = steamcmd_auth_manager.get_status()
    steamcmd_authorized = auth_status["authorized"]

    if not session:
        if steamcmd_authorized and settings.get("steamcmd_username"):
            from app.config import extract_account_info_from_loginusers
            acc_info = extract_account_info_from_loginusers(settings.get("steamcmd_username"))
            if acc_info and acc_info.get("steamid"):
                session = {
                    "authenticated": True,
                    "account_name": settings.get("steamcmd_username"),
                    "steamid": acc_info["steamid"],
                    "personaname": acc_info.get("personaname", settings.get("steamcmd_username")),
                    "login_time": int(time.time()),
                }
                auth_manager._current_session = session
                auth_manager._save_persisted_session()

        if not session:
            return {
                "authenticated": False,
                "has_password": has_password,
                "steamcmd_authorized": steamcmd_authorized,
                "setup_complete": False
            }

    if "personaname" not in session and session.get("steamid"):
        profile = await steam_api_client.get_player_summary(
            steamid=session["steamid"],
            access_token=session.get("access_token")
        )
        if profile:
            session.update(profile)
            auth_manager._current_session = session
            auth_manager._save_persisted_session()

    return {
        "authenticated": True,
        "session": session,
        "has_password": has_password,
        "steamcmd_authorized": steamcmd_authorized,
        "setup_complete": bool(session.get("authenticated") and (has_password or steamcmd_authorized))
    }

@app.post("/api/auth/logout")
async def logout():
    auth_manager.logout()
    return {"success": True}

# SteamCMD Device Authorization Endpoints
@app.get("/api/auth/steamcmd/status")
async def get_steamcmd_auth_status():
    return steamcmd_auth_manager.get_status()

@app.post("/api/auth/steamcmd/authorize")
async def start_steamcmd_auth(req: SteamCmdAuthRequest):
    try:
        if req.api_key and req.api_key.strip():
            save_settings({"steam_api_key": req.api_key.strip()})
        status = await steamcmd_auth_manager.start_authorization(username=req.username, password=req.password)
        return status
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to start SteamCMD authorization: {e}")

@app.post("/api/auth/steamcmd/code")
async def submit_steamcmd_code(req: SteamCmdCodeRequest):
    try:
        status = await steamcmd_auth_manager.send_code(req.code)
        return status
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send code: {e}")

@app.post("/api/auth/steamcmd/cancel")
async def cancel_steamcmd_auth():
    steamcmd_auth_manager.cancel()
    return {"success": True}

# ---------------- Library & Storefront Endpoints ---------------- #

@app.get("/api/games")
async def get_owned_games():
    session = auth_manager.get_session()
    if not session or not session.get("steamid"):
        raise HTTPException(status_code=401, detail="User is not authenticated with Steam.")

    steamid = session["steamid"]
    access_token = session.get("access_token")

    try:
        games = await steam_api_client.get_owned_games(
            steamid=steamid,
            access_token=access_token
        )
        return {"count": len(games), "games": games}
    except PermissionError:
        new_token = await auth_manager.refresh_access_token()
        if new_token:
            try:
                games = await steam_api_client.get_owned_games(
                    steamid=steamid,
                    access_token=new_token
                )
                return {"count": len(games), "games": games}
            except Exception:
                pass

        cached = steam_api_client.get_cached_games()
        if cached:
            return {"count": len(cached), "games": cached, "cached": True}

        raise HTTPException(
            status_code=403,
            detail="Steam Web API request unauthorized. Please enter your Steam Web API Key in Settings or set profile games to public."
        )
    except Exception as e:
        cached = steam_api_client.get_cached_games()
        if cached:
            return {"count": len(cached), "games": cached, "cached": True}
        raise HTTPException(status_code=500, detail=f"Failed to fetch games library: {str(e)}")

@app.get("/api/games/{appid}/details")
async def get_app_details(appid: int):
    details = await steam_api_client.get_app_details(appid)
    if not details:
        raise HTTPException(status_code=404, detail="Store details not found for this AppID.")
    return details

@app.get("/api/games/{appid}/news")
async def get_app_news(appid: int):
    news = await steam_api_client.get_app_news(appid)
    return {"appid": appid, "news": news}

@app.get("/api/store/search")
async def search_store(q: str):
    results = await steam_api_client.search_store(q)
    return {"count": len(results), "results": results}

# ---------------- Queue & Downloader Endpoints ---------------- #

@app.get("/api/queue")
async def get_queue():
    return queue_manager.get_summary()

@app.post("/api/queue")
async def add_to_queue(req: QueueAddRequest):
    if not req.games:
        raise HTTPException(status_code=400, detail="No games specified.")
    added = queue_manager.add_to_queue(req.games, require_goldberg=bool(req.require_goldberg))
    return {"added_count": len(added), "added": [i.model_dump() for i in added]}

@app.delete("/api/queue/{item_id}")
async def delete_queue_item(item_id: str):
    removed = queue_manager.remove_from_queue(item_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Item not found in queue.")
    return {"success": True}

@app.post("/api/queue/{item_id}/priority")
async def change_queue_priority(item_id: str, req: PriorityChangeRequest):
    success = queue_manager.move_priority(item_id, req.direction)
    if not success:
        raise HTTPException(status_code=400, detail="Could not move item priority.")
    return {"success": True}

@app.post("/api/queue/{item_id}/retry")
async def retry_queue_item(item_id: str):
    retried = queue_manager.retry_item(item_id)
    if not retried:
        raise HTTPException(status_code=404, detail="Item not found or cannot be retried.")
    return {"success": True}

@app.post("/api/queue/clear-completed")
async def clear_completed_queue():
    queue_manager.clear_completed()
    return {"success": True}

@app.get("/api/queue/stream")
async def stream_queue(request: Request):
    """Server-Sent Events (SSE) live telemetry stream providing real-time download and console data."""
    sub_queue = await queue_manager.subscribe()

    async def event_generator():
        try:
            init_msg = {"event": "queue_update", "data": queue_manager.get_summary()}
            yield f"data: {json.dumps(init_msg)}\n\n"

            while True:
                if await request.is_disconnected():
                    break
                try:
                    msg = await asyncio.wait_for(sub_queue.get(), timeout=15.0)
                    yield f"data: {msg}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            queue_manager.unsubscribe(sub_queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

# ---------------- Valve Developer Console ---------------- #

@app.post("/api/console/execute")
async def execute_console_cmd(req: ConsoleCommandRequest):
    try:
        res = await steam_session.execute_console_command(req.command)
        return {"output": res}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ---------------- Storage & NAS Manager Endpoints ---------------- #

@app.get("/api/storage/status")
async def get_storage_status():
    return storage_manager.get_disk_usage()

@app.get("/api/storage/games")
async def get_installed_games(force: bool = False):
    games = await storage_manager.scan_installed_games(force=force)
    return {"count": len(games), "games": games}

@app.delete("/api/storage/games/{folder_name}")
async def delete_installed_game(folder_name: str):
    deleted = storage_manager.delete_game(folder_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Directory not found or could not be deleted.")
    return {"success": True}

# ---------------- Goldberg Offline Wrapper Endpoints ---------------- #

def _find_game_dir(appid: int) -> Optional[Path]:
    for item in queue_manager.items:
        if item.appid == appid and item.install_dir and Path(item.install_dir).exists():
            return Path(item.install_dir)
    try:
        if DOWNLOAD_DIR.exists():
            for child in DOWNLOAD_DIR.iterdir():
                if not child.is_dir():
                    continue
                if (child / f"appmanifest_{appid}.acf").exists():
                    return child
                appid_file = child / "steam_appid.txt"
                if appid_file.exists():
                    try:
                        if appid_file.read_text(encoding="utf-8", errors="ignore").strip() == str(appid):
                            return child
                    except Exception:
                        pass
    except Exception:
        pass
    return None

@app.get("/api/games/{appid}/goldberg")
async def get_goldberg_status(appid: int):
    target_dir = _find_game_dir(appid)
    if not target_dir or not target_dir.exists():
        raise HTTPException(status_code=404, detail="Game folder not found in /downloads.")
    status = goldberg_manager.check_status(target_dir)
    status["install_dir"] = str(target_dir)
    return status

@app.post("/api/games/{appid}/goldberg/apply")
async def apply_goldberg(appid: int):
    target_dir = _find_game_dir(appid)
    if not target_dir or not target_dir.exists():
        raise HTTPException(status_code=404, detail="Game folder not found in /downloads.")

    settings = load_settings()
    account_name = settings.get("steamcmd_username") or "Player"
    await goldberg_manager.ensure_binaries()

    if not goldberg_manager.is_available():
        raise HTTPException(status_code=500, detail="Goldberg emulator binaries are not available.")

    try:
        return goldberg_manager.apply(target_dir, appid=appid, account_name=account_name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/games/{appid}/goldberg/revert")
async def revert_goldberg(appid: int):
    target_dir = _find_game_dir(appid)
    if not target_dir or not target_dir.exists():
        raise HTTPException(status_code=404, detail="Game folder not found in /downloads.")

    try:
        return goldberg_manager.revert(target_dir)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/goldberg/status")
async def get_goldberg_system_status():
    is_ready = goldberg_manager.is_available()
    return {
        "available": is_ready,
        "dll32_path": str(goldberg_manager.dll32_path) if is_ready else None,
        "dll64_path": str(goldberg_manager.dll64_path) if is_ready else None,
        "data_dir": str(goldberg_manager.dir)
    }

# ---------------- Settings & System Endpoints ---------------- #

@app.get("/api/settings")
async def get_settings():
    settings = load_settings()
    masked = settings.copy()
    if masked.get("steamcmd_password"):
        masked["steamcmd_password"] = "******"
    return masked

@app.post("/api/settings")
async def update_settings(req: SettingsUpdateRequest):
    updates = {}
    if req.steam_api_key is not None:
        updates["steam_api_key"] = req.steam_api_key.strip()
    if req.force_platform is not None:
        updates["force_platform"] = req.force_platform
    if req.validate_downloads is not None:
        updates["validate_downloads"] = req.validate_downloads
    if req.enable_goldberg is not None:
        updates["enable_goldberg"] = req.enable_goldberg
    if req.steamcmd_username is not None:
        updates["steamcmd_username"] = req.steamcmd_username.strip()
    if req.steamcmd_password is not None and req.steamcmd_password != "******":
        updates["steamcmd_password"] = req.steamcmd_password
    if req.steamcmd_authorized is not None:
        updates["steamcmd_authorized"] = req.steamcmd_authorized
    if req.custom_steamcmd_args is not None:
        updates["custom_steamcmd_args"] = req.custom_steamcmd_args.strip()
    if req.ui_sound_enabled is not None:
        updates["ui_sound_enabled"] = req.ui_sound_enabled
    if req.ui_theme_mode is not None:
        updates["ui_theme_mode"] = req.ui_theme_mode

    updated = save_settings(updates)
    masked = updated.copy()
    if masked.get("steamcmd_password"):
        masked["steamcmd_password"] = "******"
    return masked

@app.get("/api/system/status")
async def get_system_status():
    disk = storage_manager.get_disk_usage()
    return {
        "download_dir": str(DOWNLOAD_DIR),
        "data_dir": str(DATA_DIR),
        "steamcmd_bin": STEAMCMD_BIN,
        "disk": disk,
        "puid": os.getenv("PUID", "1000"),
        "pgid": os.getenv("PGID", "1000"),
    }

@app.get("/api/system/version")
async def get_system_version():
    return {
        "version": APP_VERSION,
        "commit": APP_COMMIT_SHA,
        "short_commit": APP_COMMIT_SHA[:7] if APP_COMMIT_SHA != "dev" else "dev",
        "is_dev": APP_COMMIT_SHA.lower() in ("dev", "", "unknown"),
        "docker_socket_available": container_updater.is_docker_socket_available(),
    }

@app.get("/api/system/update/check")
async def check_container_update(force: bool = False):
    return await container_updater.check_for_updates(force=force)

@app.post("/api/system/update/apply")
async def apply_container_update():
    try:
        return await container_updater.apply_update()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

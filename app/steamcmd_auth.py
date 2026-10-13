import asyncio
import time
from pathlib import Path
from typing import Optional, Dict, Any, List

from app.config import (
    STEAM_HOME_DIR,
    load_settings,
    save_settings,
    sync_steam_credentials,
    has_steam_credentials,
    extract_account_info_from_loginusers
)
from app.steam_session import steam_session

class SteamCmdAuthManager:
    """
    Manages SteamCMD persistent machine authorization.
    Performs device authorization once and stores sentry files on the NAS
    so user never has to re-authorize again.
    """
    def __init__(self):
        self.state: str = "idle"  # idle, starting, waiting_approval, waiting_code, success, error
        self.status_message: str = ""
        self.log_lines: List[str] = []
        self._auth_task: Optional[asyncio.Task] = None

    def get_status(self) -> Dict[str, Any]:
        settings = load_settings()
        sync_steam_credentials()
        sentry_files = list(STEAM_HOME_DIR.glob("ssfn*"))

        session_stat = steam_session.get_status()
        is_authorized = steam_session.is_ready() or settings.get("steamcmd_authorized", False) or has_steam_credentials()

        if steam_session.is_ready():
            current_state = "success"
            status_msg = "Device authorized and connected! Future downloads will start without prompts."
        elif steam_session.is_alive():
            current_state = session_stat["state"]
            status_msg = session_stat["status_message"]
        else:
            current_state = "success" if is_authorized else self.state
            status_msg = self.status_message or ("Machine is authorized." if is_authorized else "Not authorized.")

        from app.auth import auth_manager
        current_session = auth_manager.get_session()

        return {
            "authorized": is_authorized,
            "connected": steam_session.is_ready(),
            "has_sentry": len(sentry_files) > 0 or is_authorized,
            "sentry_count": len(sentry_files),
            "state": current_state,
            "status_message": status_msg,
            "username": settings.get("steamcmd_username", "") or session_stat.get("username", ""),
            "has_password": bool(settings.get("steamcmd_password")),
            "logs": session_stat["logs"] or self.log_lines[-25:],
            "session": current_session,
        }

    async def start_authorization(self, username: Optional[str] = None, password: Optional[str] = None) -> Dict[str, Any]:
        """Starts device authorization through persistent SteamCMD session."""
        settings = load_settings()
        username = (username or settings.get("steamcmd_username", "")).strip()
        password = (password or settings.get("steamcmd_password", "")).strip()

        if not username:
            raise ValueError("Steam username is required for authorization.")
        if not password:
            raise ValueError("Steam password is required for device authorization.")

        self.state = "starting"
        self.status_message = "Starting SteamCMD authorization..."
        self.log_lines = []

        async def _run_auth():
            def _log(line: str):
                self.log_lines.append(line)
                if len(self.log_lines) > 120:
                    self.log_lines.pop(0)

            try:
                await steam_session.ensure_session(username, password, log_callback=_log)
                self.state = "success"
                self.status_message = "Device authorized successfully! Saved to NAS persistent storage."
                save_settings({
                    "steamcmd_authorized": True,
                    "steamcmd_username": username,
                    "steamcmd_password": password
                })
                sync_steam_credentials()

                account_info = extract_account_info_from_loginusers(username)
                steamid = account_info.get("steamid", "") if account_info else ""
                persona = account_info.get("personaname", username) if account_info else username

                from app.auth import auth_manager
                session_data = {
                    "authenticated": True,
                    "account_name": username,
                    "steamid": steamid,
                    "personaname": persona,
                    "login_time": int(time.time()),
                }

                if steamid:
                    try:
                        from app.steam_api import steam_api_client
                        profile = await steam_api_client.get_player_summary(steamid=steamid)
                        if profile:
                            session_data.update(profile)
                    except Exception as ex:
                        print(f"[SteamCmdAuth] Error getting player summary: {ex}")

                auth_manager._current_session = session_data
                auth_manager._save_persisted_session()
            except Exception as e:
                self.state = "error"
                self.status_message = str(e)

        if self._auth_task and not self._auth_task.done():
            self._auth_task.cancel()

        self._auth_task = asyncio.create_task(_run_auth())
        return self.get_status()

    async def send_code(self, code: str) -> Dict[str, Any]:
        """Sends a 2FA Steam Guard code to the running SteamCMD session."""
        await steam_session.submit_steam_guard_code(code)
        return self.get_status()

    def cancel(self):
        """Cancels running authorization process."""
        if self._auth_task and not self._auth_task.done():
            self._auth_task.cancel()
        asyncio.create_task(steam_session.terminate_session())
        self.state = "idle"
        self.status_message = "Authorization cancelled."

steamcmd_auth_manager = SteamCmdAuthManager()


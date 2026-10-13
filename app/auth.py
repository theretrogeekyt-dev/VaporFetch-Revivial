import io
import json
import base64
import time
import httpx
import qrcode
from pathlib import Path
from typing import Optional, Dict, Any

from app.config import DATA_DIR, load_settings, save_settings

SESSION_FILE = DATA_DIR / "session.json"
STEAM_AUTH_API_BASE = "https://api.steampowered.com/IAuthenticationService"

class SteamAuthManager:
    """
    Manages official Steam Guard QR Code authentication sessions,
    token refreshing, and user session persistence.
    """
    def __init__(self):
        self._current_session: Optional[Dict[str, Any]] = None
        self._load_persisted_session()

    def _load_persisted_session(self):
        if SESSION_FILE.exists():
            try:
                with open(SESSION_FILE, "r", encoding="utf-8") as f:
                    self._current_session = json.load(f)
            except Exception:
                self._current_session = None

    def _save_persisted_session(self):
        if self._current_session:
            with open(SESSION_FILE, "w", encoding="utf-8") as f:
                json.dump(self._current_session, f, indent=2)
        elif SESSION_FILE.exists():
            SESSION_FILE.unlink(missing_ok=True)

    def get_session(self) -> Optional[Dict[str, Any]]:
        return self._current_session

    def logout(self):
        self._current_session = None
        self._save_persisted_session()

    @staticmethod
    def _decode_jwt_payload(jwt_token: str) -> Dict[str, Any]:
        """Safely decodes the payload of a Steam JWT without signature verification."""
        try:
            parts = jwt_token.split(".")
            if len(parts) >= 2:
                payload_b64 = parts[1]
                payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
                payload_bytes = base64.urlsafe_b64decode(payload_b64)
                return json.loads(payload_bytes.decode("utf-8"))
        except Exception:
            pass
        return {}

    @staticmethod
    def generate_qr_data_url(data_str: str) -> str:
        """Generates a high-contrast base64 Data URL PNG of a QR code."""
        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=8,
            border=2,
        )
        qr.add_data(data_str)
        qr.make(fit=True)
        img = qr.make_image(fill_color="#0e141b", back_color="#ffffff")
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        b64_img = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/png;base64,{b64_img}"

    async def begin_qr_auth(self) -> Dict[str, Any]:
        """
        Initiates a Steam Guard QR Authentication session via Steam's IAuthenticationService.
        """
        url = f"{STEAM_AUTH_API_BASE}/BeginAuthSessionViaQR/v1"
        data = {
            "device_friendly_name": "VaporFetch Steam Client",
            "platform_type": 2,  # 2 = WebBrowser / Client
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(url, data=data)
            res.raise_for_status()
            payload = res.json().get("response", {})

        client_id = str(payload.get("client_id"))
        challenge_url = payload.get("challenge_url", "")
        request_id = payload.get("request_id", "")
        interval = payload.get("interval", 5)

        if not challenge_url:
            raise ValueError("Steam did not return a challenge_url for QR authentication.")

        qr_data_url = self.generate_qr_data_url(challenge_url)

        return {
            "client_id": client_id,
            "challenge_url": challenge_url,
            "request_id": request_id,
            "interval": interval,
            "qr_data_url": qr_data_url,
        }

    async def poll_qr_auth(self, client_id: str, request_id: str) -> Dict[str, Any]:
        """
        Polls the status of an ongoing QR auth session.
        If user approved on mobile app, extracts account_name, steamid, and tokens.
        """
        url = f"{STEAM_AUTH_API_BASE}/PollAuthSessionStatus/v1"
        data = {
            "client_id": client_id,
            "request_id": request_id,
        }

        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.post(url, data=data)
            res.raise_for_status()
            payload = res.json().get("response", {})

        refresh_token = payload.get("refresh_token")
        access_token = payload.get("access_token")
        account_name = payload.get("account_name")

        if refresh_token:
            jwt_data = self._decode_jwt_payload(refresh_token)
            steamid = str(jwt_data.get("sub", ""))

            if not steamid and access_token:
                jwt_data = self._decode_jwt_payload(access_token)
                steamid = str(jwt_data.get("sub", ""))

            session_data = {
                "authenticated": True,
                "account_name": account_name or "Steam User",
                "steamid": steamid,
                "refresh_token": refresh_token,
                "access_token": access_token or "",
                "login_time": int(time.time()),
            }

            self._current_session = session_data
            self._save_persisted_session()

            # Ensure steamcmd_username in settings is synced
            settings = load_settings()
            if not settings.get("steamcmd_username") and account_name:
                save_settings({"steamcmd_username": account_name})

            return {
                "status": "confirmed",
                "session": session_data,
            }

        had_remote_interaction = payload.get("had_remote_interaction", False)
        return {
            "status": "pending",
            "had_remote_interaction": had_remote_interaction,
        }

    async def refresh_access_token(self) -> Optional[str]:
        """Uses the persisted refresh_token to obtain a fresh access_token without user interaction."""
        if not self._current_session or not self._current_session.get("refresh_token"):
            return None

        refresh_token = self._current_session.get("refresh_token")
        steamid = self._current_session.get("steamid", "")

        url = f"{STEAM_AUTH_API_BASE}/GenerateAccessTokenForApp/v1"
        data = {
            "refresh_token": refresh_token,
            "steamid": steamid,
        }

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                res = await client.post(url, data=data)
                if res.status_code == 200:
                    payload = res.json().get("response", {})
                    new_token = payload.get("access_token")
                    if new_token:
                        self._current_session["access_token"] = new_token
                        if payload.get("refresh_token"):
                            self._current_session["refresh_token"] = payload.get("refresh_token")
                        self._save_persisted_session()
                        return new_token
        except Exception as e:
            print(f"[Auth] Could not refresh access token: {e}")
        return None

auth_manager = SteamAuthManager()


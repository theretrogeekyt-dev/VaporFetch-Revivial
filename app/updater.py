import os
import json
import socket
import urllib.request
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional

from app.config import DATA_DIR, APP_VERSION, APP_COMMIT_SHA, DOCKER_SOCKET_PATH

UPDATE_CACHE_FILE = DATA_DIR / "update_cache.json"
CACHE_TTL_SECONDS = 3600
GITHUB_API_URL = "https://api.github.com/repos/theretrogeekyt-dev/VaporFetch-Revivial/commits/main"

class DockerUnixClient:
    """Lightweight Docker Engine API client communicating over Unix socket."""
    def __init__(self, socket_path: Path = DOCKER_SOCKET_PATH):
        self.socket_path = socket_path

    def is_available(self) -> bool:
        if not self.socket_path.exists():
            return False
        try:
            return self.ping()
        except Exception:
            return False

    def _request(self, method: str, path: str, body: Optional[dict] = None, timeout: int = 30) -> tuple[int, Any]:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(str(self.socket_path))
            body_bytes = json.dumps(body).encode("utf-8") if body else b""
            headers = [
                f"{method} {path} HTTP/1.1",
                "Host: localhost",
                "User-Agent: VaporFetch-Updater/2.0",
                f"Content-Length: {len(body_bytes)}",
            ]
            if body:
                headers.append("Content-Type: application/json")
            headers.append("Connection: close")

            raw_req = "\r\n".join(headers).encode("utf-8") + b"\r\n\r\n" + body_bytes
            sock.sendall(raw_req)

            resp_bytes = b""
            while True:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                resp_bytes += chunk

            header_part, _, content_part = resp_bytes.partition(b"\r\n\r\n")
            first_line = header_part.split(b"\r\n")[0].decode("utf-8", errors="ignore")
            status_code = int(first_line.split()[1]) if len(first_line.split()) > 1 else 500

            try:
                parsed = json.loads(content_part.decode("utf-8", errors="ignore"))
            except Exception:
                parsed = content_part.decode("utf-8", errors="ignore")

            return status_code, parsed
        finally:
            sock.close()

    def ping(self) -> bool:
        status, _ = self._request("GET", "/_ping", timeout=3)
        return status == 200

    def find_container_name(self) -> str:
        hostname = os.getenv("HOSTNAME", "").strip()
        if hostname:
            status, info = self._request("GET", f"/containers/{hostname}/json", timeout=5)
            if status == 200 and isinstance(info, dict) and "Name" in info:
                return info["Name"].lstrip("/")

        status, containers = self._request("GET", "/containers/json", timeout=5)
        if status == 200 and isinstance(containers, list):
            for c in containers:
                names = [n.lstrip("/") for n in c.get("Names", [])]
                for n in names:
                    if "vaporfetch" in n.lower():
                        return n
        return "vaporfetch"

    def pull_image(self, image: str, tag: str = "latest", timeout: int = 180) -> bool:
        path = f"/images/create?fromImage={image}&tag={tag}"
        status, _ = self._request("POST", path, timeout=timeout)
        return status in (200, 201)

    def trigger_watchtower_recreate(self, target_container: str) -> bool:
        self.pull_image("containrrr/watchtower", "latest", timeout=60)
        create_payload = {
            "Image": "containrrr/watchtower:latest",
            "Cmd": ["--run-once", target_container],
            "HostConfig": {
                "Binds": [f"{self.socket_path}:{self.socket_path}"],
                "AutoRemove": True
            }
        }
        status, res = self._request("POST", "/containers/create", body=create_payload, timeout=10)
        if status not in (200, 201) or not isinstance(res, dict) or "Id" not in res:
            return False

        watchtower_id = res["Id"]
        start_status, _ = self._request("POST", f"/containers/{watchtower_id}/start", timeout=10)
        return start_status in (200, 204)

class ContainerUpdater:
    def __init__(self):
        self.docker = DockerUnixClient()

    def is_docker_socket_available(self) -> bool:
        return self.docker.is_available()

    def _load_cache(self) -> Optional[Dict[str, Any]]:
        if not UPDATE_CACHE_FILE.exists():
            return None
        try:
            with open(UPDATE_CACHE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                cached_at = data.get("cached_at", 0)
                now = datetime.now(timezone.utc).timestamp()
                if now - cached_at < CACHE_TTL_SECONDS:
                    return data
        except Exception:
            pass
        return None

    def _save_cache(self, data: Dict[str, Any]):
        try:
            data["cached_at"] = datetime.now(timezone.utc).timestamp()
            with open(UPDATE_CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            print(f"[Updater] Warning saving update cache: {e}")

    async def check_for_updates(self, force: bool = False) -> Dict[str, Any]:
        """Checks GitHub API for the latest commit on main and compares with current."""
        if not force:
            cached = self._load_cache()
            if cached:
                cached["can_auto_update"] = self.is_docker_socket_available()
                return cached

        latest_sha = ""
        commit_message = ""
        commit_date = ""
        commit_url = "https://github.com/theretrogeekyt-dev/VaporFetch-Revivial/commits/main"

        try:
            req = urllib.request.Request(
                GITHUB_API_URL,
                headers={
                    "User-Agent": "VaporFetch-Client/2.0",
                    "Accept": "application/vnd.github.v3+json"
                }
            )
            loop = asyncio.get_running_loop()
            def fetch_api():
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            data = await loop.run_in_executor(None, fetch_api)

            latest_sha = data.get("sha", "")
            commit_obj = data.get("commit", {})
            full_msg = commit_obj.get("message", "")
            commit_message = full_msg.split("\n")[0].strip() if full_msg else "Latest improvements and fixes"
            committer = commit_obj.get("committer", {}) or commit_obj.get("author", {})
            commit_date = committer.get("date", "")
            commit_url = data.get("html_url", commit_url)
        except Exception as e:
            print(f"[Updater] Could not check GitHub for updates: {e}")
            if UPDATE_CACHE_FILE.exists():
                try:
                    with open(UPDATE_CACHE_FILE, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        data["can_auto_update"] = self.is_docker_socket_available()
                        return data
                except Exception:
                    pass

        current_sha = APP_COMMIT_SHA.strip()
        is_dev = current_sha.lower() in ("dev", "", "unknown")

        update_available = False
        if latest_sha and not is_dev:
            update_available = current_sha.lower() != latest_sha.lower()

        result = {
            "current_version": APP_VERSION,
            "current_commit": current_sha,
            "current_short_sha": current_sha[:7] if not is_dev else "dev",
            "is_dev": is_dev,
            "latest_commit": latest_sha,
            "latest_short_sha": latest_sha[:7] if latest_sha else "",
            "commit_message": commit_message,
            "commit_date": commit_date,
            "commit_url": commit_url,
            "update_available": update_available,
            "can_auto_update": self.is_docker_socket_available(),
            "checked_at": datetime.now(timezone.utc).isoformat()
        }

        if latest_sha:
            self._save_cache(result)

        return result

    async def apply_update(self) -> Dict[str, Any]:
        """Triggers container recreation via Docker socket using Watchtower runner."""
        if not self.is_docker_socket_available():
            raise RuntimeError(
                "Docker socket (/var/run/docker.sock) is not mounted into this container."
            )

        container_name = self.docker.find_container_name()
        loop = asyncio.get_running_loop()
        def do_update():
            self.docker.pull_image("ghcr.io/theretrogeekyt-dev/vaporfetch-revivial", "latest", timeout=120)
            return self.docker.trigger_watchtower_recreate(container_name)

        success = await loop.run_in_executor(None, do_update)
        if not success:
            raise RuntimeError("Failed to launch Watchtower updater container via Docker Engine API.")

        return {
            "success": True,
            "message": f"Update triggered for {container_name}. Recreating container..."
        }

container_updater = ContainerUpdater()


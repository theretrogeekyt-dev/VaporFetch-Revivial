import os
import re
import shutil
import asyncio
from pathlib import Path
from typing import List, Dict, Any, Optional

from app.config import DOWNLOAD_DIR, DATA_DIR

def _get_dir_size(path: Path) -> int:
    """Computes total size in bytes of a directory."""
    total = 0
    try:
        for entry in os.scandir(path):
            try:
                if entry.is_file(follow_symlinks=False):
                    total += entry.stat().st_size
                elif entry.is_dir(follow_symlinks=False):
                    total += _get_dir_size(Path(entry.path))
            except Exception:
                pass
    except Exception:
        pass
    return total

def _parse_acf_manifest(manifest_path: Path) -> Dict[str, Any]:
    """Parses a Steam appmanifest_*.acf file into basic metadata."""
    data = {}
    if not manifest_path.exists():
        return data

    try:
        text = manifest_path.read_text(encoding="utf-8", errors="replace")
        for key in ["appid", "name", "installdir", "buildid", "SizeOnDisk", "BytesDownloaded"]:
            m = re.search(rf'"{key}"\s+"([^"]*)"', text, re.IGNORECASE)
            if m:
                val = m.group(1)
                data[key.lower()] = int(val) if val.isdigit() else val
    except Exception as e:
        print(f"[Storage] Error reading {manifest_path}: {e}")
    return data

class StorageManager:
    def __init__(self):
        self._cached_installed_games: List[Dict[str, Any]] = []
        self._last_scan_time: float = 0.0

    def get_disk_usage(self) -> Dict[str, Any]:
        """Returns overall disk usage for the mounted NAS /downloads volume."""
        total, used, free = 0, 0, 0
        pct = 0.0
        try:
            usage = shutil.disk_usage(DOWNLOAD_DIR)
            total = usage.total
            used = usage.used
            free = usage.free
            if total > 0:
                pct = round((used / total) * 100, 1)
        except Exception:
            pass

        return {
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "used_percent": pct,
            "download_path": str(DOWNLOAD_DIR),
        }

    async def scan_installed_games(self, force: bool = False) -> List[Dict[str, Any]]:
        """
        Scans /downloads directory and returns all installed games with metadata,
        sizes, Goldberg patch state, and manifest info.
        """
        if not force and self._cached_installed_games and (asyncio.get_event_loop().time() - self._last_scan_time < 30):
            return self._cached_installed_games

        loop = asyncio.get_running_loop()
        games = await loop.run_in_executor(None, self._scan_sync)
        self._cached_installed_games = games
        self._last_scan_time = asyncio.get_event_loop().time()
        return games

    def _scan_sync(self) -> List[Dict[str, Any]]:
        results = []
        if not DOWNLOAD_DIR.exists():
            return results

        try:
            for item in DOWNLOAD_DIR.iterdir():
                if not item.is_dir():
                    continue

                folder_name = item.name
                if folder_name.startswith(".") or folder_name.lower() in ("steamapps", "temp"):
                    continue

                appid = 0
                name = folder_name
                buildid = ""
                has_manifest = False

                # 1. Search for appmanifest_*.acf
                manifests = list(item.glob("appmanifest_*.acf"))
                if not manifests:
                    manifests = list(item.glob("steamapps/appmanifest_*.acf"))
                if not manifests:
                    manifests = list((DOWNLOAD_DIR / "steamapps").glob(f"appmanifest_*.acf")) if (DOWNLOAD_DIR / "steamapps").exists() else []

                if manifests:
                    m_data = _parse_acf_manifest(manifests[0])
                    if "appid" in m_data:
                        appid = int(m_data["appid"])
                    if "name" in m_data and m_data["name"]:
                        name = str(m_data["name"])
                    if "buildid" in m_data:
                        buildid = str(m_data["buildid"])
                    has_manifest = True

                # 2. Check steam_appid.txt
                if appid == 0:
                    appid_file = item / "steam_appid.txt"
                    if appid_file.exists():
                        try:
                            txt = appid_file.read_text(encoding="utf-8", errors="ignore").strip()
                            if txt.isdigit():
                                appid = int(txt)
                        except Exception:
                            pass

                # 3. Check for Goldberg status
                from app.goldberg import goldberg_manager
                gb_status = goldberg_manager.check_status(item)

                size_bytes = _get_dir_size(item)

                header_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg" if appid > 0 else ""
                capsule_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg" if appid > 0 else ""

                results.append({
                    "folder_name": folder_name,
                    "path": str(item),
                    "appid": appid,
                    "name": name,
                    "buildid": buildid,
                    "has_manifest": has_manifest,
                    "size_bytes": size_bytes,
                    "header_url": header_url,
                    "capsule_url": capsule_url,
                    "goldberg_compatible": gb_status.get("compatible", False),
                    "goldberg_patched": gb_status.get("patched", False),
                })
        except Exception as e:
            print(f"[Storage] Error scanning installed games: {e}")

        results.sort(key=lambda x: x["name"].lower())
        return results

    def delete_game(self, folder_name: str) -> bool:
        """Deletes a game directory from the NAS /downloads directory."""
        clean_name = os.path.basename(folder_name)
        target_dir = DOWNLOAD_DIR / clean_name
        if target_dir.exists() and target_dir.is_dir():
            shutil.rmtree(target_dir, ignore_errors=False)
            self._cached_installed_games = [g for g in self._cached_installed_games if g["folder_name"] != clean_name]
            return True
        return False

storage_manager = StorageManager()


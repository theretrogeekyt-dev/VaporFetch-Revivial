import os
import shutil
import zipfile
import io
import urllib.request
from pathlib import Path
from typing import Dict, Any, List, Optional

from app.config import DATA_DIR, BASE_DIR

# Persistent directory where Goldberg binaries are maintained
GOLDBERG_ASSETS_DIR = Path(os.getenv("GOLDBERG_PATH", str(DATA_DIR / "goldberg")))
GOLDBERG_ASSETS_DIR.mkdir(parents=True, exist_ok=True)

# Release URL fallback list for Goldberg Steam Emulator
GOLDBERG_RELEASE_URLS = [
    "https://gitlab.com/Mr_Goldberg/goldberg_emulator/-/jobs/4247811310/artifacts/download",
]

class GoldbergManager:
    """
    Manages the Goldberg Steam Emulator integration for DRM-free offline play.
    Seamlessly discovers bundled binaries in app/assets/goldberg/ and provisions them to data storage.
    """
    def __init__(self):
        self.dir = GOLDBERG_ASSETS_DIR
        self.bundled_candidates = [
            BASE_DIR / "app" / "assets" / "goldberg",
            BASE_DIR / "assets" / "goldberg",
            Path("/app/app/assets/goldberg"),
            Path("/app/assets/goldberg"),
        ]

    @property
    def dll32_path(self) -> Path:
        target = self.dir / "steam_api.dll"
        if target.exists():
            return target
        for candidate in self.bundled_candidates:
            c = candidate / "steam_api.dll"
            if c.exists():
                return c
        return target

    @property
    def dll64_path(self) -> Path:
        target = self.dir / "steam_api64.dll"
        if target.exists():
            return target
        for candidate in self.bundled_candidates:
            c = candidate / "steam_api64.dll"
            if c.exists():
                return c
        return target

    def is_available(self) -> bool:
        """Returns True if both 32-bit and 64-bit emulator DLLs exist and are readable."""
        return self.dll32_path.exists() and self.dll64_path.exists()

    async def ensure_binaries(self) -> bool:
        """Ensures Goldberg DLLs exist; copies bundled binaries or pulls from mirror if missing."""
        # 1. Check if already available in self.dir or candidate
        if self.is_available():
            try:
                if not (self.dir / "steam_api.dll").exists() and self.dll32_path.exists():
                    shutil.copy2(self.dll32_path, self.dir / "steam_api.dll")
                if not (self.dir / "steam_api64.dll").exists() and self.dll64_path.exists():
                    shutil.copy2(self.dll64_path, self.dir / "steam_api64.dll")
            except Exception as e:
                print(f"[Goldberg] Warning syncing binaries to data directory: {e}")
            return True

        # 2. Check bundled candidates explicitly
        for candidate in self.bundled_candidates:
            c32 = candidate / "steam_api.dll"
            c64 = candidate / "steam_api64.dll"
            if c32.exists() and c64.exists():
                try:
                    shutil.copy2(c32, self.dir / "steam_api.dll")
                    shutil.copy2(c64, self.dir / "steam_api64.dll")
                    return True
                except Exception as e:
                    print(f"[Goldberg] Error copying bundled binaries: {e}")

        # 3. Dynamic scrape from GitLab mirror fallback
        urls_to_try = list(GOLDBERG_RELEASE_URLS)
        try:
            req = urllib.request.Request("https://mr_goldberg.gitlab.io/goldberg_emulator/", headers={"User-Agent": "VaporFetch/2.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                page_text = resp.read().decode("utf-8", errors="ignore")
                import re
                match = re.search(r'href="([^"]*artifacts/download)"', page_text)
                if match:
                    dyn_url = match.group(1)
                    if dyn_url not in urls_to_try:
                        urls_to_try.insert(0, dyn_url)
        except Exception:
            pass

        # 4. Attempt download from mirrors
        for url in urls_to_try:
            try:
                print(f"[Goldberg] Fetching emulator binaries from {url}...")
                req = urllib.request.Request(url, headers={"User-Agent": "VaporFetch/2.0"})
                with urllib.request.urlopen(req, timeout=30) as resp:
                    content = resp.read()
                    with zipfile.ZipFile(io.BytesIO(content)) as zf:
                        for member in zf.namelist():
                            norm = member.lower().replace("\\", "/")
                            if norm.endswith("steam_api.dll") and not norm.endswith("steam_api64.dll"):
                                with zf.open(member) as src, open(self.dir / "steam_api.dll", "wb") as dst:
                                    shutil.copyfileobj(src, dst)
                            elif norm.endswith("steam_api64.dll"):
                                with zf.open(member) as src, open(self.dir / "steam_api64.dll", "wb") as dst:
                                    shutil.copyfileobj(src, dst)
                    if self.is_available():
                        print(f"[Goldberg] Emulator binaries successfully installed into {self.dir}")
                        return True
            except Exception as e:
                print(f"[Goldberg] Mirror download failed ({url}): {e}")

        return self.is_available()

    def check_status(self, game_path: Path) -> Dict[str, Any]:
        """Scans a game directory to verify steam_api DLLs and whether Goldberg is applied."""
        if not game_path.exists():
            return {"compatible": False, "patched": False, "dll_count": 0}

        steam_dlls = []
        is_patched = False

        for root, dirs, files in os.walk(game_path):
            for f in files:
                f_lower = f.lower()
                if f_lower in ("steam_api.dll", "steam_api64.dll"):
                    full_path = Path(root) / f
                    orig_path = Path(root) / f"{f}.orig"
                    steam_dlls.append(str(full_path))
                    if orig_path.exists():
                        is_patched = True

        return {
            "compatible": len(steam_dlls) > 0,
            "patched": is_patched,
            "dll_count": len(steam_dlls),
            "dll_paths": steam_dlls,
            "emulator_ready": self.is_available()
        }

    def apply(self, game_path: Path, appid: int, account_name: str = "Player") -> Dict[str, Any]:
        """
        Applies Goldberg emulator to all steam_api DLLs in the game folder.
        Saves original DLLs as .orig and creates steam_appid.txt.
        """
        if not self.is_available():
            raise FileNotFoundError(
                "Goldberg emulator DLLs (steam_api.dll / steam_api64.dll) are missing."
            )

        if not game_path.exists():
            raise FileNotFoundError(f"Game directory not found: {game_path}")

        patched_list = []

        for root, dirs, files in os.walk(game_path):
            for f in files:
                f_lower = f.lower()
                if f_lower in ("steam_api.dll", "steam_api64.dll"):
                    target_dll = Path(root) / f
                    orig_dll = Path(root) / f"{f}.orig"

                    if not orig_dll.exists():
                        shutil.copy2(target_dll, orig_dll)

                    source_emulator = self.dll64_path if f_lower == "steam_api64.dll" else self.dll32_path
                    shutil.copy2(source_emulator, target_dll)
                    patched_list.append(str(target_dll))

                    appid_file = Path(root) / "steam_appid.txt"
                    appid_file.write_text(str(appid), encoding="utf-8")

                    settings_dir = Path(root) / "steam_settings"
                    settings_dir.mkdir(parents=True, exist_ok=True)
                    (settings_dir / "steam_appid.txt").write_text(str(appid), encoding="utf-8")
                    if account_name:
                        (settings_dir / "force_account_name.txt").write_text(account_name, encoding="utf-8")

        return {
            "success": True,
            "patched_count": len(patched_list),
            "patched_files": patched_list,
            "appid": appid
        }

    def revert(self, game_path: Path) -> Dict[str, Any]:
        """Reverts patched DLLs in the game folder back to authentic .orig copies."""
        if not game_path.exists():
            raise FileNotFoundError(f"Game directory not found: {game_path}")

        restored_list = []

        for root, dirs, files in os.walk(game_path):
            for f in files:
                f_lower = f.lower()
                if f_lower in ("steam_api.dll.orig", "steam_api64.dll.orig"):
                    orig_file = Path(root) / f
                    target_name = f[:-5]  # strip '.orig'
                    target_file = Path(root) / target_name

                    shutil.move(orig_file, target_file)
                    restored_list.append(str(target_file))

                    appid_file = Path(root) / "steam_appid.txt"
                    if appid_file.exists():
                        appid_file.unlink(missing_ok=True)

                    settings_dir = Path(root) / "steam_settings"
                    if settings_dir.exists():
                        shutil.rmtree(settings_dir, ignore_errors=True)

        return {
            "success": True,
            "restored_count": len(restored_list),
            "restored_files": restored_list
        }

goldberg_manager = GoldbergManager()

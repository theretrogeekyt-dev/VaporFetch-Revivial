import os
import re
import json
import time
import shutil
from pathlib import Path
from typing import Optional, Dict, Any, List

# Core Directory Paths
BASE_DIR = Path(__file__).resolve().parent.parent

# Persistent app storage for settings, session tokens, and Steam credentials
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data" if Path("/app/data").exists() else str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# NAS downloads directory where games are installed
DOWNLOAD_DIR = Path(os.getenv("DOWNLOAD_DIR", "/downloads" if Path("/downloads").exists() else str(BASE_DIR / "downloads")))
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

# Application metadata & environment
APP_VERSION = os.getenv("APP_VERSION", "2.0.0")
APP_COMMIT_SHA = os.getenv("APP_COMMIT_SHA", "dev")
DOCKER_SOCKET_PATH = Path(os.getenv("DOCKER_SOCKET_PATH", "/var/run/docker.sock"))

# SteamCMD executable locator
def find_steamcmd() -> str:
    env_path = os.getenv("STEAMCMD_PATH")
    if env_path and Path(env_path).exists():
        return env_path
    candidates = [
        "/usr/games/steamcmd",
        "/steamcmd/steamcmd.sh",
        "/usr/bin/steamcmd",
        shutil.which("steamcmd"),
    ]
    for c in candidates:
        if c and Path(c).exists():
            return str(c)
    return "steamcmd"

STEAMCMD_BIN = find_steamcmd()

# Settings file configuration
SETTINGS_FILE = DATA_DIR / "settings.json"

DEFAULT_SETTINGS = {
    "steam_api_key": os.getenv("STEAM_API_KEY", ""),
    "force_platform": os.getenv("FORCE_PLATFORM", "windows"),  # "windows", "linux", "macos"
    "validate_downloads": True,
    "enable_goldberg": False,
    "steamcmd_username": "",
    "steamcmd_password": "",
    "steamcmd_authorized": False,
    "custom_steamcmd_args": "",
    "ui_sound_enabled": True,
    "ui_theme_mode": "desktop",  # "desktop" or "deck"
}

STEAM_HOME_DIR = DATA_DIR / "steam_home"
STEAM_HOME_DIR.mkdir(parents=True, exist_ok=True)

def sync_steam_credentials():
    """
    Synchronizes Steam Guard sentry files (ssfn*) and Steam config files
    between the active runtime directories and persistent NAS data storage.
    """
    try:
        STEAM_HOME_DIR.mkdir(parents=True, exist_ok=True)
        search_dirs = [
            Path("/steamcmd"),
            Path(os.path.expanduser("~/.steam")),
            Path(os.path.expanduser("~/.steam/steam")),
            Path("/home/steam/.steam"),
            Path("/home/steam/.steam/steam"),
            Path("/home/steam/Steam"),
            Path("/home/steam"),
            STEAM_HOME_DIR,
        ]
        sentry_files = set()
        for d in search_dirs:
            if d.exists() and d.is_dir():
                for f in d.glob("ssfn*"):
                    if f.is_file() and not f.is_symlink():
                        sentry_files.add(f)

        # Copy newly generated sentry files to persistent storage
        for sf in sentry_files:
            dest = STEAM_HOME_DIR / sf.name
            if sf != dest and not dest.exists():
                shutil.copy2(sf, dest)

        # Symlink from persistent storage into runtime directories
        for psf in STEAM_HOME_DIR.glob("ssfn*"):
            if psf.is_file():
                for target_dir in [
                    Path("/steamcmd"),
                    Path("/home/steam/.steam"),
                    Path("/home/steam/.steam/steam"),
                    Path("/home/steam/Steam"),
                ]:
                    try:
                        target_dir.mkdir(parents=True, exist_ok=True)
                        link_path = target_dir / psf.name
                        if not link_path.exists():
                            link_path.symlink_to(psf)
                    except Exception:
                        pass

        # Preserve and mirror config.vdf and loginusers.vdf
        config_sources = [
            Path("/home/steam/Steam/config"),
            Path("/home/steam/.steam/steam/config"),
            Path("/steamcmd/config"),
        ]
        persistent_config_dir = STEAM_HOME_DIR / "Steam/config"
        persistent_config_dir.mkdir(parents=True, exist_ok=True)

        for src_dir in config_sources:
            if src_dir.exists() and src_dir != persistent_config_dir:
                for vdf_file in ["config.vdf", "loginusers.vdf"]:
                    vdf_path = src_dir / vdf_file
                    dest_path = persistent_config_dir / vdf_file
                    if vdf_path.exists() and vdf_path.stat().st_size > 50:
                        if not dest_path.exists() or vdf_path.stat().st_mtime > dest_path.stat().st_mtime:
                            shutil.copy2(vdf_path, dest_path)
                        elif dest_path.exists() and dest_path.stat().st_mtime > vdf_path.stat().st_mtime:
                            shutil.copy2(dest_path, vdf_path)
                    elif dest_path.exists() and dest_path.stat().st_size > 50 and not vdf_path.exists():
                        shutil.copy2(dest_path, vdf_path)

    except Exception as e:
        print(f"[Config] Error syncing Steam credentials: {e}")

sync_steam_sentry_files = sync_steam_credentials

def has_steam_credentials() -> bool:
    """Checks whether persistent Steam credentials/sentry files exist on this system."""
    settings = load_settings()
    if settings.get("steamcmd_authorized", False):
        return True

    if list(STEAM_HOME_DIR.glob("ssfn*")):
        return True

    check_paths = [
        Path("/home/steam/Steam/config/config.vdf"),
        Path("/home/steam/Steam/config/loginusers.vdf"),
        Path("/home/steam/.steam/steam/config/config.vdf"),
        Path("/home/steam/.steam/steam/config/loginusers.vdf"),
        Path("/steamcmd/config/config.vdf"),
        STEAM_HOME_DIR / "Steam/config/config.vdf",
        STEAM_HOME_DIR / "Steam/config/loginusers.vdf",
        STEAM_HOME_DIR / ".steam/steam/config/config.vdf",
        STEAM_HOME_DIR / "steamcmd_config/config.vdf",
    ]
    for p in check_paths:
        if p.exists() and p.is_file() and p.stat().st_size > 50:
            try:
                content = p.read_text(encoding="utf-8", errors="replace")
                if any(k in content for k in ("Accounts", "ConnectCache", "AutoLoginUser", "RememberPassword")):
                    return True
            except Exception:
                return True
    return False

def configure_steam_autologin(username: str, steamid: str = "") -> None:
    """
    Configures config.vdf and loginusers.vdf across Steam directories
    to ensure AutoLoginUser and RememberPassword are set so SteamCMD re-authenticates seamlessly.
    """
    if not username:
        return

    clean_user = username.strip()
    target_dirs = [
        Path("/home/steam/Steam/config"),
        Path("/home/steam/.steam/steam/config"),
        Path("/home/steam/.local/share/Steam/config"),
        Path("/steamcmd/config"),
        STEAM_HOME_DIR / "Steam/config",
        STEAM_HOME_DIR / ".steam/steam/config",
        STEAM_HOME_DIR / "steamcmd_config",
    ]

    for cdir in target_dirs:
        try:
            cdir.mkdir(parents=True, exist_ok=True)
            cfg_file = cdir / "config.vdf"
            if cfg_file.exists() and cfg_file.stat().st_size > 20:
                try:
                    text = cfg_file.read_text(encoding="utf-8", errors="replace")
                    if re.search(r'"AutoLoginUser"\s+"[^"]*"', text, flags=re.IGNORECASE):
                        text = re.sub(r'("AutoLoginUser"\s+)"[^"]*"', lambda m: f'{m.group(1)}"{clean_user}"', text, flags=re.IGNORECASE)
                    else:
                        steam_match = re.search(r'("Steam"\s*\{)', text, flags=re.IGNORECASE)
                        if steam_match:
                            text = re.sub(r'("Steam"\s*\{)', lambda m: f'{m.group(1)}\n\t\t\t\t"AutoLoginUser"\t\t"{clean_user}"', text, count=1, flags=re.IGNORECASE)

                    if re.search(r'"RememberPassword"\s+"[^"]*"', text, flags=re.IGNORECASE):
                        text = re.sub(r'("RememberPassword"\s+)"[^"]*"', r'\g<1>"1"', text, flags=re.IGNORECASE)
                    else:
                        steam_match = re.search(r'("Steam"\s*\{)', text, flags=re.IGNORECASE)
                        if steam_match:
                            text = re.sub(r'("Steam"\s*\{)', r'\g<1>\n\t\t\t\t"RememberPassword"\t\t"1"', text, count=1, flags=re.IGNORECASE)

                    cfg_file.write_text(text, encoding="utf-8")
                except Exception as ex:
                    print(f"[Config] Error updating {cfg_file}: {ex}")
            elif not cfg_file.exists():
                minimal_cfg = (
                    '"InstallConfigStore"\n'
                    '{\n'
                    '\t"Software"\n'
                    '\t{\n'
                    '\t\t"Valve"\n'
                    '\t\t{\n'
                    '\t\t\t"Steam"\n'
                    '\t\t\t{\n'
                    f'\t\t\t\t"AutoLoginUser"\t\t"{clean_user}"\n'
                    '\t\t\t\t"RememberPassword"\t\t"1"\n'
                    '\t\t\t}\n'
                    '\t\t}\n'
                    '\t}\n'
                    '}\n'
                )
                cfg_file.write_text(minimal_cfg, encoding="utf-8")

            users_file = cdir / "loginusers.vdf"
            if users_file.exists() and users_file.stat().st_size > 20:
                try:
                    text = users_file.read_text(encoding="utf-8", errors="replace")
                    text = re.sub(r'("RememberPassword"\s+)"[^"]*"', r'\g<1>"1"', text, flags=re.IGNORECASE)
                    text = re.sub(r'("MostRecent"\s+)"[^"]*"', r'\g<1>"1"', text, flags=re.IGNORECASE)
                    users_file.write_text(text, encoding="utf-8")
                except Exception as ex:
                    print(f"[Config] Error updating {users_file}: {ex}")
            elif steamid and not users_file.exists():
                minimal_users = (
                    '"users"\n'
                    '{\n'
                    f'\t"{steamid}"\n'
                    '\t{\n'
                    f'\t\t"AccountName"\t\t"{clean_user}"\n'
                    f'\t\t"PersonaName"\t\t"{clean_user}"\n'
                    '\t\t"RememberPassword"\t\t"1"\n'
                    '\t\t"MostRecent"\t\t"1"\n'
                    '\t\t"WantsOfflineMode"\t\t"0"\n'
                    '\t\t"SkipOfflineModeWarning"\t\t"0"\n'
                    '\t}\n'
                    '}\n'
                )
                users_file.write_text(minimal_users, encoding="utf-8")
        except Exception as e:
            print(f"[Config] Error configuring autologin in {cdir}: {e}")

    sync_steam_credentials()

def load_settings() -> dict:
    if SETTINGS_FILE.exists():
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                return {**DEFAULT_SETTINGS, **data}
        except Exception:
            return DEFAULT_SETTINGS.copy()
    return DEFAULT_SETTINGS.copy()

def save_settings(new_settings: dict) -> dict:
    current = load_settings()
    current.update(new_settings)
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current

def extract_account_info_from_loginusers(account_name: Optional[str] = None) -> Optional[Dict[str, str]]:
    """Extracts 64-bit SteamID and persona name from loginusers.vdf or userdata directories."""
    search_dirs = [
        Path("/home/steam/Steam/config"),
        Path("/home/steam/.steam/steam/config"),
        STEAM_HOME_DIR / "Steam/config",
        DATA_DIR / "steam_config",
    ]

    for cdir in search_dirs:
        vdf_path = cdir / "loginusers.vdf"
        if vdf_path.exists():
            try:
                content = vdf_path.read_text(encoding="utf-8", errors="replace")
                user_matches = re.finditer(r'"(\d{17})"\s*\{([^}]+)\}', content)
                for match in user_matches:
                    sid = match.group(1)
                    block = match.group(2)
                    acc_m = re.search(r'"AccountName"\s+"([^"]+)"', block, re.IGNORECASE)
                    pers_m = re.search(r'"PersonaName"\s+"([^"]+)"', block, re.IGNORECASE)
                    acc = acc_m.group(1) if acc_m else ""
                    pers = pers_m.group(1) if pers_m else ""
                    if not account_name or (acc.lower() == account_name.lower()):
                        return {
                            "steamid": sid,
                            "account_name": acc or account_name or "Steam User",
                            "personaname": pers or acc or account_name or "Steam User",
                        }
            except Exception as e:
                print(f"[Config] Error reading {vdf_path}: {e}")

    userdata_dirs = [
        Path("/home/steam/Steam/userdata"),
        Path("/home/steam/.steam/steam/userdata"),
        STEAM_HOME_DIR / "Steam/userdata",
    ]
    for udir in userdata_dirs:
        if udir.exists() and udir.is_dir():
            try:
                for child in udir.iterdir():
                    if child.is_dir() and child.name.isdigit():
                        account_id = int(child.name)
                        if account_id > 0:
                            steamid64 = str(76561197960265728 + account_id)
                            return {
                                "steamid": steamid64,
                                "account_name": account_name or "Steam User",
                                "personaname": account_name or "Steam User",
                            }
            except Exception:
                pass

    return None


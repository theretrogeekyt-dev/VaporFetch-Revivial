import json
import httpx
from typing import List, Dict, Any, Optional
from app.config import load_settings, DATA_DIR

STEAM_API_BASE = "https://api.steampowered.com"
STEAM_STORE_BASE = "https://store.steampowered.com"

class SteamApiClient:
    def __init__(self):
        self._details_cache: Dict[int, Dict[str, Any]] = {}
        self._load_details_cache()

    def _load_details_cache(self):
        cache_file = DATA_DIR / "app_details_cache.json"
        if cache_file.exists():
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    self._details_cache = json.load(f)
            except Exception:
                self._details_cache = {}

    def _save_details_cache(self):
        cache_file = DATA_DIR / "app_details_cache.json"
        try:
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(self._details_cache, f)
        except Exception:
            pass

    async def get_player_summary(
        self,
        steamid: str,
        api_key: Optional[str] = None,
        access_token: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Fetches the user's public profile summary (persona name, avatar, profile state)."""
        settings = load_settings()
        key = api_key or settings.get("steam_api_key")

        url = f"{STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/"
        params = {"steamids": steamid}

        if key:
            params["key"] = key
        elif access_token:
            params["access_token"] = access_token
        else:
            return None

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code == 200:
                    players = res.json().get("response", {}).get("players", [])
                    if players:
                        p = players[0]
                        return {
                            "personaname": p.get("personaname", ""),
                            "avatar": p.get("avatarfull") or p.get("avatarmedium") or p.get("avatar", ""),
                            "profileurl": p.get("profileurl", ""),
                            "communitybanned": p.get("communitybanned", False),
                            "vacbanned": p.get("vacbanned", False),
                            "personastate": p.get("personastate", 1),  # 1 = Online
                        }
        except Exception as e:
            print(f"[SteamAPI] Error fetching player summary: {e}")
        return None

    async def get_owned_games(
        self,
        steamid: str,
        api_key: Optional[str] = None,
        access_token: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Fetches the user's owned games list via GetOwnedGames endpoint.
        Returns standardized game dictionaries with rich Steam CDN asset URLs.
        """
        settings = load_settings()
        key = api_key or settings.get("steam_api_key")

        url = f"{STEAM_API_BASE}/IPlayerService/GetOwnedGames/v1/"
        params = {
            "steamid": steamid,
            "include_appinfo": 1,
            "include_played_free_games": 1,
            "format": "json"
        }

        if key:
            params["key"] = key
        elif access_token:
            params["access_token"] = access_token

        async with httpx.AsyncClient(timeout=15.0) as client:
            res = await client.get(url, params=params)

            if res.status_code in (401, 403):
                raise PermissionError(
                    "Steam Web API request unauthorized. Please configure a valid Steam Web API Key in Settings or ensure profile game details are public."
                )

            res.raise_for_status()
            data = res.json().get("response", {})

        raw_games = data.get("games", [])
        formatted_games = []

        for g in raw_games:
            appid = g.get("appid")
            name = g.get("name") or f"App {appid}"
            icon_hash = g.get("img_icon_url")
            playtime = g.get("playtime_forever", 0)
            rtime_last_played = g.get("rtime_last_played", 0)

            icon_url = (
                f"https://media.steampowered.com/steamcommunity/public/images/apps/{appid}/{icon_hash}.jpg"
                if icon_hash else ""
            )

            # Standard Steam CDN Artwork URLs
            header_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/header.jpg"
            capsule_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/library_600x900.jpg"
            hero_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/library_hero.jpg"
            logo_url = f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{appid}/logo.png"

            formatted_games.append({
                "appid": appid,
                "name": name,
                "playtime_forever": playtime,
                "rtime_last_played": rtime_last_played,
                "icon_url": icon_url,
                "header_url": header_url,
                "capsule_url": capsule_url,
                "hero_url": hero_url,
                "logo_url": logo_url,
            })

        formatted_games.sort(key=lambda x: x["name"].lower())

        try:
            cache_file = DATA_DIR / "games_cache.json"
            with open(cache_file, "w", encoding="utf-8") as f:
                json.dump(formatted_games, f)
        except Exception:
            pass

        return formatted_games

    def get_cached_games(self) -> List[Dict[str, Any]]:
        cache_file = DATA_DIR / "games_cache.json"
        if cache_file.exists():
            try:
                with open(cache_file, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return []

    async def get_app_details(self, appid: int) -> Optional[Dict[str, Any]]:
        """
        Fetches detailed store information for a given app from Steam Storefront API,
        including short description, developers, release date, genres, and screenshots.
        """
        str_id = str(appid)
        if str_id in self._details_cache:
            return self._details_cache[str_id]

        url = f"{STEAM_STORE_BASE}/api/appdetails"
        params = {"appids": appid, "l": "english"}

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code == 200:
                    data = res.json().get(str_id, {})
                    if data.get("success") and "data" in data:
                        d = data["data"]
                        screenshots = [
                            s.get("path_full") or s.get("path_thumbnail")
                            for s in d.get("screenshots", [])[:6]
                        ]
                        genres = [g.get("description", "") for g in d.get("genres", [])]
                        req_str = d.get("pc_requirements", {}).get("minimum", "")

                        details = {
                            "appid": appid,
                            "name": d.get("name", f"App {appid}"),
                            "short_description": d.get("short_description", ""),
                            "header_image": d.get("header_image", ""),
                            "background": d.get("background_raw") or d.get("background", ""),
                            "developers": d.get("developers", []),
                            "publishers": d.get("publishers", []),
                            "release_date": d.get("release_date", {}).get("date", ""),
                            "genres": genres,
                            "screenshots": screenshots,
                            "pc_requirements": req_str,
                            "is_free": d.get("is_free", False),
                            "metacritic": d.get("metacritic", {}).get("score"),
                        }
                        self._details_cache[str_id] = details
                        self._save_details_cache()
                        return details
        except Exception as e:
            print(f"[SteamAPI] Error fetching app details for {appid}: {e}")

        return None

    async def get_app_news(self, appid: int, count: int = 4) -> List[Dict[str, Any]]:
        """Fetches developer news, announcements, and patch notes for an app."""
        url = f"{STEAM_API_BASE}/ISteamNews/GetNewsForApp/v2/"
        params = {"appid": appid, "count": count, "maxlength": 400, "format": "json"}

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code == 200:
                    newsitems = res.json().get("appnews", {}).get("newsitems", [])
                    results = []
                    for item in newsitems:
                        results.append({
                            "gid": item.get("gid"),
                            "title": item.get("title", ""),
                            "url": item.get("url", ""),
                            "author": item.get("author", "Valve / Developer"),
                            "contents": item.get("contents", ""),
                            "date": item.get("date", 0),
                        })
                    return results
        except Exception as e:
            print(f"[SteamAPI] Error fetching news for {appid}: {e}")
        return []

    async def search_store(self, term: str) -> List[Dict[str, Any]]:
        """Searches Steam Store for any title, app, or tool."""
        if not term or len(term.strip()) < 2:
            return []

        url = f"{STEAM_STORE_BASE}/api/storesearch/"
        params = {"term": term.strip(), "l": "english", "cc": "US"}

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                res = await client.get(url, params=params)
                if res.status_code == 200:
                    items = res.json().get("items", [])
                    results = []
                    for item in items:
                        aid = item.get("id")
                        results.append({
                            "appid": aid,
                            "name": item.get("name", f"App {aid}"),
                            "price": item.get("price", {}).get("final", 0) / 100 if item.get("price") else 0,
                            "header_url": f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{aid}/header.jpg",
                            "capsule_url": f"https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/{aid}/library_600x900.jpg",
                            "tiny_image": item.get("tiny_image", ""),
                        })
                    return results
        except Exception as e:
            print(f"[SteamAPI] Store search error: {e}")
        return []

steam_api_client = SteamApiClient()


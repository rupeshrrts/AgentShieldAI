"""Extension distribution for system-wide (policy) installation.

Chrome and Edge install and update a force-installed extension by fetching an
"update manifest" (updates.xml) and the signed .crx it points to. These endpoints
serve both from EXTENSION_PACKAGE_DIR, plus /info, which tells installers which
extension ID and update URL to put in the browser policies.

updates.xml, the .crx and /info are public by design: browsers fetch them without
credentials, and they contain no organization data. Downloading or installing grants
nothing: a browser works only after its user activates it with a code from a licensed
account. The portal's downloads (/download/...) additionally need a 5-minute link that
is only issued to accounts with an active plan (POST /api/v1/me/download-link).

If store IDs are configured, /info points installers at the Chrome Web Store and
Edge Add-ons copies instead, which browsers accept on unmanaged PCs too.
"""

import json
import re
from pathlib import Path
from typing import Optional
from xml.sax.saxutils import quoteattr

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.entitlements import DENIAL_CODES, current_entitlement
from app.core.security import TOKEN_TYPE_DOWNLOAD, decode_access_token
from app.db.models import User
from app.db.session import get_db

router = APIRouter(prefix="/extension-updates", tags=["Extension distribution"])

CHROME_STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx"
EDGE_STORE_UPDATE_URL = "https://edge.microsoft.com/extensionwebstorebase/v1/crx"
_ID = re.compile(r"^[a-p]{32}$")


def _package_dir() -> Path:
    return Path(settings.EXTENSION_PACKAGE_DIR)


def _release() -> dict:
    path = _package_dir() / "release.json"
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="No extension package has been built. Run: node scripts/packaging/pack-extension.js",
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    if not _ID.match(data.get("id", "")) or not re.match(r"^[0-9.]+$", data.get("version", "")):
        raise HTTPException(status_code=500, detail="release.json is invalid")
    return data


def _base_url(request: Request) -> str:
    return settings.PUBLIC_BASE_URL or str(request.base_url).rstrip("/")


@router.get("/info")
def distribution_info(request: Request):
    """What a system installer or Group Policy should configure for Chrome and Edge."""
    release = _release()
    base = _base_url(request)
    self_hosted = {"id": release["id"], "update_url": f"{base}/extension-updates/updates.xml", "source": "self_hosted"}

    chrome = (
        {"id": settings.CHROME_STORE_EXTENSION_ID, "update_url": CHROME_STORE_UPDATE_URL, "source": "chrome_web_store"}
        if _ID.match(settings.CHROME_STORE_EXTENSION_ID)
        else self_hosted
    )
    edge = (
        {"id": settings.EDGE_STORE_EXTENSION_ID, "update_url": EDGE_STORE_UPDATE_URL, "source": "edge_add_ons"}
        if _ID.match(settings.EDGE_STORE_EXTENSION_ID)
        else self_hosted
    )
    return {
        "version": release["version"],
        "built_at": release.get("built_at"),
        "chrome": chrome,
        "edge": edge,
        "requires_managed_device": chrome["source"] == "self_hosted" or edge["source"] == "self_hosted",
        "zip_sha256": release.get("zip_sha256"),
        "zip_size": release.get("zip_size"),
        "store_links": {
            "chrome": f"https://chromewebstore.google.com/detail/{settings.CHROME_STORE_EXTENSION_ID}" if _ID.match(settings.CHROME_STORE_EXTENSION_ID) else None,
            "edge": f"https://microsoftedge.microsoft.com/addons/detail/{settings.EDGE_STORE_EXTENSION_ID}" if _ID.match(settings.EDGE_STORE_EXTENSION_ID) else None,
        },
        "downloads": {
            "system_setup": Path(settings.SYSTEM_SETUP_PATH).is_file(),
            "extension_zip": (_package_dir() / "agentshield-extension.zip").is_file(),
        },
    }


def _check_download_link(t: Optional[str], file: str, db: Session) -> None:
    """The portal's downloads need a 5-minute link from POST /api/v1/me/download-link, which is only issued to
    accounts that may connect a browser. The plan is checked again here, when the link is used."""
    claims = decode_access_token(t) if t else None
    if not claims or claims.get("typ") != TOKEN_TYPE_DOWNLOAD or claims.get("file") != file:
        raise HTTPException(status_code=401, detail={
            "code": "DOWNLOAD_LINK_REQUIRED",
            "message": "Download the extension from the AgentShield portal (Download page) while signed in to an account with an active plan.",
        })
    user = db.query(User).filter(User.id == claims.get("sub"), User.active == True).first()
    if not user or user.organization_id != claims.get("org"):
        raise HTTPException(status_code=401, detail={"code": "DOWNLOAD_LINK_REQUIRED", "message": "This download link is no longer valid."})
    ent = current_entitlement(db, user.organization_id)
    if not ent.allowed:
        code, message = DENIAL_CODES.get(ent.state, DENIAL_CODES["NONE"])
        raise HTTPException(status_code=403, detail={"code": code, "message": message})


@router.get("/download/AgentShield-System-Setup.exe")
def download_system_setup(t: Optional[str] = Query(default=None), db: Session = Depends(get_db)):
    """Windows installer that sets up AgentShield for every user in Chrome and Edge (run as administrator)."""
    _check_download_link(t, "AgentShield-System-Setup.exe", db)
    path = Path(settings.SYSTEM_SETUP_PATH)
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="The installer has not been built on this server. See INSTALL.md, 'Build the installer'.",
        )
    return FileResponse(path, media_type="application/vnd.microsoft.portable-executable", filename="AgentShield-System-Setup.exe")


@router.get("/download/agentshield-extension.zip")
def download_extension_zip(t: Optional[str] = Query(default=None), db: Session = Depends(get_db)):
    """The extension as a zip for manual installation (extract, then "Load unpacked")."""
    _check_download_link(t, "agentshield-extension.zip", db)
    release = _release()
    path = _package_dir() / "agentshield-extension.zip"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Package file missing. Run: node scripts/packaging/pack-extension.js")
    # The URL stays the same across releases: make browsers re-check it so nobody gets a cached old version
    return FileResponse(path, media_type="application/zip", filename=f"agentshield-extension-{release['version']}.zip",
                        headers={"Cache-Control": "no-cache"})


@router.get("/updates.xml")
def update_manifest(request: Request):
    """Google Update protocol manifest used by Chrome and Edge to install/update the extension."""
    release = _release()
    codebase = f"{_base_url(request)}/extension-updates/agentshield-{release['version']}.crx"
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        f"  <app appid={quoteattr(release['id'])}>\n"
        f"    <updatecheck codebase={quoteattr(codebase)} version={quoteattr(release['version'])} />\n"
        "  </app>\n"
        "</gupdate>\n"
    )
    return Response(content=xml, media_type="application/xml", headers={"Cache-Control": "no-cache"})


@router.get("/agentshield-{version}.crx")
def extension_package(version: str):
    """The signed extension package. The version in the URL keeps browser caches correct across updates."""
    release = _release()
    if version != release["version"]:
        raise HTTPException(status_code=404, detail="That version is not available.")
    path = _package_dir() / "agentshield.crx"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Package file missing.")
    return FileResponse(path, media_type="application/x-chrome-extension", filename=f"agentshield-{version}.crx")

#!/usr/bin/env python3
"""Import a Prism/MultiMC ZIP without publishing third-party binaries.

Only reviewed configuration and NCreate-owned resources are copied. Mod JARs
are matched by their exact SHA-512 to the official Modrinth version API.
Unknown files stay in the original ZIP and block publication.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile


API = "https://api.modrinth.com/v2/version_files"
USER_AGENT = "NCreatePackPublisher/1.0 (+https://github.com/Yozekkk/ncreate-pack)"
MAX_TOTAL = 4 * 1024**3
MAX_FILE = 2 * 1024**3
VERSION = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
CONFIG_ROOTS = ("config/", "defaultconfigs/")
RESOURCE_ROOTS = ("resourcepacks/", "shaderpacks/")
PROTECTED = {"saves", "screenshots", "logs", "mods-quarantine-optimization", "cache", "downloads"}


def safe_member(info: zipfile.ZipInfo) -> str:
    name = info.filename
    if not name or name.startswith("/") or "\\" in name or "\x00" in name:
        raise ValueError(f"unsafe ZIP path: {name!r}")
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") or len(part) > 255 or
           re.search(r'[\x00-\x1f<>:"|?*]', part) or part.endswith((".", " ")) or
           re.match(r"(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", part)
           for part in parts):
        raise ValueError(f"unsafe ZIP path: {name!r}")
    if len(name) > 1024 or info.file_size > MAX_FILE:
        raise ValueError(f"ZIP member exceeds limits: {name!r}")
    mode = info.external_attr >> 16
    if stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR):
        raise ValueError(f"unsafe ZIP member type: {name!r}")
    if info.flag_bits & 1:
        raise ValueError(f"encrypted ZIP member: {name!r}")
    return name


def hashes(stream) -> tuple[str, str, int]:
    sha256 = hashlib.sha256()
    sha512 = hashlib.sha512()
    size = 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        if size > MAX_FILE:
            raise ValueError("file exceeds size limit")
        sha256.update(chunk)
        sha512.update(chunk)
    return sha256.hexdigest(), sha512.hexdigest(), size


def reviewed_servers(archive: zipfile.ZipFile) -> list[dict[str, str]]:
    """Read only NCreate addresses from Minecraft's server-list string tags.

    The original servers.dat may contain unrelated private entries. The
    publisher recognizes the exact NCreate host and prefers its explicit port.
    """
    try:
        info = archive.getinfo("minecraft/servers.dat")
    except KeyError:
        return []
    if info.file_size > 64 * 1024:
        raise ValueError("server list exceeds review limit")
    data = archive.read(info)
    marker = b"\x08\x00\x02ip"
    addresses = []
    offset = 0
    while (index := data.find(marker, offset)) != -1:
        length_at = index + len(marker)
        if length_at + 2 > len(data):
            raise ValueError("truncated server address")
        size = int.from_bytes(data[length_at:length_at + 2], "big")
        end = length_at + 2 + size
        if end > len(data):
            raise ValueError("truncated server address")
        address = data[length_at + 2:end].decode("utf-8")
        match = re.fullmatch(r"play\.ncreate\.online(?::([1-9]\d{0,4}))?", address)
        if match and (match.group(1) is None or int(match.group(1)) <= 65535):
            addresses.append(address)
        offset = end
    if not addresses:
        return []
    selected = next((value for value in addresses if ":" in value), addresses[0])
    return [{"name": "NCreate", "address": selected}]


def lookup_versions(mods: list[dict]) -> dict:
    result = {}
    for offset in range(0, len(mods), 50):
        batch = mods[offset:offset + 50]
        body = json.dumps({"hashes": [mod["sha512"] for mod in batch], "algorithm": "sha512"}).encode()
        request = urllib.request.Request(API, body, {
            "Content-Type": "application/json", "User-Agent": USER_AGENT,
        }, method="POST")
        with urllib.request.urlopen(request, timeout=40) as response:
            if response.status != 200 or int(response.headers.get("Content-Length", "0")) > 8 * 1024 * 1024:
                raise ValueError("unexpected Modrinth API response")
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError("oversized Modrinth API response")
        result.update(json.loads(data))
    return result


def source_for(mod: dict, versions: dict) -> dict | None:
    version = versions.get(mod["sha512"])
    if not isinstance(version, dict):
        return None
    project_id, version_id = version.get("project_id"), version.get("id")
    if not isinstance(project_id, str) or not isinstance(version_id, str):
        return None
    for file in version.get("files", []):
        url = file.get("url")
        if (file.get("hashes", {}).get("sha512") != mod["sha512"] or
                file.get("size") != mod["size"] or not isinstance(url, str)):
            continue
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != "cdn.modrinth.com" or not parsed.path.startswith(f"/data/{project_id}/versions/"):
            continue
        return {"provider": "modrinth", "projectId": project_id, "versionId": version_id,
                "url": url, "sha256": mod["sha256"], "size": mod["size"]}
    return None


def import_pack(zip_path: Path, root: Path, version: str, *, changelog: str) -> dict:
    if not VERSION.fullmatch(version):
        raise ValueError("version must be SemVer")
    target = root / "packs" / "ncreate-server" / version
    if target.exists():
        raise FileExistsError(f"release source already exists: {target}")
    with zipfile.ZipFile(zip_path) as archive:
        infos = archive.infolist()
        if sum(info.file_size for info in infos) > MAX_TOTAL:
            raise ValueError("ZIP exceeds total size limit")
        seen = set()
        for info in infos:
            name = safe_member(info)
            folded = name.casefold()
            if folded in seen:
                raise ValueError(f"duplicate ZIP member: {name}")
            seen.add(folded)
        components = json.loads(archive.read("mmc-pack.json"))
        entries = {item.get("uid"): item.get("version") for item in components.get("components", [])}
        minecraft, loader = entries.get("net.minecraft"), entries.get("net.neoforged")
        if not minecraft or not loader:
            raise ValueError("ZIP is not a Minecraft + NeoForge Prism pack")
        servers = reviewed_servers(archive)
        with tempfile.TemporaryDirectory(prefix="ncreate-pack-import-") as temporary:
            staging = Path(temporary) / "pack"
            files_dir = staging / "files"
            files_dir.mkdir(parents=True)
            mods: list[dict] = []
            configs = 0
            resources = 0
            for info in infos:
                if info.is_dir() or not info.filename.startswith("minecraft/"):
                    continue
                relative = info.filename[len("minecraft/"):]
                if not relative or relative.split("/", 1)[0].casefold() in PROTECTED:
                    continue
                if relative.startswith("mods/") and relative.count("/") == 1 and relative.endswith(".jar"):
                    with archive.open(info) as stream:
                        digest256, digest512, size = hashes(stream)
                    mods.append({"path": relative, "sha256": digest256, "sha512": digest512, "size": size})
                    continue
                if relative.startswith(CONFIG_ROOTS):
                    if relative.lower().endswith((".bak", ".old", ".tmp", ".log", ".lock")):
                        continue
                    segments = relative.lower().split("/")
                    if ("cache" in segments or "caches" in segments or
                            segments[-1] in ("xaeropatreon.txt", "tag_cache.json")):
                        continue
                    if relative.endswith((".jar", ".exe", ".so", ".dll", ".sh", ".bat", ".cmd", ".ps1")):
                        raise ValueError(f"executable in config directory: {relative}")
                    destination = files_dir / PurePosixPath(relative)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(info) as source, destination.open("wb") as output:
                        shutil.copyfileobj(source, output, 1024 * 1024)
                    configs += 1
                    continue
                if relative == "resourcepacks/NCreate_Russian_Overrides.zip":
                    data = archive.read(info)
                    with zipfile.ZipFile(io.BytesIO(data)) as nested:
                        if len(nested.infolist()) > 128 or sum(item.file_size for item in nested.infolist()) > 2 * 1024 * 1024:
                            raise ValueError("NCreate resource pack exceeds review limits")
                        for item in nested.infolist():
                            safe_member(item)
                            if item.filename != "pack.mcmeta" and not re.fullmatch(
                                r"assets/[a-z0-9_-]+/lang/[a-z_]+\.json", item.filename):
                                raise ValueError(f"unexpected NCreate resource pack entry: {item.filename}")
                    destination = files_dir / relative
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    destination.write_bytes(data)
                    resources += 1
                    continue
                if relative.startswith(RESOURCE_ROOTS) and relative.count("/") == 1 and relative.endswith(".zip"):
                    # Resource packs and shaders require a separate rights review. Their
                    # exact hashes are resolved through Modrinth just like JARs.
                    with archive.open(info) as stream:
                        digest256, digest512, size = hashes(stream)
                    mods.append({"path": relative, "sha256": digest256, "sha512": digest512, "size": size})
                    resources += 1
            versions = lookup_versions(mods)
            reviewed_path = root / "sources" / "reviewed.json"
            reviewed = json.loads(reviewed_path.read_text()) if reviewed_path.exists() else {}
            external = {}
            unresolved = []
            for mod in mods:
                source = source_for(mod, versions)
                if source is None:
                    candidate = reviewed.get(mod["sha512"])
                    if (isinstance(candidate, dict) and
                            candidate.get("sha256") == mod["sha256"] and
                            candidate.get("size") == mod["size"]):
                        source = {key: candidate[key] for key in (
                            "provider", "url", "sha256", "size", "projectId",
                            "versionId", "fileId", "sourcePage") if key in candidate}
                if source:
                    external[mod["path"]] = source
                else:
                    unresolved.append(mod)
            metadata = {
                "schemaVersion": 1, "id": "ncreate-server", "name": "NCreate Server",
                "version": version, "minecraft": minecraft,
                "loader": {"kind": "neoforge", "version": loader},
                "java": {"major": 21},
                "memory": {"minimumMb": 1024, "recommendedMb": 5120, "maximumMb": 16384},
                "changelog": changelog,
                "servers": servers,
            }
            (staging / "edition.json").write_text(json.dumps(metadata, indent=2, ensure_ascii=False) + "\n")
            (staging / "external-sources.json").write_text(json.dumps(external, indent=2, ensure_ascii=False, sort_keys=True) + "\n")
            report = {"version": version, "minecraft": minecraft, "loader": loader,
                      "configFiles": configs, "activeModsAndResources": len(mods),
                      "resources": resources, "resolvedSources": len(external),
                      "unresolved": unresolved}
            if unresolved:
                # The staging tree is intentionally retained for review but the
                # publisher refuses to release it while unresolved entries exist.
                (staging / "UNRESOLVED.json").write_text(json.dumps(unresolved, indent=2) + "\n")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(staging, target)
            return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("version")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--changelog", default="Первый выпуск официальной сборки NCreate Server.")
    args = parser.parse_args()
    report = import_pack(args.archive, args.root, args.version, changelog=args.changelog)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    if report["unresolved"]:
        print("Unresolved files block publication; review official sources before publishing.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, KeyError, FileNotFoundError, zipfile.BadZipFile, urllib.error.URLError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)

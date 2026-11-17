"""Run the qPCR Planner Next API on its reserved loopback port and runtime paths."""

from __future__ import annotations

import asyncio
import os
import socket
import stat
import sys
from pathlib import Path
from typing import Mapping


MODULE_ID = "qpcr-planner"
APP_DATA_NAME = "EasyLab Next qPCR Planner"
STORAGE_NAME = "qPCR Planner"
HOST = "127.0.0.1"
PORT = 18512
APP_ROOT = Path(__file__).resolve().parents[1]
MODULE_ROOT = APP_ROOT.parent
SOURCE_ENV_KEYS = {
    "APP_DIST_DIR",
    "APP_PYTHON_PATH",
    "EASYLAB_CDNA_PATH",
    "EASYLAB_CDNA_DIST_DIR",
    "EASYLAB_QPCR_PLANNER_PATH",
    "VITE_DEV_SERVER_URL",
    "VITE_API_BASE",
    "API_BASE_URL",
    "UVICORN_HOST",
    "UVICORN_PORT",
    "HOST",
    "PORT",
}
PATH_ENVIRONMENT = {
    "EASYLAB_DATA_ROOT": "data_root",
    "EASYLAB_DATA_PATH": "data_path",
    "EASYLAB_ATTACHMENTS_PATH": "attachments_path",
    "EASYLAB_EXPORTS_PATH": "exports_path",
    "EASYLAB_SYNC_PATH": "sync_path",
    "EASYLAB_SETTINGS_PATH": "settings_path",
}


def _inside(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _multi_module_workspace_root(module_root: Path) -> Path | None:
    modules_root = module_root.parent
    workspace_root = modules_root.parent
    if modules_root.name == "modules" and workspace_root.name == "easylab-next":
        return workspace_root
    return None


def resolve_runtime_paths(environment: Mapping[str, str] | None = None) -> dict[str, Path]:
    environment = environment or os.environ
    workspace_root = _multi_module_workspace_root(MODULE_ROOT)
    if workspace_root:
        default_runtime_root = workspace_root / "runtime"
    else:
        default_runtime_root = MODULE_ROOT / ".next-runtime" / "easylab-next"

    supplied_root = environment.get("EASYLAB_RUNTIME_ROOT")
    if supplied_root:
        if not Path(supplied_root).is_absolute() or Path(os.path.abspath(supplied_root)) != default_runtime_root:
            # A packaged app may use its own appData root. It has a product-specific
            # parent and is set by the isolated Electron entry point.
            packaged_root = Path(os.path.abspath(supplied_root))
            if packaged_root.name != "runtime" or packaged_root.parent.name != APP_DATA_NAME:
                raise RuntimeError(f"EASYLAB_RUNTIME_ROOT must stay in this qPCR Planner Next runtime: {default_runtime_root}")
            runtime_root = packaged_root
        else:
            runtime_root = default_runtime_root
    else:
        runtime_root = default_runtime_root

    data_root = runtime_root / "data"
    module_data_root = data_root / STORAGE_NAME
    python_env_root = runtime_root / "python-envs" / MODULE_ID
    cache_root = runtime_root / "cache" / MODULE_ID
    return {
        "runtime_root": runtime_root,
        "data_root": data_root,
        "module_data_root": module_data_root,
        "data_path": module_data_root / "data",
        "attachments_path": module_data_root / "attachments",
        "exports_path": module_data_root / "exports",
        "sync_path": module_data_root / "sync",
        "settings_path": module_data_root / "settings.json",
        "python_env_root": python_env_root,
        "python_path": python_env_root / ("Scripts/python.exe" if os.name == "nt" else "bin/python"),
        "cache_root": cache_root,
        "pip_cache_path": cache_root / "pip",
        "pycache_path": cache_root / "bytecode",
        "xdg_cache_path": cache_root / "xdg",
        "workspace_root": workspace_root,
    }


def assert_no_symlink_path(target: Path) -> None:
    absolute = Path(os.path.abspath(target))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            break
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"Symlinks are not allowed in Next runtime paths: {current}")
        if not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"Expected a real directory in Next runtime paths: {current}")


def ensure_real_directory(target: Path) -> None:
    absolute = Path(os.path.abspath(target))
    current = Path(absolute.anchor)
    for component in absolute.parts[1:]:
        current = current / component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                pass
            metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError(f"Unsafe Next runtime directory: {current}")


def validate_environment(environment: Mapping[str, str], paths: Mapping[str, Path]) -> None:
    present = sorted(key for key in SOURCE_ENV_KEYS if environment.get(key))
    if present:
        raise RuntimeError(f"Refusing inherited source, API, or port overrides: {', '.join(present)}")

    expected_runtime = Path(os.path.abspath(environment.get("EASYLAB_RUNTIME_ROOT", paths["runtime_root"])))
    if expected_runtime != paths["runtime_root"]:
        raise RuntimeError("EASYLAB_RUNTIME_ROOT does not match the isolated qPCR Planner Next runtime.")
    if environment.get("EASYLAB_MODULE_ID") not in (None, MODULE_ID):
        raise RuntimeError(f"EASYLAB_MODULE_ID must be {MODULE_ID}.")
    for environment_key, path_key in PATH_ENVIRONMENT.items():
        supplied = environment.get(environment_key)
        if supplied and Path(os.path.abspath(supplied)) != paths[path_key]:
            raise RuntimeError(f"{environment_key} must remain inside the qPCR Planner Next runtime.")


def sanitized_environment(environment: Mapping[str, str], paths: Mapping[str, Path]) -> dict[str, str]:
    validate_environment(environment, paths)
    child = dict(environment)
    for key in [
        *SOURCE_ENV_KEYS,
        *PATH_ENVIRONMENT,
        "EASYLAB_MODULE_ID",
        "PYTHONHOME",
        "PYTHONPATH",
        "PYTHONUSERBASE",
        "PYTHONPYCACHEPREFIX",
        "VIRTUAL_ENV",
        "PIP_CONFIG_FILE",
        "PIP_PREFIX",
        "PIP_TARGET",
        "PIP_USER",
        "PIP_CACHE_DIR",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ]:
        child.pop(key, None)

    child["EASYLAB_MODULE_ID"] = MODULE_ID
    child["EASYLAB_RUNTIME_ROOT"] = str(paths["runtime_root"])
    for environment_key, path_key in PATH_ENVIRONMENT.items():
        child[environment_key] = str(paths[path_key])
    child["PYTHONPATH"] = str(APP_ROOT)
    child["PYTHONPYCACHEPREFIX"] = str(paths["pycache_path"])
    child["PIP_CACHE_DIR"] = str(paths["pip_cache_path"])
    child["XDG_CACHE_HOME"] = str(paths["xdg_cache_path"])
    return child


def ensure_runtime_directories(paths: Mapping[str, Path]) -> None:
    directories = [paths[key] for key in (
        "runtime_root",
        "data_root",
        "module_data_root",
        "data_path",
        "attachments_path",
        "exports_path",
        "sync_path",
        "cache_root",
        "pip_cache_path",
        "pycache_path",
        "xdg_cache_path",
    )]
    directories.append(paths["python_env_root"].parent)
    for directory in directories:
        ensure_real_directory(directory)


def configure_python_bytecode_cache(paths: Mapping[str, Path]) -> None:
    # Python -I ignores PYTHONPYCACHEPREFIX; set it directly before importing app modules.
    sys.pycache_prefix = str(paths["pycache_path"])


def assert_safe_python_environment(paths: Mapping[str, Path]) -> None:
    venv = paths["python_env_root"]
    if Path(os.path.abspath(sys.prefix)) != venv:
        raise RuntimeError(f"Run the qPCR Planner API with its Next-only Python environment: {venv}")
    assert_no_symlink_path(venv)
    config = venv / "pyvenv.cfg"
    try:
        config_stat = config.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(f"The qPCR Planner Next Python environment is incomplete: {config}") from error
    if stat.S_ISLNK(config_stat.st_mode) or not stat.S_ISREG(config_stat.st_mode):
        raise RuntimeError(f"pyvenv.cfg must be a local file: {config}")

    base_prefix = Path(sys.base_prefix).resolve()
    python_bin = venv / ("Scripts" if os.name == "nt" else "bin")
    for current, directories, files in os.walk(venv, followlinks=False):
        current_path = Path(current)
        for name in directories + files:
            candidate = current_path / name
            metadata = candidate.lstat()
            if not stat.S_ISLNK(metadata.st_mode):
                continue
            is_python_executable_link = current_path == python_bin and name.lower().startswith("python")
            target = candidate.resolve(strict=True)
            if not (
                is_python_executable_link
                and (target == base_prefix or _inside(base_prefix, target) or _inside(venv, target))
            ):
                raise RuntimeError(f"Unexpected symlink inside the qPCR Planner Python environment: {candidate}")


def bind_api_socket(port: int = PORT) -> socket.socket:
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    else:
        # Allow a quick restart after our previous connection enters TIME_WAIT.
        # Keep the bind exclusive from active listeners; never use SO_REUSEPORT.
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        listener.bind((HOST, port))
        listener.listen(socket.SOMAXCONN)
        listener.setblocking(False)
    except OSError:
        listener.close()
        raise
    return listener


def run_api_server(listener: socket.socket) -> None:
    from uvicorn import Config, Server

    server = Server(Config("backend.main:app", host=HOST, port=PORT, reload=False, workers=1))
    try:
        asyncio.run(server.serve(sockets=[listener]))
    finally:
        listener.close()


def main() -> None:
    paths = resolve_runtime_paths()
    assert_no_symlink_path(paths["runtime_root"])
    ensure_runtime_directories(paths)
    validate_environment(os.environ, paths)
    assert_safe_python_environment(paths)
    safe_environment = sanitized_environment(os.environ.copy(), paths)
    os.environ.clear()
    os.environ.update(safe_environment)
    configure_python_bytecode_cache(paths)
    sys.path.insert(0, str(APP_ROOT))
    listener = bind_api_socket()
    run_api_server(listener)


if __name__ == "__main__":
    main()

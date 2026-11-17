import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import run_next


class NextRuntimeTests(unittest.TestCase):
    def test_default_runtime_uses_shared_next_workspace(self):
        workspace_root = Path(__file__).resolve().parents[4]
        paths = run_next.resolve_runtime_paths({})
        self.assertEqual(paths["runtime_root"], workspace_root / "runtime")
        self.assertEqual(paths["python_env_root"], workspace_root / "runtime" / "python-envs" / "qpcr-planner")
        self.assertEqual(paths["exports_path"], workspace_root / "runtime" / "data" / "qPCR Planner" / "exports")

    def test_external_runtime_override_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "EASYLAB_RUNTIME_ROOT"):
            run_next.resolve_runtime_paths({"EASYLAB_RUNTIME_ROOT": "/stable/easylab/runtime"})

    def test_environment_sanitizer_keeps_next_paths_and_drops_overrides(self):
        paths = run_next.resolve_runtime_paths({})
        source = {
            "HOME": "/Users/tester",
            "APP_DIST_DIR": "/stable/build",
            "VITE_DEV_SERVER_URL": "http://127.0.0.1:5176",
        }
        with self.assertRaisesRegex(RuntimeError, "APP_DIST_DIR"):
            run_next.sanitized_environment(source, paths)

        safe = run_next.sanitized_environment({"HOME": "/Users/tester"}, paths)
        self.assertEqual(safe["HOME"], "/Users/tester")
        self.assertEqual(safe["EASYLAB_RUNTIME_ROOT"], str(paths["runtime_root"]))
        self.assertEqual(safe["EASYLAB_EXPORTS_PATH"], str(paths["exports_path"]))
        self.assertEqual(safe["PYTHONPATH"], str(run_next.APP_ROOT))

    def test_bytecode_cache_is_set_directly_for_isolated_python_mode(self):
        paths = run_next.resolve_runtime_paths({})
        old_prefix = sys.pycache_prefix
        try:
            run_next.configure_python_bytecode_cache(paths)
            self.assertEqual(sys.pycache_prefix, str(paths["pycache_path"]))
        finally:
            sys.pycache_prefix = old_prefix

    def test_next_python_environment_rejects_linked_pyvenv_config(self):
        with tempfile.TemporaryDirectory(dir=run_next.MODULE_ROOT, prefix=".venv-test-") as temporary:
            venv = Path(temporary) / "venv"
            (venv / "bin").mkdir(parents=True)
            target = Path(temporary) / "real-pyvenv.cfg"
            target.write_text("home = /read-only/base/python\n", encoding="utf-8")
            (venv / "pyvenv.cfg").symlink_to(target)
            paths = {"python_env_root": venv}
            with patch.object(run_next.sys, "prefix", str(venv)):
                with self.assertRaisesRegex(RuntimeError, "pyvenv.cfg must be a local file"):
                    run_next.assert_safe_python_environment(paths)

    def test_python_interpreter_symlink_is_allowed_but_site_packages_link_is_not(self):
        with tempfile.TemporaryDirectory(dir=run_next.MODULE_ROOT, prefix=".venv-test-") as temporary:
            venv = Path(temporary) / "venv"
            bin_dir = venv / "bin"
            site_packages = venv / "lib" / "python3.11" / "site-packages"
            bin_dir.mkdir(parents=True)
            site_packages.mkdir(parents=True)
            (venv / "pyvenv.cfg").write_text("home = /read-only/base/python\n", encoding="utf-8")
            base_python = Path(sys.executable).resolve()
            (bin_dir / "python").symlink_to(base_python)
            paths = {"python_env_root": venv}

            with patch.object(run_next.sys, "prefix", str(venv)):
                run_next.assert_safe_python_environment(paths)
                outside = Path(temporary) / "outside-site-packages"
                outside.mkdir()
                site_packages.rmdir()
                site_packages.symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(RuntimeError, "Unexpected symlink"):
                    run_next.assert_safe_python_environment(paths)

    def test_api_socket_binds_only_if_the_reserved_port_is_free(self):
        listener = run_next.bind_api_socket(0)
        try:
            port = listener.getsockname()[1]
            with self.assertRaises(OSError):
                run_next.bind_api_socket(port)
        finally:
            listener.close()

    def test_api_socket_rebinds_after_a_closed_connection(self):
        listener = run_next.bind_api_socket(0)
        port = listener.getsockname()[1]
        client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        accepted = None
        rebound = None
        try:
            client.connect((run_next.HOST, port))
            accepted, _ = listener.accept()
            accepted.close()
            accepted = None
            self.assertEqual(client.recv(1), b"")
        finally:
            client.close()
            if accepted is not None:
                accepted.close()
            listener.close()

        try:
            rebound = run_next.bind_api_socket(port)
        finally:
            if rebound is not None:
                rebound.close()


if __name__ == "__main__":
    unittest.main()

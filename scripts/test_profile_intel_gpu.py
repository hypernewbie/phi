import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gpu_profile", Path(__file__).with_name("profile-intel-gpu.py"))
gpu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gpu)


class IntelGpuProfileTests(unittest.TestCase):
    def test_ignores_non_drm_fd(self):
        self.assertIsNone(gpu.parse_fdinfo("pos:\t0\nflags:\t02000002\n"))

    def test_parses_engine_time_not_memory(self):
        key, engines = gpu.parse_fdinfo("drm-client-id:\t42\ndrm-pdev:\t0000:00:02.0\ndrm-engine-render:\t123 ns\ndrm-total-system0:\t144 MiB\n")
        self.assertEqual(key, ("0000:00:02.0", "42"))
        self.assertEqual(engines, {"render": 123})

    def test_deduplicates_multiple_fds_for_same_client(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            for name, ns in (("15", 100), ("16", 110)):
                (directory / name).write_text(f"drm-client-id: 42\ndrm-engine-render: {ns} ns\n")
            (directory / "17").write_text("drm-client-id: 43\ndrm-engine-render: 50 ns\n")
            with patch.object(gpu, "Path", return_value=directory):
                self.assertEqual(gpu.engine_times(123), {
                    ("", "42"): {"render": 110}, ("", "43"): {"render": 50}})

    def test_engine_time_delta_is_not_cpu_usage(self):
        self.assertEqual(gpu.engine_delta({"client": {"render": 100}},
                                          {"client": {"render": 500_000_100}}, 1_000_000_000),
                         {"render": 50})

    def test_fails_on_client_replacement_or_counter_reset(self):
        with self.assertRaises(RuntimeError):
            gpu.engine_delta({"old": {"render": 0}}, {"new": {"render": 10}}, 100)
        with self.assertRaises(RuntimeError):
            gpu.engine_delta({"client": {"render": 100}}, {"client": {"render": 0}}, 100)


if __name__ == "__main__":
    unittest.main()

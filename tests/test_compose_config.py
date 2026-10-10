"""Compose가 실제 병합한 서비스 이름과 내부 연결을 검사한다. 컨테이너는 실행하지 않는다."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("docker"), "Docker Compose가 없는 환경")
class ComposeConfigTests(unittest.TestCase):
    def test_merged_names_aliases_and_persistent_volumes(self):
        env = {**os.environ, "ADMIN_PASSWORD": "ci-only-password", "RENDER_GID": "992", "VIDEO_GID": "44"}
        for override in (None, "docker-compose.build.yml", "docker-compose.nvidia.yml"):
            with self.subTest(override=override):
                command = ["docker", "compose", "-p", "ftml", "-f", "docker-compose.yml"]
                if override:
                    command += ["-f", override]
                output = subprocess.check_output(
                    command + ["config", "--format", "json"], cwd=ROOT, env=env, text=True, timeout=30,
                )
                config = json.loads(output)
                services = config["services"]
                self.assertEqual(set(services), {"ftml-frontend", "ftml-backend", "ftml-whisper"})
                for name, service in services.items():
                    self.assertEqual(service["container_name"], name)
                    self.assertEqual(set(service["networks"]), {"default"})
                    self.assertIn(name.removeprefix("ftml-"), service["networks"]["default"]["aliases"])
                self.assertEqual(set(services["ftml-frontend"]["depends_on"]), {"ftml-backend"})
                self.assertEqual(set(config["networks"]), {"default"})
                self.assertEqual(config["networks"]["default"]["name"], "ftml_default")
                self.assertFalse(config["networks"]["default"].get("external", False))
                for name in ("ftml_data", "whisper_models"):
                    self.assertTrue(config["volumes"][name]["external"])
                    self.assertEqual(config["volumes"][name]["name"], name)
                mounts = {v["target"]: v for v in services["ftml-backend"]["volumes"]}
                self.assertTrue(mounts["/media"]["read_only"])
                self.assertEqual(mounts["/data"]["source"], "ftml_data")
                models = {v["target"]: v for v in services["ftml-whisper"]["volumes"]}
                self.assertEqual(models["/models"]["source"], "whisper_models")
                if override == "docker-compose.build.yml":
                    self.assertTrue(all("build" in service for service in services.values()))
                if override == "docker-compose.nvidia.yml":
                    devices = services["ftml-backend"]["deploy"]["resources"]["reservations"]["devices"]
                    self.assertEqual(devices[0]["driver"], "nvidia")


if __name__ == "__main__":
    unittest.main()

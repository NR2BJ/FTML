"""권한 이전 명령의 안전장치 시험. 실제 Docker/호스트 볼륨은 변경하지 않는다."""

import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/prepare-volume-permissions.sh"

FAKE_DOCKER = r'''
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
with open(os.environ["DOCKER_CALLS"], "a") as log:
    log.write(json.dumps(args) + "\n")
case = os.environ.get("CASE", "")
if args[0] == "info":
    print(json.dumps(["name=" + case] if case in ("rootless", "userns") else ["name=seccomp"]))
elif args[:2] == ["volume", "inspect"]:
    if case == "missing":
        sys.exit(1)
    print('local|{"type":"nfs"}' if case == "shared" else 'local|null')
elif args[0] == "ps":
    counter = Path(os.environ["PS_COUNT"])
    count = int(counter.read_text()) + 1 if counter.exists() else 1
    counter.write_text(str(count))
    if case == "running" or (case == "restarted" and count > 2):
        print("active-container")
elif args[0] == "run":
    if "tar" in args:
        if case == "backup_failed":
            sys.exit(1)
        if case == "backup_invalid":
            sys.stdout.buffer.write(b"invalid archive")
        else:
            sys.stdout.buffer.write(Path(os.environ["BACKUP_FIXTURE"]).read_bytes())
    elif case == "chown_failed" and "chown -h" in args[-1]:
        sys.exit(1)
    elif case == "write_failed" and args[args.index("--user") + 1] == "1000:1000":
        sys.exit(1)
else:
    sys.exit(99)
'''


class VolumePermissionsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        docker = self.base / "docker"
        docker.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER)
        docker.chmod(0o755)
        self.log = self.base / "calls.jsonl"
        archive = self.base / "fixture.tar"
        with tarfile.open(archive, "w") as tar:
            entry = tarfile.TarInfo("test.txt")
            entry.size = 4
            tar.addfile(entry, io.BytesIO(b"test"))
        self.env = {
            **os.environ,
            "PATH": f"{self.base}:{os.environ['PATH']}",
            "DOCKER_CALLS": str(self.log),
            "PS_COUNT": str(self.base / "ps-count"),
            "BACKUP_FIXTURE": str(archive),
            "FTML_BACKUP_DIR": str(self.base / "backups"),
            "FTML_DATA_VOLUME": "ftml_data",
            "FTML_MODELS_VOLUME": "whisper_models",
        }

    def run_script(self, case="", args=("--apply",)):
        self.env["CASE"] = case
        return subprocess.run(["sh", str(SCRIPT), *args], env=self.env, capture_output=True, text=True)

    def calls(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_requires_explicit_apply(self):
        self.assertNotEqual(self.run_script(args=()).returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_refuses_unsafe_volume_names(self):
        self.env["FTML_DATA_VOLUME"] = "ftml_data,dst=/media"
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_refuses_same_volume(self):
        self.env["FTML_MODELS_VOLUME"] = "ftml_data"
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertEqual(self.calls(), [])

    def test_refuses_missing_shared_running_or_remapped_volumes(self):
        for case in ("missing", "shared", "running", "rootless", "userns"):
            with self.subTest(case=case):
                self.log.unlink(missing_ok=True)
                self.assertNotEqual(self.run_script(case).returncode, 0)
                self.assertFalse(any(call[0] == "run" for call in self.calls()))

    def test_backup_failure_prevents_chown(self):
        for case in ("backup_failed", "backup_invalid", "restarted"):
            with self.subTest(case=case):
                self.log.unlink(missing_ok=True)
                (self.base / "ps-count").unlink(missing_ok=True)
                self.assertNotEqual(self.run_script(case).returncode, 0)
                self.assertFalse(any("chown -h" in call[-1] for call in self.calls()))

    def test_chown_failure_does_not_report_success(self):
        for case in ("chown_failed", "write_failed"):
            with self.subTest(case=case):
                result = self.run_script(case)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("쓰기 확인 완료", result.stdout)

    def test_backups_then_changes_only_named_volumes_then_checks_nonroot(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        runs = [call for call in self.calls() if call[0] == "run"]
        self.assertEqual(len(runs), 4)
        for call in runs:
            self.assertEqual(call[call.index("--network") + 1], "none")
            self.assertIn("--read-only", call)
            self.assertNotIn("/media", " ".join(call))
            self.assertNotIn("docker.sock", " ".join(call))
        for backup in runs[:2]:
            self.assertIn("readonly", backup[backup.index("--mount") + 1])
            self.assertIn("tar", backup)
        self.assertIn("chown -h 1000:1000", runs[2][-1])
        self.assertIn("-xdev", runs[2][-1])
        self.assertNotIn("chmod", runs[2][-1])
        self.assertEqual(runs[3][runs[3].index("--user") + 1], "1000:1000")
        backups = list((self.base / "backups").glob("*/*.tar"))
        self.assertEqual(len(backups), 2)
        for backup in backups:
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            with tarfile.open(backup) as tar:
                self.assertEqual(tar.extractfile("test.txt").read(), b"test")


class RuntimeImageTests(unittest.TestCase):
    def test_compose_uses_default_stack_network_and_keeps_external_volumes(self):
        content = (ROOT / "docker-compose.yml").read_text()
        self.assertRegex(content, r"(?m)^networks:\n  default: \{\}")
        self.assertNotIn("homeserver-net", content)
        self.assertRegex(content, r"ftml_data:\s+external: true")
        self.assertRegex(content, r"whisper_models:\s+external: true")

    def test_compose_names_match_and_preserve_old_connection_aliases(self):
        content = (ROOT / "docker-compose.yml").read_text()
        for service in ("frontend", "backend", "whisper"):
            name = "ftml-" + service
            self.assertIn(f"  {name}:\n    container_name: {name}\n", content)
            self.assertIn(f"aliases: [{service}]", content)
            self.assertNotRegex(content, rf"(?m)^  {service}:")
            self.assertIn(f"  {name}:\n", (ROOT / "docker-compose.build.yml").read_text())
        self.assertIn("depends_on:\n      - ftml-backend", content)
        self.assertIn("  ftml-backend:\n", (ROOT / "docker-compose.nvidia.yml").read_text())

    def test_image_includes_context_alignment_module(self):
        content = (ROOT / "whisper/Dockerfile.openvino-genai").read_text()
        self.assertIn("qwen_context_alignment.py", content)
        allowed = (ROOT / "whisper/.dockerignore").read_text().splitlines()
        for line in content.splitlines():
            if line.startswith("COPY "):
                for filename in line.split()[1:-1]:
                    if filename.endswith(".py"):
                        self.assertTrue((ROOT / "whisper" / filename).is_file(), filename)
                        self.assertIn("!"+filename, allowed, filename)

    def test_media_mount_is_fixed_read_only_and_data_volume_is_preserved(self):
        content = (ROOT / "docker-compose.yml").read_text()
        self.assertRegex(content, r"target: /media\s+read_only: true")
        self.assertIn("- ftml_data:/data", content)
        self.assertNotIn("MEDIA_READ_ONLY", content)

    def test_writers_have_nonroot_default(self):
        for dockerfile in ("backend/Dockerfile", "whisper/Dockerfile.openvino-genai"):
            with self.subTest(dockerfile=dockerfile):
                content = (ROOT / dockerfile).read_text()
                self.assertEqual(re.findall(r"^USER\s+(.+)$", content, re.M)[-1], "1000:1000")
                self.assertIn("ENV HOME=/home/ftml", content)
                self.assertIn("chown -R 1000:1000", content)

    def test_whisper_caches_are_not_under_root(self):
        content = (ROOT / "whisper/Dockerfile.openvino-genai").read_text()
        env = dict(re.findall(r"^ENV (\w+)=(.+)$", content, re.M))
        self.assertEqual(env["HF_HOME"], "/models")
        self.assertEqual(env["HF_HUB_CACHE"], "/models/hub")
        self.assertEqual(env["NUMBA_CACHE_DIR"], "/home/ftml/.cache/numba")
        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")


if __name__ == "__main__":
    unittest.main()

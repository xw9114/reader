import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


def git(cwd: Path, *args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=cwd, text=True,
                                   stderr=subprocess.DEVNULL).strip()


class SerialGitTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "The serial runner uses Linux file locks")
    def test_remote_reader_update_merges_with_new_chapter(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            remote = root / "remote.git"
            subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            writer = root / "writer"
            reader = root / "reader"
            git(root, "clone", str(remote), str(writer))
            git(writer, "config", "user.name", "Test Writer")
            git(writer, "config", "user.email", "writer@example.test")
            (writer / "serial").mkdir()
            (writer / "serial" / "base.txt").write_text("base", encoding="utf-8")
            (writer / "README.md").write_text("original", encoding="utf-8")
            git(writer, "add", "serial", "README.md")
            git(writer, "commit", "-m", "Initial")
            git(writer, "push", "origin", "HEAD:main")

            git(root, "clone", str(remote), str(reader))
            git(reader, "config", "user.name", "Test Reader")
            git(reader, "config", "user.email", "reader@example.test")
            (reader / "README.md").write_text("updated reader", encoding="utf-8")
            git(reader, "add", "README.md")
            git(reader, "commit", "-m", "Update reader")
            git(reader, "push", "origin", "HEAD:main")

            (writer / "serial" / "chapter.txt").write_text("chapter 1", encoding="utf-8")
            path = Path(__file__).resolve().parents[1] / "serial" / "ops" / "daily-serial.py"
            spec = importlib.util.spec_from_file_location("daily_serial", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.REPOSITORY = writer
            commit = module.sync_git("Publish chapter")

            self.assertEqual(git(writer, "show", "HEAD:README.md"), "updated reader")
            self.assertEqual(git(writer, "show", "HEAD:serial/chapter.txt"), "chapter 1")
            self.assertEqual(commit, git(writer, "ls-remote", "origin", "refs/heads/main").split()[0])


if __name__ == "__main__":
    unittest.main()

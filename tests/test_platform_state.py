import json
import tempfile
import unittest
from pathlib import Path

from serial.ops.platform_state import normalize_platforms, update_platform_state


class PlatformStateTests(unittest.TestCase):
    def test_normalizes_missing_platforms_to_pending(self):
        state = normalize_platforms(None)
        self.assertEqual(state["fanqie"]["status"], "pending")
        self.assertEqual(state["qimao"]["status"], "pending")

    def test_update_is_atomic_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "run.json"
            path.write_text(json.dumps({"chapter": 1}), encoding="utf-8")
            update_platform_state(path, "fanqie", "draft_saved", remote_id="draft-1")
            update_platform_state(path, "fanqie", "draft_saved", remote_id="draft-1")
            value = json.loads(path.read_text(encoding="utf-8"))

        self.assertEqual(value["platforms"]["fanqie"]["status"], "draft_saved")
        self.assertEqual(value["platforms"]["fanqie"]["remoteId"], "draft-1")
        self.assertEqual(value["platforms"]["qimao"]["status"], "pending")
        self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()

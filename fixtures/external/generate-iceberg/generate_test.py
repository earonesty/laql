#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("generate.py")
SPEC = importlib.util.spec_from_file_location("generate", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"failed to load {MODULE_PATH}")
generate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = generate
SPEC.loader.exec_module(generate)


class EmptyDirectoryTest(unittest.TestCase):
    def test_preserves_output_directory_and_removes_children(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "case").mkdir()
            (output / "case" / "data.parquet").write_text("rows", encoding="utf8")
            (output / ".stale").write_text("stale", encoding="utf8")

            generate.empty_directory(output)

            self.assertTrue(output.is_dir())
            self.assertEqual([], list(output.iterdir()))

    def test_rejects_existing_non_directory_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "output"
            output.write_text("not a directory", encoding="utf8")

            with self.assertRaises(NotADirectoryError):
                generate.empty_directory(output)


if __name__ == "__main__":
    unittest.main()

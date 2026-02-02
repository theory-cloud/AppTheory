from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from apptheory.logger import NoOpLogger, get_logger, set_logger  # noqa: E402


class TestLogger(unittest.TestCase):
    def tearDown(self) -> None:
        set_logger(None)

    def test_default_logger_is_noop(self) -> None:
        logger = get_logger()
        self.assertIsNotNone(logger)
        self.assertTrue(logger.is_healthy())
        self.assertIsInstance(logger, NoOpLogger)

    def test_set_logger_replaces_and_resets(self) -> None:
        class CustomLogger(NoOpLogger):
            pass

        custom = CustomLogger()
        set_logger(custom)
        self.assertIs(get_logger(), custom)

        set_logger(None)
        self.assertIsInstance(get_logger(), NoOpLogger)

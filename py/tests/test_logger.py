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

    def test_noop_logger_methods_are_safe(self) -> None:
        logger = NoOpLogger()
        self.assertIsNone(logger.debug("d", {"k": "v"}))
        self.assertIsNone(logger.info("i", {"k": "v"}))
        self.assertIsNone(logger.warn("w", {"k": "v"}))
        self.assertIsNone(logger.error("e", {"k": "v"}))

        self.assertIs(logger.with_field("k", "v"), logger)
        self.assertIs(logger.with_fields({"k": "v"}), logger)
        self.assertIs(logger.with_request_id("req_1"), logger)
        self.assertIs(logger.with_tenant_id("ten_1"), logger)
        self.assertIs(logger.with_user_id("user_1"), logger)
        self.assertIs(logger.with_trace_id("trace_1"), logger)
        self.assertIs(logger.with_span_id("span_1"), logger)

        self.assertIsNone(logger.flush())
        self.assertIsNone(logger.close())
        self.assertTrue(logger.is_healthy())
        self.assertEqual(logger.get_stats(), {})

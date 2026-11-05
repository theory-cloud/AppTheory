"""Initialization-failure fixture: import-time failure for the Python runtime."""

raise RuntimeError("python init failure")


def handler(event, context):
    return {"ok": True}

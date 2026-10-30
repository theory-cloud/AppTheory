"""Real pinned tabletheory_py controls for the durable MCP stream store.

These controls drive ``DynamoMcpStreamStore`` and ``DynamoMcpTaskStore`` through
the real pinned ``tabletheory_py`` Table over its own
``StatefulDynamoDBClient``: real model validation, real request building, and
DynamoDB-faithful condition and pagination semantics. The ``_FakeTheoryTable``
controls in ``test_mcp.py`` cannot observe omitempty stripping or the client's
first-page cursor contract, so these tests are the real-backend seam for the
M3 aggregate state, expiry refresh, replay and delete behavior.
"""

from __future__ import annotations

import base64
import unittest
from datetime import UTC, datetime, timedelta
from typing import Any

from tabletheory_py import Table
from tabletheory_py.fakedb import StatefulDynamoDBClient

from apptheory import (
    DynamoMcpStreamStore,
    DynamoMcpTaskStore,
    McpTask,
    McpTaskRecord,
    default_mcp_stream_model,
    default_mcp_task_model,
    sequence_mcp_id_generator,
)
from apptheory.mcp import (
    DEFAULT_STREAM_AGGREGATE_VERSION,
    McpStreamAggregateBackfillError,
    McpStreamNotFoundError,
    _McpStreamItem,
)

STREAM_SESSION_ITEM_ID = "!session"


class _MutableClock:
    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def now(self) -> datetime:
        return self._moment

    def advance(self, seconds: int) -> None:
        self._moment = self._moment + timedelta(seconds=seconds)


def _create_table(name: str, sort_attribute: str = "itemId") -> StatefulDynamoDBClient:
    client = StatefulDynamoDBClient()
    client.create_table(
        TableName=name,
        KeySchema=[
            {"AttributeName": "sessionId", "KeyType": "HASH"},
            {"AttributeName": sort_attribute, "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "sessionId", "AttributeType": "S"},
            {"AttributeName": sort_attribute, "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )
    return client


def _stream_table(name: str) -> Table[Any]:
    return Table(default_mcp_stream_model(name), client=_create_table(name), table_name=name)


def _task_table(name: str) -> Table[Any]:
    return Table(default_mcp_task_model(name), client=_create_table(name, "taskId"), table_name=name)


def _stored(client: StatefulDynamoDBClient, table_name: str, session_id: str, item_id: str) -> dict[str, Any]:
    for item in client._tables[table_name].items.values():
        if item.get("sessionId", {}).get("S") == session_id and item.get("itemId", {}).get("S") == item_id:
            return item
    raise AssertionError(f"missing stored item {session_id}/{item_id} in {table_name}")


def _session_rows(
    client: StatefulDynamoDBClient,
    table_name: str,
    session_id: str,
    key_attribute: str = "itemId",
) -> list[dict[str, Any]]:
    return [
        item
        for item in client._tables[table_name].items.values()
        if item.get("sessionId", {}).get("S") == session_id and key_attribute in item
    ]


def _stream_store(
    table: Table[Any],
    table_name: str,
    *,
    clock: _MutableClock | None = None,
    streams: list[str] | None = None,
) -> DynamoMcpStreamStore:
    return DynamoMcpStreamStore(
        table=table,
        table_name=table_name,
        clock=clock or _MutableClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)),
        id_generator=sequence_mcp_id_generator(streams or ["stream-one"]),
    )


class RealPinnedClientStreamStoreTests(unittest.TestCase):
    def test_create_persists_explicit_zero_aggregate_state_and_first_append_succeeds(self) -> None:
        table = _stream_table("real-create")
        client = table._client
        store = _stream_store(table, "real-create", streams=["stream-one"])

        stream_id = store.create("sess-create")
        state = _stored(client, "real-create", "sess-create", STREAM_SESSION_ITEM_ID)
        self.assertEqual({"N": "0"}, state["sequence"])
        self.assertEqual({"N": "0"}, state["eventCount"])
        self.assertEqual({"N": "0"}, state["aggregateBytes"])
        self.assertEqual({"BOOL": False}, state["deleted"])
        self.assertEqual({"N": str(DEFAULT_STREAM_AGGREGATE_VERSION)}, state["aggregateVersion"])

        self.assertEqual("1", store.append("sess-create", stream_id, b"one"))
        state = _stored(client, "real-create", "sess-create", STREAM_SESSION_ITEM_ID)
        self.assertEqual({"N": "1"}, state["sequence"])
        self.assertEqual({"N": "1"}, state["eventCount"])
        self.assertEqual({"N": "3"}, state["aggregateBytes"])
        self.assertEqual({"BOOL": False}, state["deleted"])
        events = store.subscribe("sess-create", stream_id)
        self.assertEqual(["one"], [event.data.decode() for event in events])

    def test_second_create_extends_expiry_without_resetting_aggregate(self) -> None:
        table = _stream_table("real-refresh")
        client = table._client
        clock = _MutableClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC))
        store = _stream_store(table, "real-refresh", clock=clock, streams=["stream-one", "stream-two"])

        first = store.create("sess-refresh")
        self.assertEqual("1", store.append("sess-refresh", first, b"one"))
        self.assertEqual("2", store.append("sess-refresh", first, b"two"))
        before = _stored(client, "real-refresh", "sess-refresh", STREAM_SESSION_ITEM_ID)["expiresAt"]["N"]

        clock.advance(120)
        second = store.create("sess-refresh")
        self.assertEqual("stream-two", second)
        state = _stored(client, "real-refresh", "sess-refresh", STREAM_SESSION_ITEM_ID)
        self.assertEqual(str(int(before) + 120), state["expiresAt"]["N"])
        self.assertEqual({"N": "2"}, state["sequence"])
        self.assertEqual({"N": "2"}, state["eventCount"])
        self.assertEqual({"N": "6"}, state["aggregateBytes"])
        self.assertEqual({"BOOL": False}, state["deleted"])
        self.assertEqual("3", store.append("sess-refresh", second, b"three"))

    def test_seeded_complete_state_persists_and_refreshes_through_the_product_model(self) -> None:
        table = _stream_table("real-seeded")
        client = table._client
        table.put(
            _McpStreamItem(
                session_id="sess-seeded",
                item_id=STREAM_SESSION_ITEM_ID,
                stream_id="",
                kind="session",
                sequence=5,
                aggregate_version=DEFAULT_STREAM_AGGREGATE_VERSION,
                event_count=5,
                aggregate_bytes=15,
                deleted=False,
                expires_at=1000,
            )
        )
        state = _stored(client, "real-seeded", "sess-seeded", STREAM_SESSION_ITEM_ID)
        for attribute in ("sequence", "eventCount", "aggregateBytes", "deleted"):
            self.assertIn(attribute, state, "the real pinned client stripped an explicit aggregate value")

        store = _stream_store(table, "real-seeded", streams=["stream-refresh"])
        store.create("sess-seeded")
        state = _stored(client, "real-seeded", "sess-seeded", STREAM_SESSION_ITEM_ID)
        self.assertGreater(int(state["expiresAt"]["N"]), 1000)
        self.assertEqual({"N": "5"}, state["sequence"])
        self.assertEqual({"N": "5"}, state["eventCount"])
        self.assertEqual({"N": "15"}, state["aggregateBytes"])
        self.assertEqual({"BOOL": False}, state["deleted"])

    def test_legacy_live_state_refresh_does_not_fabricate_aggregate_counters(self) -> None:
        table = _stream_table("real-legacy")
        client = table._client
        table._client.put_item(
            TableName="real-legacy",
            Item={
                "sessionId": {"S": "sess-legacy"},
                "itemId": {"S": STREAM_SESSION_ITEM_ID},
                "kind": {"S": "session"},
                "expiresAt": {"N": "1000"},
            },
        )
        store = _stream_store(table, "real-legacy", streams=["stream-legacy"])

        stream_id = store.create("sess-legacy")
        state = _stored(client, "real-legacy", "sess-legacy", STREAM_SESSION_ITEM_ID)
        self.assertGreater(int(state["expiresAt"]["N"]), 1000, "second create must apply its expiry refresh")
        self.assertNotIn("aggregateVersion", state)
        self.assertNotIn("sequence", state)
        self.assertNotIn("eventCount", state)
        self.assertNotIn("aggregateBytes", state)

        with self.assertRaises(McpStreamAggregateBackfillError):
            store.append("sess-legacy", stream_id, b"x")
        state = _stored(client, "real-legacy", "sess-legacy", STREAM_SESSION_ITEM_ID)
        self.assertNotIn("aggregateVersion", state)
        self.assertNotIn("sequence", state)
        self.assertNotIn("eventCount", state)
        self.assertNotIn("aggregateBytes", state)
        events = [
            item
            for item in _session_rows(client, "real-legacy", "sess-legacy")
            if item["itemId"]["S"].startswith("EVENT#")
        ]
        self.assertEqual([], events)

    def test_conditional_refresh_never_reports_success_after_a_racing_tombstone(self) -> None:
        table = _stream_table("real-race")
        client = table._client
        store = _stream_store(table, "real-race", streams=["stream-one"])
        store.create("sess-race")
        before = _stored(client, "real-race", "sess-race", STREAM_SESSION_ITEM_ID)["expiresAt"]["N"]
        original_update = table.update

        def tombstoning_update(pk: Any, sk: Any, updates: Any, **kwargs: Any) -> Any:
            if (str(pk), str(sk)) == ("sess-race", STREAM_SESSION_ITEM_ID):
                raw = _stored(client, "real-race", "sess-race", STREAM_SESSION_ITEM_ID)
                raw["deleted"] = {"BOOL": True}
                client.put_item(TableName="real-race", Item=raw)
            return original_update(pk, sk, updates, **kwargs)

        table.update = tombstoning_update  # type: ignore[method-assign]
        with self.assertRaises(McpStreamNotFoundError):
            store.create("sess-race")
        state = _stored(client, "real-race", "sess-race", STREAM_SESSION_ITEM_ID)
        self.assertEqual({"BOOL": True}, state["deleted"])
        self.assertEqual(before, state["expiresAt"]["N"])

    def test_replay_delete_and_late_append_paginate_beyond_one_thousand_items(self) -> None:
        table = _stream_table("real-delete")
        client = table._client
        clock = _MutableClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC))
        store = _stream_store(table, "real-delete", clock=clock, streams=["stream-delete"])
        stream_id = store.create("sess-delete")
        expires_at = int(clock.now().timestamp()) + 86400
        event_count = 1205
        for index in range(event_count):
            table.put(
                _McpStreamItem(
                    session_id="sess-delete",
                    item_id=f"EVENT#{index + 1:04d}",
                    stream_id=stream_id,
                    kind="event",
                    sequence=index + 1,
                    event_id=str(index + 1),
                    data=base64.b64encode(b"x").decode("ascii"),
                    data_bytes=1,
                    expires_at=expires_at,
                )
            )
        table.update(
            "sess-delete",
            STREAM_SESSION_ITEM_ID,
            {"sequence": event_count, "event_count": event_count, "aggregate_bytes": event_count},
        )

        query_cursors: list[Any] = []
        original_query = table.query

        def recording_query(partition: Any, **kwargs: Any) -> Any:
            query_cursors.append(kwargs.get("cursor"))
            return original_query(partition, **kwargs)

        tombstone_first: list[bool] = []
        original_delete = table.delete

        def checking_delete(pk: Any, sk: Any = None, **kwargs: Any) -> Any:
            if not tombstone_first:
                state = _stored(client, "real-delete", "sess-delete", STREAM_SESSION_ITEM_ID)
                tombstone_first.append(state.get("deleted") == {"BOOL": True})
            return original_delete(pk, sk, **kwargs)

        table.query = recording_query  # type: ignore[method-assign]
        table.delete = checking_delete  # type: ignore[method-assign]

        events = store.subscribe("sess-delete", stream_id)
        self.assertEqual(event_count, len(events), "replay must page past the 1,000-item query limit")
        self.assertEqual([str(index) for index in range(1, event_count + 1)], [event.id for event in events])

        store.delete_session("sess-delete")
        self.assertEqual([True], tombstone_first, "delete_session must write the tombstone before deleting rows")
        self.assertIsNotNone(query_cursors)
        self.assertIsNone(query_cursors[0], "the first real-client query must use the None cursor contract")
        self.assertNotIn("", query_cursors, "an empty cursor is invalid on the real client")
        self.assertTrue(any(cursor is not None for cursor in query_cursors), "later page cursors must be preserved")

        remaining = [item for item in _session_rows(client, "real-delete", "sess-delete") if item["itemId"]["S"] != STREAM_SESSION_ITEM_ID]
        self.assertEqual([], remaining)
        state = _stored(client, "real-delete", "sess-delete", STREAM_SESSION_ITEM_ID)
        self.assertEqual({"BOOL": True}, state["deleted"])

        with self.assertRaises(McpStreamNotFoundError):
            store.subscribe("sess-delete", stream_id)
        with self.assertRaises(McpStreamNotFoundError):
            store.append("sess-delete", stream_id, b"late")
        with self.assertRaises(McpStreamNotFoundError):
            store.create("sess-delete")


class RealPinnedClientTaskStoreTests(unittest.TestCase):
    def test_task_list_and_delete_paginate_on_the_real_client(self) -> None:
        table = _task_table("real-tasks")
        client = table._client
        store = DynamoMcpTaskStore(table=table, clock=_MutableClock(datetime(2026, 1, 1, 0, 0, 0, tzinfo=UTC)))
        for index in range(1205):
            store.create(
                McpTaskRecord(
                    session_id="tasks",
                    method="tools/call",
                    task=McpTask(
                        task_id=f"task-{index:04d}",
                        created_at="2026-01-01T00:00:00Z",
                        last_updated_at="2026-01-01T00:00:00Z",
                        ttl=600000,
                    ),
                )
            )

        first_page = store.list({"session_id": "tasks", "limit": 500})
        self.assertEqual(500, len(first_page.tasks))
        self.assertNotEqual("", first_page.next_cursor)
        second_page = store.list({"session_id": "tasks", "limit": 500, "cursor": first_page.next_cursor})
        self.assertEqual(500, len(second_page.tasks))

        store.delete_session("tasks")
        self.assertEqual([], _session_rows(client, "real-tasks", "tasks", "taskId"))


if __name__ == "__main__":
    unittest.main()

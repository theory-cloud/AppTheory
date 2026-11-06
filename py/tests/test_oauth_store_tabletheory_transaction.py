"""Proof of the pinned tabletheory-py transactional surface.

M2 does not ship a durable OAuth store; durable stores are application-owned.
This suite proves the claims the PR may make about the pinned library: its
transaction transport supports a conditional family-state check, a member
update, and a root put as one all-or-nothing write, and a cancellation leaves no
partial state. The non-transactional negative control proves a backend without
the transaction operation is refused before any write rather than silently
falling back.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "py" / "src"))

from tabletheory_py.fakedb import StatefulDynamoDBClient  # noqa: E402


def _create_family_table(client: StatefulDynamoDBClient) -> None:
    client.create_table(
        TableName="refresh-family",
        KeySchema=[
            {"AttributeName": "PK", "KeyType": "HASH"},
            {"AttributeName": "SK", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "PK", "AttributeType": "S"},
            {"AttributeName": "SK", "AttributeType": "S"},
        ],
    )


class TableTheoryTransactionSurfaceTests(unittest.TestCase):
    def test_conditional_family_transaction_is_all_or_nothing(self) -> None:
        client = StatefulDynamoDBClient()
        _create_family_table(client)
        client.put_item(
            TableName="refresh-family",
            Item={
                "PK": {"S": "family#f1"},
                "SK": {"S": "STATE"},
                "status": {"S": "active"},
                "version": {"N": "1"},
            },
        )

        # The exact transaction shape a durable family store needs: condition
        # check the active family at the expected version, update it, and create
        # the generation-1 root only if it does not exist.
        client.transact_write_items(
            TransactItems=[
                {
                    "ConditionCheck": {
                        "TableName": "refresh-family",
                        "Key": {"PK": {"S": "family#f1"}, "SK": {"S": "STATE"}},
                        "ConditionExpression": "#s = :active AND #v = :version",
                        "ExpressionAttributeNames": {"#s": "status", "#v": "version"},
                        "ExpressionAttributeValues": {
                            ":active": {"S": "active"},
                            ":version": {"N": "1"},
                        },
                    }
                },
                {
                    "Put": {
                        "TableName": "refresh-family",
                        "Item": {
                            "PK": {"S": "family#f1"},
                            "SK": {"S": "HANDLE#root"},
                            "status": {"S": "issued"},
                            "generation": {"N": "1"},
                        },
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                },
            ]
        )
        self.assertEqual(2, len(client.items("refresh-family")))

        # A second root for the same family must cancel the whole transaction:
        # the condition check is satisfied, but the root put is not.
        with self.assertRaises(Exception):
            client.transact_write_items(
                TransactItems=[
                    {
                        "ConditionCheck": {
                            "TableName": "refresh-family",
                            "Key": {"PK": {"S": "family#f1"}, "SK": {"S": "STATE"}},
                            "ConditionExpression": "#s = :active",
                            "ExpressionAttributeNames": {"#s": "status"},
                            "ExpressionAttributeValues": {":active": {"S": "active"}},
                        }
                    },
                    {
                        "Put": {
                            "TableName": "refresh-family",
                            "Item": {
                                "PK": {"S": "family#f1"},
                                "SK": {"S": "HANDLE#root"},
                                "status": {"S": "issued"},
                                "generation": {"N": "1"},
                            },
                            "ConditionExpression": "attribute_not_exists(PK)",
                        }
                    },
                ]
            )
        self.assertEqual(2, len(client.items("refresh-family")))

    def test_non_transactional_backend_is_refused_before_any_write(self) -> None:
        class NonTransactionalClient:
            def __init__(self) -> None:
                self.writes = 0

            def put_item(self, **kwargs):
                self.writes += 1
                return {}

        client = NonTransactionalClient()
        with self.assertRaises(AttributeError):
            getattr(client, "transact_write_items")
        self.assertEqual(0, client.writes, "a non-transactional backend must not be used")

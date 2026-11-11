"""Facade verdict, post-timeout lineage-verify, and the exported refresh sweep.

The behavior here is the AppTheory half of the refresh-rotation-recovery
contract (theorycloud_refresh_rotation_recovery.v0.1 R7): a credential family
dies only from a contract-terminal verdict, a lost rotation is recovered rather
than punished, and the exported sweep entrypoint races the request path
transiently. The corpus itself is consumed in
``py/tests/test_mcpfacade_refresh_recovery.py``.
"""

from __future__ import annotations

import unittest

from apptheory import (
    DEFAULT_REFRESH_BUDGET_SECONDS,
    MAX_REFRESH_BUDGET_SECONDS,
    REFRESH_SWEEP_DEFERRED,
    REFRESH_SWEEP_ROTATED,
    REFRESH_SWEEP_TERMINAL_VERDICT,
    RefreshSweepConfig,
    RefreshSweeper,
    RouteRefreshPolicy,
)
from apptheory.mcpfacade import MAX_REFRESH_BUDGET_SECONDS as FACADE_MAX_BUDGET
from apptheory.oauth.provider import ERROR_INVALID_GRANT, ERROR_TEMPORARILY_UNAVAILABLE, ERROR_UPSTREAM, ProviderError
from apptheory.oauth.store import BrokerRevokedError, hash_key

from py.tests.test_mcpfacade_front_channel import (
    FRONT_TEST_REFRESH_ACCESS_TOKEN,
    FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
    FRONT_TEST_ROTATED_UPSTREAM_SCOPE,
    _FrontChannelHarness,
    _broker_record,
    _minted_refresh_handle,
    _refresh_form,
    _token_response_handle,
)
from apptheory.oauth.provider import TokenSet


def _successor_token_set() -> TokenSet:
    return TokenSet(
        access_token=FRONT_TEST_REFRESH_ACCESS_TOKEN,
        token_type="Bearer",
        expires_in=900,
        scope=FRONT_TEST_ROTATED_UPSTREAM_SCOPE,
        refresh_token=FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
    )


def _script_refresh(harness: _FrontChannelHarness, steps: list) -> list[int]:
    """Replaces the provider's refresh call with a fixed script so a case can
    drive the upstream sequence the local fake cannot produce (a lost rotation, or
    a verdict on a later attempt)."""
    calls = [0]

    def _refresh(_request):
        index = min(calls[0], len(steps) - 1)
        calls[0] += 1
        return steps[index]()

    harness.provider.refresh = _refresh
    return calls


def _sweeper(harness: _FrontChannelHarness) -> RefreshSweeper:
    return RefreshSweeper(
        RefreshSweepConfig(
            provider=harness.provider,
            stores=harness.stores,
            policy=RouteRefreshPolicy(
                handle_ttl_seconds=900,
                reuse_rate_ceiling=9,
                grace_window_seconds=120,
            ),
            now=harness.clock.now,
        )
    )


class RefreshVerdictTests(unittest.TestCase):
    def test_per_request_upstream_error_never_families(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        calls = _script_refresh(
            harness,
            [
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_UPSTREAM, "refresh")),
                _successor_token_set,
            ],
        )
        refused = harness.token(_refresh_form(handle))
        self.assertEqual(502, refused.status)
        self.assertIn(b'"error":"upstream_error"', refused.body)
        self.assertNotEqual("revoked", _broker_record(harness, handle).status)

        recovered = harness.token(_refresh_form(handle))
        self.assertEqual(200, recovered.status)
        self.assertEqual(2, calls[0])

    def test_stale_or_replaced_signal_is_recoverable(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        _script_refresh(
            harness,
            [
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, "refresh")),
                _successor_token_set,
            ],
        )
        transient = harness.token(_refresh_form(handle))
        self.assertEqual(503, transient.status)
        self.assertEqual("issued", _broker_record(harness, handle).status)

        recovered = harness.token(_refresh_form(handle))
        self.assertEqual(200, recovered.status)

    def test_lost_rotation_recovers_through_the_persisted_intent(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        _script_refresh(
            harness,
            [
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, "refresh")),
                _successor_token_set,
            ],
        )
        lost = harness.token(_refresh_form(handle))
        self.assertEqual(503, lost.status)
        marked = _broker_record(harness, handle)
        self.assertIsNotNone(marked.rotation_unconfirmed_at)
        self.assertEqual("issued", marked.status)
        self.assertEqual("", marked.refresh_lock_owner)

        recovered = harness.token(_refresh_form(handle))
        self.assertEqual(200, recovered.status)
        self.assertNotEqual(handle, _token_response_handle(recovered))
        rotated = _broker_record(harness, handle)
        self.assertEqual("active", rotated.status)
        self.assertIsNone(rotated.rotation_unconfirmed_at)

    def test_ambiguous_invalid_grant_is_transient_inside_the_horizon(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        _script_refresh(
            harness,
            [
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, "refresh")),
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_INVALID_GRANT, "refresh")),
            ],
        )
        self.assertEqual(503, harness.token(_refresh_form(handle)).status)
        ambiguous = harness.token(_refresh_form(handle))
        self.assertEqual(503, ambiguous.status)
        self.assertEqual("issued", _broker_record(harness, handle).status)

        harness.clock.advance(121)
        terminal = harness.token(_refresh_form(handle))
        self.assertEqual(400, terminal.status)
        self.assertIn(b'"error":"invalid_grant"', terminal.body)
        with self.assertRaises(BrokerRevokedError):
            harness.stores.route_refresh_broker.get(hash_key(handle))


class RefreshSweepTests(unittest.TestCase):
    def test_sweeper_rotates_the_head_and_the_request_path_serves_the_predecessor(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        family_hash = _broker_record(harness, handle).family_hash
        self.assertNotEqual("", family_hash)

        result = _sweeper(harness).sweep_family(family_hash)
        self.assertEqual(REFRESH_SWEEP_ROTATED, result.outcome)
        self.assertEqual(hash_key(handle), result.presented_handle_hash)
        self.assertNotEqual("", result.successor_handle_hash)
        self.assertEqual(2, result.chain_generation)

        served = harness.token(_refresh_form(handle))
        self.assertEqual(200, served.status)
        self.assertEqual(result.successor_handle_hash, hash_key(_token_response_handle(served)))

    def test_sweeper_defers_while_the_lock_is_held(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        record = _broker_record(harness, handle)
        harness.stores.route_refresh_broker.acquire_lock(record.handle_hash, "request-owner", record.version)

        result = _sweeper(harness).sweep_family(record.family_hash)
        self.assertEqual(REFRESH_SWEEP_DEFERRED, result.outcome)
        self.assertEqual("lock_contention", result.deferred_reason)
        self.assertEqual(1, len(harness.stores.route_refresh_broker.list_family(record.family_hash)))

    def test_sweeper_never_revokes_on_a_terminal_verdict(self) -> None:
        harness = _FrontChannelHarness(self)
        handle = _minted_refresh_handle(harness)
        family_hash = _broker_record(harness, handle).family_hash
        _script_refresh(
            harness,
            [lambda: (_ for _ in ()).throw(ProviderError(ERROR_INVALID_GRANT, "refresh"))],
        )
        result = _sweeper(harness).sweep_family(family_hash)
        self.assertEqual(REFRESH_SWEEP_TERMINAL_VERDICT, result.outcome)
        self.assertNotEqual("revoked", _broker_record(harness, handle).status)

    def test_sweeper_rejects_incomplete_configuration(self) -> None:
        harness = _FrontChannelHarness(self)
        with self.assertRaises(ValueError):
            RefreshSweeper(
                RefreshSweepConfig(
                    provider=None,  # type: ignore[arg-type]
                    stores=harness.stores,
                    policy=RouteRefreshPolicy(handle_ttl_seconds=900, reuse_rate_ceiling=9),
                )
            )
        with self.assertRaises(ValueError):
            RefreshSweeper(
                RefreshSweepConfig(
                    provider=harness.provider,
                    stores=None,
                    policy=RouteRefreshPolicy(handle_ttl_seconds=900, reuse_rate_ceiling=9),
                )
            )


class RefreshBudgetTests(unittest.TestCase):
    def test_budget_is_encoded_configuration(self) -> None:
        self.assertEqual(10, DEFAULT_REFRESH_BUDGET_SECONDS)
        self.assertEqual(12, MAX_REFRESH_BUDGET_SECONDS)
        self.assertEqual(MAX_REFRESH_BUDGET_SECONDS, FACADE_MAX_BUDGET)

        resolved = RouteRefreshPolicy(handle_ttl_seconds=900, reuse_rate_ceiling=9)
        sweeper = RefreshSweeper(
            RefreshSweepConfig(
                provider=_StubProvider(),
                stores=_StubStores(),
                policy=resolved,
            )
        )
        self.assertIsNotNone(sweeper)

        for budget in (-1, MAX_REFRESH_BUDGET_SECONDS + 1):
            with self.assertRaises(ValueError):
                RefreshSweeper(
                    RefreshSweepConfig(
                        provider=_StubProvider(),
                        stores=_StubStores(),
                        policy=RouteRefreshPolicy(
                            handle_ttl_seconds=900,
                            reuse_rate_ceiling=9,
                            refresh_budget_seconds=budget,
                        ),
                    )
                )


class _StubProvider:
    def discovery(self):  # pragma: no cover - never called
        raise AssertionError("not used")

    def authorization_url(self, req):  # pragma: no cover - never called
        raise AssertionError("not used")

    def exchange_code(self, req):  # pragma: no cover - never called
        raise AssertionError("not used")

    def refresh(self, req):  # pragma: no cover - never called
        raise AssertionError("not used")

    def validate_access_token(self, token, expected):  # pragma: no cover - never called
        raise AssertionError("not used")


class _StubStores:
    transaction = object()
    authorization_code = object()
    client = object()
    rate_limit = object()

    class _Family:
        def create_family(self, record):  # pragma: no cover - never called
            raise AssertionError("not used")

        def rotate_family(self, rotation):  # pragma: no cover - never called
            raise AssertionError("not used")

        def list_family(self, family_hash):  # pragma: no cover - never called
            return []

        def revoke_family(self, family_hash):  # pragma: no cover - never called
            return []

    route_refresh_broker = _Family()


if __name__ == "__main__":
    unittest.main()

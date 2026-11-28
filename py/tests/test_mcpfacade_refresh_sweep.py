"""Facade verdict, post-timeout lineage-verify, and the exported refresh sweep.

The behavior here is the AppTheory half of the refresh-rotation-recovery
contract (theorycloud_refresh_rotation_recovery.v0.1 R7): a credential family
dies only from a contract-terminal verdict, a lost rotation is recovered rather
than punished, and the exported sweep entrypoint races the request path
transiently. The corpus itself is consumed in
``py/tests/test_mcpfacade_refresh_recovery.py``.
"""

from __future__ import annotations

import time
import unittest
from typing import Any

from apptheory import (
    DEFAULT_REFRESH_BUDGET_SECONDS,
    MAX_REFRESH_BUDGET_SECONDS,
    REFRESH_SWEEP_DEFERRED,
    REFRESH_SWEEP_ROTATED,
    REFRESH_SWEEP_TERMINAL_VERDICT,
    ROUTE_REFRESH_EVENT_STATE_FAILURE,
    ROUTE_REFRESH_EVENT_UPSTREAM_REAUTH_REQUIRED,
    RefreshSweepConfig,
    RefreshSweeper,
    RouteRefreshPolicy,
    create_app,
    register_mcp_facade,
)
from apptheory.mcpfacade import MAX_REFRESH_BUDGET_SECONDS as FACADE_MAX_BUDGET
from apptheory.oauth.provider import (
    ERROR_INVALID_GRANT,
    ERROR_REAUTH_REQUIRED,
    ERROR_TEMPORARILY_UNAVAILABLE,
    ERROR_UPSTREAM,
    ProviderError,
)
from apptheory.oauth.store import BrokerRevokedError, hash_key

from py.tests.test_mcpfacade_front_channel import (
    FRONT_TEST_REFRESH_ACCESS_TOKEN,
    FRONT_TEST_ROTATED_UPSTREAM_REFRESH_TOKEN,
    FRONT_TEST_ROTATED_UPSTREAM_SCOPE,
    _EventRecorder,
    _FrontChannelHarness,
    _broker_record,
    _minted_refresh_handle,
    _policy_test_config,
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

    def test_reauth_required_keeps_the_family(self) -> None:
        # Mirror of Go's TestRefreshGrantReauthRequiredKeepsTheFamily: the
        # defensive `reauth_required` class means the recorded material is stale
        # or replaced, which the rotation-recovery contract classifies as
        # recovery-available. It is never a family verdict, so the facade releases
        # the lock, leaves the family untombstoned, answers 503 + Retry-After, and
        # the very next attempt reaches the upstream and rotates.
        recorder = _EventRecorder()
        harness = _FrontChannelHarness(self, route_refresh_events=recorder)
        handle = _minted_refresh_handle(harness)
        calls = _script_refresh(
            harness,
            [
                lambda: (_ for _ in ()).throw(ProviderError(ERROR_REAUTH_REQUIRED, "refresh")),
                _successor_token_set,
            ],
        )

        deferred = harness.token(_refresh_form(handle))
        self.assertEqual(503, deferred.status)
        self.assertIn(b'"error":"temporarily_unavailable"', deferred.body)
        self.assertEqual(["1"], deferred.headers.get("retry-after"))
        self.assertEqual(1, calls[0])
        self.assertIsNone(recorder.find(ROUTE_REFRESH_EVENT_UPSTREAM_REAUTH_REQUIRED))
        failure = recorder.require(ROUTE_REFRESH_EVENT_STATE_FAILURE)
        self.assertEqual(ERROR_REAUTH_REQUIRED, failure.upstream_class)
        self.assertEqual("temporarily_unavailable", failure.error_code)

        kept = _broker_record(harness, handle)
        self.assertEqual("issued", kept.status)
        self.assertEqual("", kept.refresh_lock_owner)
        self.assertIsNone(kept.refresh_lock_expires_at)
        family = harness.stores.route_refresh_broker.list_family(hash_key(handle))
        self.assertTrue(family)
        self.assertTrue(all(member.status != "revoked" for member in family))

        recovered = harness.token(_refresh_form(handle))
        self.assertEqual(200, recovered.status)
        self.assertNotEqual(handle, _token_response_handle(recovered))
        self.assertEqual(2, calls[0])
        self.assertEqual("active", _broker_record(harness, handle).status)

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


class _ReportingProvider:
    """Delegates every provider leg to the harness adapter and answers the
    transport-bound reporter question, so a case can register a policy the
    transport can or cannot honor."""

    def __init__(self, inner: Any, fetch_timeout_seconds: float) -> None:
        self._inner = inner
        self._fetch_timeout_seconds = fetch_timeout_seconds

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def upstream_fetch_timeout_seconds(self) -> float:
        return self._fetch_timeout_seconds


def _sweeper_with(
    harness: _FrontChannelHarness,
    *,
    provider: Any = None,
    events: Any = None,
    budget_seconds: int | None = None,
) -> RefreshSweeper:
    return RefreshSweeper(
        RefreshSweepConfig(
            provider=harness.provider if provider is None else provider,
            stores=harness.stores,
            policy=RouteRefreshPolicy(
                handle_ttl_seconds=900,
                reuse_rate_ceiling=9,
                grace_window_seconds=120,
                refresh_budget_seconds=budget_seconds,
            ),
            events=events,
            now=harness.clock.now,
        )
    )


def _raise_unavailable() -> Any:
    raise RuntimeError("store unavailable")


class RefreshSweepDeferralEventTests(unittest.TestCase):
    """Issue #1283: every deferred sweep tick is reported.

    A silent deferral is indistinguishable from a sweep that never ran, so a
    soak or alarm that counts route refresh events alone could not see an inert
    sweeper. Every deferred branch emits exactly one ``state_failure`` event
    carrying the reason the result reports, and a branch that resolved no record
    invents no identity for the event."""

    def test_every_deferral_is_reported_as_one_state_failure_event(self) -> None:
        def _unreadable_family(harness: _FrontChannelHarness, _record: Any) -> None:
            harness.stores.route_refresh_broker.list_family = lambda _hash: _raise_unavailable()

        def _lock_contention(harness: _FrontChannelHarness, record: Any) -> None:
            harness.stores.route_refresh_broker.acquire_lock(record.handle_hash, "request-owner", record.version)

        def _intent_write_failure(harness: _FrontChannelHarness, _record: Any) -> None:
            harness.stores.route_refresh_broker.compare_and_swap = lambda *_a, **_k: _raise_unavailable()

        def _upstream_rejected(harness: _FrontChannelHarness, _record: Any) -> None:
            _script_refresh(
                harness,
                [lambda: (_ for _ in ()).throw(ProviderError(ERROR_TEMPORARILY_UNAVAILABLE, "refresh"))],
            )

        def _commit_race(harness: _FrontChannelHarness, _record: Any) -> None:
            harness.stores.route_refresh_broker.rotate_family = lambda *_a, **_k: _raise_unavailable()

        cases: tuple[tuple[str, Any, str, bool], ...] = (
            ("unreadable_family", _unreadable_family, "family_state_unavailable", False),
            ("lock_contention", _lock_contention, "lock_contention", False),
            ("rotation_intent_write_failure", _intent_write_failure, "rewrite_failure", False),
            ("upstream_rejected", _upstream_rejected, "upstream_rejected", True),
            ("commit_race", _commit_race, "rewrite_failure", False),
        )
        for name, stage, reason, resolves_head in cases:
            with self.subTest(case=name):
                recorder = _EventRecorder()
                harness = _FrontChannelHarness(self)
                handle = _minted_refresh_handle(harness)
                record = _broker_record(harness, handle)
                stage(harness, record)

                result = _sweeper_with(harness, events=recorder).sweep_family(record.family_hash)

                self.assertEqual(REFRESH_SWEEP_DEFERRED, result.outcome)
                self.assertEqual(reason, result.deferred_reason)
                failures = [
                    event for event in recorder.events if event.event_class == ROUTE_REFRESH_EVENT_STATE_FAILURE
                ]
                self.assertEqual(1, len(failures), f"{name}: expected one state_failure event, saw {recorder.events!r}")
                self.assertEqual(reason, failures[0].reason)
                if resolves_head:
                    # This branch defers after the head is resolved, so the event
                    # keeps the identity the existing upstream failure carries.
                    self.assertEqual(record.handle_hash, failures[0].handle_hash)
                else:
                    self.assertEqual("", failures[0].handle_hash)
                    self.assertEqual("", failures[0].family_hash)
                    self.assertEqual("", failures[0].successor_handle_hash)
                self.assertIsNotNone(failures[0].at)

                # A deferral is never a family event.
                kept = _broker_record(harness, handle)
                self.assertNotEqual("revoked", kept.status)
                self.assertEqual(record.family_hash, kept.family_hash)


class RefreshBudgetTransportTests(unittest.TestCase):
    """Issue #1283: an encoded budget is honored or refused, never silently cut.

    The facade applies ``refresh_budget_seconds`` as the deadline of the upstream
    call, but the adapter's own transport bound ends the call first when it is
    shorter, so ``12`` against a ``10`` s transport was really ``10``. Registration
    refuses that pair and names both values; a budget the transport can honor
    stays the binding deadline."""

    def test_budget_longer_than_the_provider_transport_is_refused(self) -> None:
        harness = _FrontChannelHarness(self)
        reporting = _ReportingProvider(harness.provider, float(DEFAULT_REFRESH_BUDGET_SECONDS))

        with self.assertRaises(ValueError) as refused:
            register_mcp_facade(
                create_app(),
                _policy_test_config(
                    harness,
                    RouteRefreshPolicy(
                        handle_ttl_seconds=900,
                        reuse_rate_ceiling=9,
                        refresh_budget_seconds=12,
                    ),
                    provider=reporting,
                ),
            )
        message = str(refused.exception)
        self.assertIn("12s", message)
        self.assertIn("10s", message)
        self.assertIn("upstream fetch timeout", message)
        self.assertIn("raise the provider's fetch timeout", message)

        # The same pair through the exported sweeper.
        with self.assertRaises(ValueError) as sweep_refused:
            _sweeper_with(harness, provider=reporting, budget_seconds=12)
        self.assertIn("12s", str(sweep_refused.exception))
        self.assertIn("10s", str(sweep_refused.exception))

        # The comparison is against the reported bound, not a constant.
        with self.assertRaises(ValueError) as narrow:
            _sweeper_with(harness, provider=_ReportingProvider(harness.provider, 2.0), budget_seconds=5)
        self.assertIn("5s", str(narrow.exception))
        self.assertIn("2s", str(narrow.exception))

    def test_budget_the_transport_can_honor_stays_the_binding_deadline(self) -> None:
        harness = _FrontChannelHarness(self)

        # An equal bound and a longer bound are accepted; a provider that states
        # no bound is unchecked, because the reporter is how a provider becomes
        # answerable, never a new requirement.
        for fetch_timeout_seconds in (float(MAX_REFRESH_BUDGET_SECONDS), 30.0):
            with self.subTest(fetch_timeout_seconds=fetch_timeout_seconds):
                sweeper = _sweeper_with(
                    harness,
                    provider=_ReportingProvider(harness.provider, fetch_timeout_seconds),
                    budget_seconds=MAX_REFRESH_BUDGET_SECONDS,
                )
                self.assertIsInstance(sweeper, RefreshSweeper)
        self.assertIsInstance(_sweeper_with(harness, budget_seconds=MAX_REFRESH_BUDGET_SECONDS), RefreshSweeper)

        # The encoded budget, not the adapter's longer transport default, decides
        # whether an answer is current: the synchronous provider SPI cannot be
        # interrupted, so the facade refuses to act on an answer that outlived
        # the budget it was configured with.
        handle = _minted_refresh_handle(harness)
        record = _broker_record(harness, handle)
        _script_refresh(harness, [lambda: time.sleep(1.05) or _successor_token_set()])
        events = _EventRecorder()
        result = _sweeper_with(
            harness,
            provider=_ReportingProvider(harness.provider, float(MAX_REFRESH_BUDGET_SECONDS)),
            events=events,
            budget_seconds=1,
        ).sweep_family(record.family_hash)

        self.assertEqual(REFRESH_SWEEP_DEFERRED, result.outcome)
        self.assertEqual("upstream_rejected", result.deferred_reason)
        failures = [event for event in events.events if event.event_class == ROUTE_REFRESH_EVENT_STATE_FAILURE]
        self.assertEqual(1, len(failures))
        self.assertNotEqual("revoked", _broker_record(harness, handle).status)

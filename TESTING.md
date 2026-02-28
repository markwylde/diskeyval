# Testing Strategy

This project is intentionally test-heavy. The target is to maintain more test code and scenarios than implementation code during early phases.

## Principles

- Test first for every consensus behavior.
- Prefer deterministic simulation over flaky timing-only checks.
- Every bug gets a regression test before the fix is merged.
- No protocol change without unit + simulation + e2e coverage.

## Suite Layers

1. Unit tests (`test/unit`)
- Pure protocol/state-machine behavior.
- No real sockets.
- Deterministic clocks/network fakes.

2. Simulation tests (`test/sim`)
- Multi-node in-memory cluster.
- Partition, drop, delay, reordering, and clock-skew scenarios.

3. End-to-end tests (`test/e2e`)
- Real processes, real sockets, real mTLS certs.
- Crash/restart and leadership churn.

4. Soak/chaos tests (`test/soak`)
- Long-running stability and throughput checks.
- Randomized failures and recoveries.

## Coverage Targets

- Raft invariants: 100% scenario coverage for leader election, log matching, and commit monotonicity.
- API semantics: 100% coverage for majority-commit `set` and linearizable `get` behavior.
- Transport/auth: certificate validation, identity binding, and rejection cases.

## Scenario Backlog (High Priority)

### Election and leadership
- Single leader elected in a stable 3-node cluster.
- No dual leaders in the same term.
- Follower timeout causes candidacy.
- Split vote retries with term bump.
- Outdated term candidate is rejected.
- Leader steps down on higher term append.

### Log replication and commit
- Leader appends and replicates entry to majority.
- Entry is committed only after majority.
- Follower log conflict is truncated and corrected.
- Commit index advances monotonically.
- Applied index never exceeds commit index.
- Old leader cannot commit after losing quorum.

### Read correctness
- Leader read barrier returns committed value.
- Stale leader read is rejected or redirected.
- Read after write is linearizable.
- Read during leadership change preserves linearizability.

### Failure handling
- Minority partition cannot commit writes.
- Majority partition continues serving writes.
- Rejoined node catches up from log.
- Node crash and restart rejoin behavior.
- Network delay and reordering resilience.

### Security and transport
- Node with unknown CA is rejected.
- Node with invalid cert signature is rejected.
- Node ID mismatch to cert identity is rejected.
- Expired cert is rejected.
- Valid mTLS peers can form cluster.

### API behavior
- `set` resolves only after majority commit.
- `set` times out cleanly when quorum unavailable.
- `get` returns majority-committed state.
- `change` event emits once per committed update.
- `leader` event emits on leadership transitions.

## Merge Gates

A change should not merge unless:

- Relevant unit tests are present and passing.
- At least one simulation or e2e case covers the behavior.
- Regression tests exist for any fixed defect.

## CI Plan

- PR: `unit + sim` mandatory.
- Main branch: `unit + sim + e2e` mandatory.
- Nightly: `soak` and extended chaos scenarios.

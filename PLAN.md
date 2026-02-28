# diskeyval Implementation Plan

## Goal
Build a fast distributed key/value store with majority-based semantics:

- `set(key, value)` resolves after majority commit.
- `get(key)` resolves from majority-committed state.
- Node-to-node trust is established with CA-signed mTLS certificates.
- Raft logic is isolated into its own module so it can later be extracted as a standalone package.
- Test surface is intentionally larger than implementation surface.

## Testing-First Policy

- More tests than implementation code until v1 semantics are stable.
- New behavior must land with tests in `unit` plus `sim` or `e2e`.
- Every production bug gets a regression test before fix merge.
- CI blocks merges when required suites fail.

Target ratios (early project):

- Unit test count >= 2x exported Raft/API methods.
- Total test scenarios >= 90 before first feature-complete milestone.
- Safety invariants must be asserted in every simulation/e2e run.

## Architecture

### Module A: `raft-core` (isolated consensus module)
Responsibilities:

- Leader election (follower/candidate/leader roles)
- Heartbeats and election timeouts
- Log replication (`AppendEntries`)
- Vote requests (`RequestVote`)
- Commit index advancement after majority replication
- Apply committed entries through a state machine callback
- Read path support for linearizable reads (leader read barrier / read index)

Public API target:

- `start()`, `stop()`
- `propose(command): Promise<CommitResult>`
- `readBarrier(): Promise<void>`
- events: `leader`, `commit`, `role-change`

Non-goals for v1:

- Dynamic cluster reconfiguration
- Snapshot streaming
- Disk-backed WAL compaction

### Module B: `diskeyval` (store + user API)
Responsibilities:

- Public API (`start`, `set`, `get`, `end`)
- In-memory materialized map (`state`)
- Eventing (`change`, `leader`)
- Command encoding/decoding for the Raft state machine
- Routing client writes to leader (or forwarding)

### Module C: transport/security
Responsibilities:

- mTLS transport between nodes
- Certificate validation against cluster CA
- Peer identity checks (`nodeId` matches certificate identity)
- RPC framing and message serialization

## Delivery Phases

## Phase 0: Test Harness First
- Establish suite layout: `test/unit`, `test/sim`, `test/e2e`, `test/soak`.
- Define initial scenario matrix and acceptance gates.
- Build deterministic simulation harness interfaces before protocol implementation.

Exit criteria:
- Test runners exist for each suite and scenario inventory is committed.

## Phase 1: Local Raft Core Skeleton
- Create `lib/raft/` module boundaries and types.
- Implement role machine + timers + term transitions.
- Add message handlers for `RequestVote` and empty `AppendEntries`.
- Unit test election safety basics and timer behavior.

Exit criteria:
- Leader election stabilizes in a 3-node in-memory simulated cluster.

## Phase 2: Replicated Log + Majority Commit
- Add log entries and replication indexes (`nextIndex`, `matchIndex`).
- Implement majority commit rule.
- Apply committed entries in order to state machine callback.
- Wire `diskeyval.set` to `raft.propose`.

Exit criteria:
- `set` resolves only after majority commit in 3-node simulation.

## Phase 3: Read Correctness
- Implement linearizable reads via `readBarrier()` on leader.
- Wire `diskeyval.get` through read barrier.
- Add tests for stale-leader prevention.

Exit criteria:
- `get` never returns uncommitted or stale values after leader changes.

## Phase 4: Real Transport + mTLS
- Replace in-memory transport with socket RPC transport.
- Add mTLS handshake and cert validation.
- Enforce `nodeId`/certificate identity mapping.

Exit criteria:
- Multi-process local cluster can elect leader and commit writes over mTLS.

## Phase 5: Reliability + Performance
- Add retry/backoff for replication RPCs.
- Add batching/pipelining for append entries.
- Add metrics hooks (latency, commit lag, election count).
- Start WAL/snapshot design for restart durability.

Exit criteria:
- Stable behavior under node restarts/network jitter in integration tests.

## Testing Strategy

- Unit tests for term/vote/commit invariants and edge cases.
- Simulation tests for partitions, recoveries, delays, drops, and reorderings.
- Integration/e2e tests for mTLS, multi-process cluster behavior, crash/restart.
- Property tests for log matching and monotonic commit index.
- Soak/chaos tests for long-running stability and latency/lag budgets.

## Merge Gates

- Protocol code change: requires `test:unit` and `test:sim`.
- Transport/security change: requires `test:unit` and `test:e2e`.
- Release candidate: requires `test:all` plus soak run report.

## Key Invariants (must always hold)

- At most one leader per term.
- Committed entries never roll back.
- A node applies entries in log order only.
- `set` success implies majority persistence in memory/log.
- `get` is served from majority-committed state.

## Milestone Sequence

1. Raft core skeleton in-process simulation
2. Majority commit + `set` semantics
3. Linearizable `get`
4. mTLS transport
5. Performance passes and durability

## Status

- Phase 0: completed
- Phase 1: completed
- Phase 2: completed
- Phase 3: completed
- Phase 4: completed
- Phase 5: completed

Verification:

- Real test suites are executable (no placeholder todo tests).
- Unit + simulation + mTLS e2e + soak pass in CI command path (`npm test`).

## Notes

- Keep `raft-core` free of app/store concerns so it can become its own package.
- Prefer small, composable interfaces between raft, transport, and store.
- Start with in-memory first for speed, then layer network/durability.

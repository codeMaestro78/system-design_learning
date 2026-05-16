# Part 7: Advanced Distributed Systems Topics (Deep)

## 1) Distributed Consensus (Raft, Paxos)

### Why it exists
Need a safe way for multiple nodes to agree on ordered state transitions despite failures.

### Core concepts
- Single leader (in many practical protocols)
- Log replication
- Majority quorum commit
- Safety over availability under partition

### Practical understanding
Consensus is often used for metadata/config/control planes, not for every user-data operation.

---

## 2) Leader Election
- Ensures one active coordinator.
- Needs split-brain prevention.
- Requires leases/fencing and monotonic terms/epochs.

## 3) Gossip Protocols
- Probabilistic dissemination for membership and state.
- Scales well, converges eventually, not instantaneously.

## 4) CRDTs
- Data structures that merge deterministically without coordination.
- Useful for collaborative/offline edits.
- Tradeoff: semantics complexity and storage overhead in some designs.

## 5) Time Synchronization and Clock Problems
- Wall clocks drift.
- NTP adjustments can move time backward/forward.
- Use monotonic clock for durations/timeouts.
- Use logical timestamps for ordering when strict wall-clock order is unsafe.

## 6) Distributed Locking
- Lock with lease timeout.
- Use fencing token to avoid stale lock holder writes.
- Prefer idempotency/commutative updates when possible.

## 7) Idempotency
- Required in distributed retries.
- Same operation key should produce same effect.

### Pattern
```text
if key_seen: return stored_result
process_once()
store_result_for_key()
```

## Advanced Exercises
1. Design distributed cron scheduler with leader election.
2. Add fencing-token lock to prevent stale writer corruption.
3. Compare Raft-based config store vs DB table-based config storage.

## Sophisticated Distributed Systems Roadmap

### Topics and subtopics
- Consensus: Raft log replication, quorum, leader terms, commit index.
- Leader election: leases, fencing tokens, split-brain prevention.
- Replication: sync, async, quorum, multi-leader conflict resolution.
- Time: wall clock, monotonic clock, logical clock, vector clock.
- Coordination: locks, leases, barriers, service discovery.
- Consistency: linearizability, serializability, causal consistency, eventual consistency.
- Conflict-free data: CRDT counters, sets, registers, collaborative state.
- Multi-region: data residency, latency, failover, active-active writes.

### Example: distributed scheduler
```text
Scheduler Nodes
  -> Leader Election Store
  -> Job Metadata DB
  -> Lease Table
  -> Work Queue
  -> Worker Pool
```

Correctness requirements:
- Only one scheduler instance claims a job lease at a time.
- Workers use idempotency keys.
- Expired leases can be reclaimed.
- Fencing tokens prevent stale leaders from writing.

### Real systems to study
- ZooKeeper/etcd/Consul for coordination.
- Kafka partitions and consumer groups.
- Dynamo-style quorum systems.
- Google Spanner-style globally consistent transactions.

### Design exercise
Design a feature flag control plane:
- Strongly consistent writes.
- Low-latency reads.
- Multi-region replication.
- Emergency kill switch.
- Audit log and rollback.

## Rigorous Distributed Correctness

### Correctness vocabulary
```text
Linearizable      -> every read sees latest completed write
Serializable      -> transactions behave as some serial order
Causal            -> causally related events are observed in order
Eventual          -> replicas converge if writes stop
At-least-once     -> duplicates possible, loss unlikely
At-most-once      -> loss possible, duplicates avoided
Exactly-once      -> usually achieved as idempotent processing + transactions
```

### Distributed lock checklist
- Use leases with expiry.
- Use fencing tokens.
- Never trust wall-clock alone for correctness.
- Design for lock holder crash.
- Prefer idempotent operations over locks where possible.

### Multi-region architecture
```text
Users -> Global Traffic Manager
      -> Nearest Region
        -> Regional Services
        -> Regional Data Store
        -> Async Replication Stream
      -> Control Plane / Conflict Resolution
```

### Failure questions
- What happens during network partition?
- Which side accepts writes?
- How are conflicts resolved?
- What is the maximum data loss window?
- How is failback performed safely?

---

## Advanced Failure Semantics Addendum

### Exactly-once reality check
In distributed systems, "exactly once" is usually achieved by:
- at-least-once delivery
- idempotent processing
- dedupe keys and state

### Split-brain prevention checklist
- Majority quorum enforcement
- Epoch/term monotonicity
- Fencing tokens on side effects
- Fast fail-safe mode if quorum lost

### Logical clocks and causality
- Lamport clocks: order events, not true causality richness.
- Vector clocks: detect concurrent updates.

### Consensus operational concerns
- Snapshotting and log compaction
- Membership changes (joint consensus patterns)
- Slow follower impact

### Exercise
Design lock service API with:
`acquire(lock, ttl)`, `renew(token)`, `release(token)` and fencing guarantees.

---

## Code Implementation: Raft Consensus (Simplified Simulation)

Raft is the consensus algorithm behind **etcd**, **CockroachDB**, **TiKV**, and **Consul**.
The simulation below shows the state machine logic without actual network I/O — the
core correctness reasoning is identical to a production implementation.

### Why Raft is elegant

```text
Paxos is famously hard to understand and implement correctly.
Raft was designed specifically for understandability:

  - Decomposed into two independent sub-problems:
      1. Leader Election   (who has authority to propose changes?)
      2. Log Replication   (how does the leader replicate its decisions?)

  - One leader per term: all writes go through a single leader.
    No concurrent proposals, no multi-phase prepare/promise dance.

  - Strong leader model: leader has complete log. Followers only accept
    entries from the current leader. Simpler than Paxos multi-leader.
```

### State machine overview

```text
Every Raft node is always in one of three states:

  FOLLOWER  ──(election timeout)──→  CANDIDATE  ──(wins majority)──→  LEADER
     ▲                                    │                               │
     │                                    │ (loses / discovers            │
     └────────────────────────────────────┘  higher-term leader)         │
     └────────────────────────────────────────────────────────────────────┘
                           (discovers higher term)

FOLLOWER:   Passive. Waits for heartbeats from leader.
            If no heartbeat within election_timeout → starts election.

CANDIDATE:  Increments term, votes for self, sends RequestVote to peers.
            If majority votes granted → becomes LEADER.
            If discovers higher-term node → reverts to FOLLOWER.

LEADER:     Sends periodic AppendEntries heartbeats to suppress elections.
            Handles all client writes: appends to log, replicates to majority,
            then commits (advances commit_index).
```

```python
"""
Raft Consensus — Simplified State Machine Simulation.

This is NOT a production implementation (no network, no persistence, no timers).
It demonstrates the exact state transitions, vote logic, and log replication
that a real Raft node executes. The correctness arguments are identical.

Run the demo at the bottom:  python -c "exec(open('raft_demo.py').read())"
"""

import random
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class RaftState(Enum):
    FOLLOWER  = "FOLLOWER"
    CANDIDATE = "CANDIDATE"
    LEADER    = "LEADER"


@dataclass
class LogEntry:
    """
    One entry in the replicated log.
    term:    the leader's term when this entry was created.
             Used during consistency checks (AppendEntries).
    index:   1-based position in the log (matches Raft paper convention).
    command: the state-machine command (e.g., "SET x=5", "COMMIT tx_42").
    """
    term:    int
    index:   int
    command: str


class RaftNode:
    """
    A single Raft node. In production: one process/goroutine per node,
    communicating over gRPC. Here: direct method calls simulate RPCs.

    Key invariants (from the Raft paper):
      Safety:      At most one leader per term.
      Log Matching: If two logs have an entry with same index and term,
                    all preceding entries are identical.
      Leader Completeness: A leader has all committed entries from prior terms.
    """

    def __init__(self, node_id: str, peer_ids: list[str]):
        self.node_id  = node_id
        self.peer_ids = peer_ids

        # ── Persistent state (must survive crashes; written to disk before RPC) ──
        self.current_term: int           = 0     # monotonically increasing
        self.voted_for:    Optional[str] = None  # candidate_id voted for this term
        self.log:          list[LogEntry] = []   # command log (1-indexed in Raft)

        # ── Volatile state (recomputed on restart) ──
        self.state:        RaftState = RaftState.FOLLOWER
        self.commit_index: int       = 0   # highest log entry known committed
        self.last_applied: int       = 0   # highest entry applied to state machine

        # ── Leader-only volatile state (reinitialized after each election) ──
        # next_index[peer]:  next log index to send to that peer
        # match_index[peer]: highest index known to be replicated on that peer
        self.next_index:  dict[str, int] = {}
        self.match_index: dict[str, int] = {}

        # ── Election timer ──
        # WHY RANDOMIZED (150–300ms)?
        # If all nodes used the same timeout, they'd all start elections
        # simultaneously, vote for themselves, and split votes forever.
        # Randomization gives one node a head start → it wins cleanly.
        # This is called "randomized election timeout" and it's the key
        # insight that makes Raft's leader election work in practice.
        self.election_timeout: float = random.uniform(0.15, 0.30)
        self.last_heartbeat:   float = time.time()

        self._lock = threading.Lock()

    # ────────────────────────────────────────────────────────────
    # RPC Handler 1: RequestVote
    # ────────────────────────────────────────────────────────────

    def handle_request_vote(
        self,
        term:           int,
        candidate_id:   str,
        last_log_index: int,
        last_log_term:  int,
    ) -> tuple[int, bool]:
        """
        RequestVote RPC — called by a CANDIDATE on all peers.
        Returns (current_term, vote_granted).

        Vote is granted only if ALL conditions hold:
          1. Candidate's term >= our current term.
          2. We haven't voted for a different candidate this term.
          3. Candidate's log is "at least as up-to-date" as ours.

        "At least as up-to-date" (Raft §5.4.1):
          - Higher last_log_term wins.
          - If terms equal, longer log wins.
          This prevents a stale node (missing committed entries)
          from becoming leader and overwriting committed data.

        MAJORITY QUORUM SAFETY:
          With N=5 nodes, quorum=3.
          Two candidates cannot both get 3 votes because
          vote sets must overlap (3+3 > 5), and each node
          votes only once per term (voted_for is monotonic).
          So at most one leader exists per term — safety guaranteed.
        """
        with self._lock:
            # Rule: higher term → immediately revert to follower
            if term > self.current_term:
                self.current_term = term
                self.state        = RaftState.FOLLOWER
                self.voted_for    = None   # reset vote for new term

            my_last_term  = self.log[-1].term if self.log else 0
            my_last_index = len(self.log)

            # "At least as up-to-date" comparison
            candidate_log_ok = (
                last_log_term > my_last_term
                or (last_log_term == my_last_term and last_log_index >= my_last_index)
            )

            vote_granted = (
                term >= self.current_term
                and (self.voted_for is None or self.voted_for == candidate_id)
                and candidate_log_ok
            )

            if vote_granted:
                self.voted_for  = candidate_id
                self.last_heartbeat = time.time()   # reset election timeout on valid RPC

            return self.current_term, vote_granted

    # ────────────────────────────────────────────────────────────
    # RPC Handler 2: AppendEntries  (heartbeat + log replication)
    # ────────────────────────────────────────────────────────────

    def handle_append_entries(
        self,
        term:           int,
        leader_id:      str,
        prev_log_index: int,
        prev_log_term:  int,
        entries:        list[LogEntry],
        leader_commit:  int,
    ) -> tuple[int, bool]:
        """
        AppendEntries RPC — serves TWO purposes:
          1. Heartbeat (entries=[]): tells followers "leader alive, reset timer"
          2. Log replication (entries=[...]): append new commands to follower log

        Returns (current_term, success).

        The prev_log_index / prev_log_term check is the "Log Matching" mechanism:
          Before appending new entries, verify our log matches the leader's
          at position prev_log_index. If it doesn't → we have a gap or conflict
          → reject → leader will back up next_index and retry.
          This ensures follower logs are always a prefix of the leader's log.
        """
        with self._lock:
            # Rule 1: stale leader → reject
            if term < self.current_term:
                return self.current_term, False

            # Valid leader: reset election timer, update term, become follower
            self.current_term   = term
            self.state          = RaftState.FOLLOWER
            self.last_heartbeat = time.time()

            # Rule 2: Log consistency check
            # Does our log contain an entry at prev_log_index with matching term?
            if prev_log_index > 0:
                if len(self.log) < prev_log_index:
                    # We don't even have prev_log_index → gap in log
                    return self.current_term, False
                if self.log[prev_log_index - 1].term != prev_log_term:
                    # Term mismatch: delete conflicting entry and everything after
                    # (these entries were never committed — safe to delete)
                    self.log = self.log[:prev_log_index - 1]
                    return self.current_term, False

            # Rule 3: Append new entries (overwrite conflicts)
            for i, entry in enumerate(entries):
                log_pos = prev_log_index + i   # 0-based position in self.log
                if log_pos < len(self.log):
                    if self.log[log_pos].term != entry.term:
                        # Conflict at this position: truncate and append
                        self.log = self.log[:log_pos]
                        self.log.append(entry)
                    # else: entry already present and matches — idempotent, skip
                else:
                    self.log.append(entry)

            # Rule 4: Advance commit index
            # If leader has committed more entries than we know, update.
            # min() ensures we don't claim committed beyond our own log length.
            if leader_commit > self.commit_index:
                self.commit_index = min(leader_commit, len(self.log))

            return self.current_term, True

    # ────────────────────────────────────────────────────────────
    # Election: FOLLOWER → CANDIDATE → (LEADER or back to FOLLOWER)
    # ────────────────────────────────────────────────────────────

    def start_election(self, all_nodes: dict[str, "RaftNode"]) -> bool:
        """
        Transition to CANDIDATE, increment term, vote for self,
        collect votes from peers, become LEADER if majority achieved.

        Returns True if this node became the new leader.

        Why term increment before voting?
          Term is a logical clock. Incrementing declares "I am starting
          a new election epoch." Any node still in the old term that
          receives our RequestVote will update its term and can grant vote.
        """
        with self._lock:
            self.state        = RaftState.CANDIDATE
            self.current_term += 1              # declare new election term
            self.voted_for    = self.node_id   # vote for ourselves
            term              = self.current_term

        votes  = 1                             # count our own vote
        n      = len(all_nodes)
        quorum = n // 2 + 1                    # majority threshold (e.g., 3 out of 5)

        my_last_term  = self.log[-1].term if self.log else 0
        my_last_index = len(self.log)

        for peer_id, peer_node in all_nodes.items():
            if peer_id == self.node_id:
                continue
            _, granted = peer_node.handle_request_vote(
                term           = term,
                candidate_id   = self.node_id,
                last_log_index = my_last_index,
                last_log_term  = my_last_term,
            )
            if granted:
                votes += 1
            if votes >= quorum:
                break   # optimization: stop early once we have majority

        with self._lock:
            # Only become leader if we're still a candidate for this term.
            # We might have reverted to FOLLOWER if a higher-term node responded.
            if self.state == RaftState.CANDIDATE and self.current_term == term:
                if votes >= quorum:
                    self.state = RaftState.LEADER
                    # Initialize leader state for all peers
                    for peer_id in self.peer_ids:
                        self.next_index[peer_id]  = len(self.log) + 1
                        self.match_index[peer_id] = 0
                    return True
                else:
                    # Split vote or lost to a higher-term node
                    self.state = RaftState.FOLLOWER
        return False

    # ────────────────────────────────────────────────────────────
    # Log Replication (leader only)
    # ────────────────────────────────────────────────────────────

    def replicate_command(
        self, command: str, all_nodes: dict[str, "RaftNode"]
    ) -> bool:
        """
        Leader appends a new entry to its log and replicates to majority.
        Returns True if the entry was committed (majority acknowledged).

        Commit rule (Raft §5.3):
          An entry is committed once the leader has stored it on a majority.
          Only entries from the CURRENT term are committed this way.
          Entries from previous terms are committed indirectly (piggyback).
        """
        if self.state != RaftState.LEADER:
            print(f"  [{self.node_id}] Not leader — cannot accept writes")
            return False

        with self._lock:
            entry = LogEntry(
                term    = self.current_term,
                index   = len(self.log) + 1,
                command = command,
            )
            self.log.append(entry)
            term = self.current_term

        acks   = 1   # leader counts itself
        quorum = len(all_nodes) // 2 + 1

        for peer_id, peer_node in all_nodes.items():
            if peer_id == self.node_id:
                continue
            prev_idx  = len(self.log) - 1
            prev_term = self.log[-2].term if len(self.log) > 1 else 0
            _, success = peer_node.handle_append_entries(
                term           = term,
                leader_id      = self.node_id,
                prev_log_index = prev_idx,
                prev_log_term  = prev_term,
                entries        = [entry],
                leader_commit  = self.commit_index,
            )
            if success:
                acks += 1

        if acks >= quorum:
            with self._lock:
                self.commit_index = len(self.log)
            return True
        return False

    def status(self) -> dict:
        return {
            "node":         self.node_id,
            "state":        self.state.value,
            "term":         self.current_term,
            "log_length":   len(self.log),
            "commit_index": self.commit_index,
            "voted_for":    self.voted_for,
        }


# ── Raft Demo ─────────────────────────────────────────────────────

def raft_demo():
    node_ids = ["N1", "N2", "N3", "N4", "N5"]
    nodes = {
        nid: RaftNode(nid, [x for x in node_ids if x != nid])
        for nid in node_ids
    }

    print("\n=== Raft Demo ===")
    print("Initial state: all nodes are FOLLOWERS")
    for n in nodes.values():
        print(f"  {n.status()}")

    # N1 starts an election (simulating election timeout firing)
    print("\nN1 election timeout fires → starts election")
    won = nodes["N1"].start_election(nodes)
    print(f"N1 became leader: {won}")

    print("\nPost-election state:")
    for n in nodes.values():
        print(f"  {n.status()}")

    print("\nLeader replicates: 'SET x=42'")
    committed = nodes["N1"].replicate_command("SET x=42", nodes)
    print(f"Committed: {committed}")

    print("\nLog state after replication:")
    for n in nodes.values():
        log_summary = [(e.term, e.command) for e in n.log]
        print(f"  {n.node_id}: {log_summary}  commit_index={n.commit_index}")
```

---

## Code Implementation: CRDTs (Conflict-Free Replicated Data Types)

CRDTs are data structures that can be **merged deterministically** across replicas
without coordination. They are the mathematical foundation for eventual consistency.

### Why CRDTs work

```text
Traditional distributed counter (broken):
  Node A: counter = 5, increments to 6
  Node B: counter = 5, increments to 6
  Merge:  6? or 7? — conflict! Need coordination.

GCounter (CRDT approach):
  Node A: {A: 1, B: 0} → increments → {A: 2, B: 0}
  Node B: {A: 1, B: 0} → increments → {A: 1, B: 1}
  Merge:  take max per node → {A: 2, B: 1}  → value = 3 ✅
  Associative: merge(X, merge(Y, Z)) = merge(merge(X, Y), Z)
  Commutative: merge(X, Y) = merge(Y, X)
  Idempotent:  merge(X, X) = X

These three properties guarantee eventual consistency with zero coordination.
```

```python
"""
CRDT Implementations:
  GCounter   — grow-only counter (no coordination needed)
  PNCounter  — increment + decrement (two GCounters)
  LWWRegister — last-write-wins register (timestamp-based)
  ORSet       — observed-remove set (add/remove without conflicts)
"""

import time
import uuid
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Optional


# ────────────────────────────────────────────────────────────────
# GCounter: Grow-Only Counter
# ────────────────────────────────────────────────────────────────

class GCounter:
    """
    Each node tracks only its OWN increments.
    Total value = sum across all nodes.
    Merge = take max per node (idempotent, commutative, associative).

    Use case: page view counters, like counts, event totals.
    Advantage: any node can increment without contacting others.
               Merge is always safe — never loses an increment.

    Why max (not sum) for merge?
      If N1 sends {N1:3} and N2 already has {N1:3}, summing
      would give {N1:6} — double counting!
      max({N1:3}, {N1:3}) = {N1:3} — idempotent. ✅
    """

    def __init__(self, node_id: str):
        self.node_id = node_id
        self.counts: dict[str, int] = {}

    def increment(self, by: int = 1):
        """Increment this node's own counter. No coordination needed."""
        self.counts[self.node_id] = self.counts.get(self.node_id, 0) + by

    def value(self) -> int:
        """Total count across all nodes."""
        return sum(self.counts.values())

    def merge(self, other: "GCounter") -> "GCounter":
        """
        Merge two GCounters by taking element-wise max.
        Result is a new GCounter (immutable merge semantics).
        """
        merged = GCounter(self.node_id)
        all_nodes = set(self.counts) | set(other.counts)
        merged.counts = {
            node: max(self.counts.get(node, 0), other.counts.get(node, 0))
            for node in all_nodes
        }
        return merged

    def __repr__(self):
        return f"GCounter(counts={self.counts}, value={self.value()})"


# ────────────────────────────────────────────────────────────────
# PNCounter: Positive-Negative Counter (supports decrement)
# ────────────────────────────────────────────────────────────────

class PNCounter:
    """
    Supports both increment and decrement without coordination.
    Implemented as two GCounters: one for increments (P), one for decrements (N).
    Value = P.value() - N.value()

    Use case: inventory count, user balance (with care), upvote/downvote net.
    Caveat: value can go negative if decrements exceed increments —
            application must enforce non-negative constraint separately.
    """

    def __init__(self, node_id: str):
        self.node_id = node_id
        self.pos = GCounter(node_id)   # accumulates increments
        self.neg = GCounter(node_id)   # accumulates decrements

    def increment(self, by: int = 1):
        self.pos.increment(by)

    def decrement(self, by: int = 1):
        self.neg.increment(by)   # decrement = increment the negative counter

    def value(self) -> int:
        return self.pos.value() - self.neg.value()

    def merge(self, other: "PNCounter") -> "PNCounter":
        merged = PNCounter(self.node_id)
        merged.pos = self.pos.merge(other.pos)
        merged.neg = self.neg.merge(other.neg)
        return merged

    def __repr__(self):
        return (
            f"PNCounter(pos={self.pos.counts}, neg={self.neg.counts}, "
            f"value={self.value()})"
        )


# ────────────────────────────────────────────────────────────────
# LWWRegister: Last-Write-Wins Register
# ────────────────────────────────────────────────────────────────

@dataclass
class LWWRegister:
    """
    Stores a single value with a timestamp.
    Merge: keep the value with the higher timestamp.

    Use case: user profile field (last update wins), configuration value.
    Risk: two writes at the exact same millisecond → arbitrary winner.
          Production: use Hybrid Logical Clocks (HLC) which combine
          physical time with a logical counter, providing better resolution.

    Why this is a CRDT:
      merge(A, B) = merge(B, A)          [commutative]
      merge(A, merge(B, C)) = ...        [associative]
      merge(A, A) = A                    [idempotent]
      As long as timestamps are total-ordered, this holds.
    """
    node_id:   str
    value:     Any   = None
    timestamp: float = 0.0

    def write(self, value: Any):
        """Update the register value with current timestamp."""
        self.value     = value
        self.timestamp = time.time()

    def merge(self, other: "LWWRegister") -> "LWWRegister":
        """Higher timestamp wins. Tie-break by node_id (alphabetical)."""
        if other.timestamp > self.timestamp:
            return LWWRegister(other.node_id, other.value, other.timestamp)
        if other.timestamp == self.timestamp and other.node_id > self.node_id:
            return LWWRegister(other.node_id, other.value, other.timestamp)
        return LWWRegister(self.node_id, self.value, self.timestamp)

    def __repr__(self):
        return f"LWWRegister(node={self.node_id}, value={self.value!r}, ts={self.timestamp:.3f})"


# ────────────────────────────────────────────────────────────────
# ORSet: Observed-Remove Set
# ────────────────────────────────────────────────────────────────

class ORSet:
    """
    Add and remove elements without coordination — and correctly handles
    the concurrent add+remove problem.

    Problem with naive set merge:
      Node A: {apple}  → removes apple → {}
      Node B: {apple}  → (concurrently) adds apple → {apple}
      Merge naive: {} ∪ {apple} = {apple}?  or {}?  — ambiguous!

    ORSet solution:
      Each add creates a unique tag (UUID). The set tracks tags, not elements.
      Remove means: remove all OBSERVED tags for that element.
      After merge: element is present iff any tags remain.

      Node A: apple → tags {tag1}  → removes tag1 → apple tags = {}
      Node B: apple → tags {tag1}  → adds apple (new tag2) → {tag1, tag2}
      Merge:  apple tags = {} ∪ {tag1, tag2} = {tag1, tag2} → apple IS in set ✅
      (Node B's add happened after Node A saw tag1, so it wins)

    Use case: collaborative shopping cart, shared tag system, replicated config keys.
    """

    def __init__(self):
        # element → set of unique tags (one tag per add operation)
        self._elements: dict[Any, set[str]] = defaultdict(set)

    def add(self, element: Any) -> str:
        """Add element, returning the unique tag assigned to this add."""
        tag = str(uuid.uuid4())
        self._elements[element].add(tag)
        return tag

    def remove(self, element: Any):
        """
        Remove all observed tags for this element.
        If a concurrent add is in flight (not yet observed), its tag
        will survive the merge — add wins over concurrent remove.
        """
        self._elements.pop(element, None)

    def contains(self, element: Any) -> bool:
        return bool(self._elements.get(element))

    def members(self) -> set:
        return {elem for elem, tags in self._elements.items() if tags}

    def merge(self, other: "ORSet") -> "ORSet":
        """Union of tag sets. An element is present iff any tags remain."""
        merged = ORSet()
        all_elements = set(self._elements) | set(other._elements)
        for elem in all_elements:
            merged._elements[elem] = (
                self._elements.get(elem, set())
                | other._elements.get(elem, set())
            )
        return merged

    def __repr__(self):
        return f"ORSet(members={self.members()})"


# ── CRDT Demo ─────────────────────────────────────────────────────

def crdt_demo():
    print("\n=== CRDT Demo ===")

    # GCounter: two nodes increment independently, then merge
    c1 = GCounter("node1")
    c2 = GCounter("node2")
    c1.increment(5)
    c2.increment(3)
    c1.increment(2)   # c1 total local: 7
    merged = c1.merge(c2)
    print(f"GCounter merge: node1={c1.value()}, node2={c2.value()}, merged={merged.value()}")
    # Expected: 10 (7 + 3)

    # PNCounter: node1 increments, node2 decrements
    p1 = PNCounter("node1")
    p2 = PNCounter("node2")
    p1.increment(10)
    p2.decrement(3)
    merged_p = p1.merge(p2)
    print(f"PNCounter merge: value={merged_p.value()}")  # Expected: 7

    # LWWRegister: concurrent writes, higher timestamp wins
    r1 = LWWRegister("node1")
    r2 = LWWRegister("node2")
    r1.write("Alice")
    time.sleep(0.001)
    r2.write("Bob")    # later timestamp → wins
    merged_r = r1.merge(r2)
    print(f"LWWRegister merge: winner={merged_r.value!r}")  # Expected: "Bob"

    # ORSet: concurrent add+remove
    s1 = ORSet()
    s2 = ORSet()
    s1.add("apple")
    s2.add("apple")     # concurrent add on node2 (new tag)
    s1.remove("apple")  # node1 removes (its observed tags)
    merged_s = s1.merge(s2)
    print(f"ORSet after concurrent add+remove: members={merged_s.members()}")
    # Expected: {"apple"} — node2's add survives because it has a new tag
```

---

## Code Implementation: Distributed Lock with Fencing Token

Distributed locks are notoriously tricky. The classic failure mode:

```text
Worker A acquires lock, gets token=5, starts long operation.
Worker A pauses (GC pause, slow network, OS scheduler).
Lock TTL expires. Worker B acquires lock, gets token=6.
Worker A resumes, thinks it still holds the lock — writes stale data!

Without fencing: both A and B corrupt shared state.
With fencing:    resource rejects A's write (token=5 < current=6). ✅
```

```python
"""
Distributed Lock with Fencing Token.

Simulates Redis SET NX EX semantics. The fencing token is a monotonic
counter that increases on every successful acquire. Resources (databases,
file systems, APIs) must validate the token before accepting writes.
"""

import threading
import time
from typing import Optional


class DistributedLock:
    """
    Simulates a Redis-based distributed lock with fencing tokens.

    Redis equivalent:
      SET lock_name lock_holder NX EX {ttl}
      GET lock_name  (check holder)
      DEL lock_name  (release)

    The fencing token is a monotonically increasing counter stored
    in a separate atomic counter (e.g., Redis INCR fence_counter).
    Every new lock acquisition gets the next token value.

    Resources validate: if token < current_active_token → reject write.
    """

    # Class-level monotonic counter shared across all lock instances.
    # In production: stored in Redis (INCR fence_counter is atomic).
    _global_fence = 0
    _global_lock  = threading.Lock()

    def __init__(self, lock_name: str, ttl: float = 10.0):
        self.lock_name = lock_name
        self.ttl       = ttl
        self._holder:  Optional[str] = None
        self._token:   int           = 0
        self._expires: float         = 0.0
        self._mu       = threading.Lock()

    def acquire(self, holder_id: str) -> tuple[bool, int]:
        """
        Try to acquire the lock.
        Returns (acquired: bool, fencing_token: int).
        Token is 0 if not acquired.

        Atomicity: in Redis, SET NX EX is a single atomic command.
        Here we simulate with a Python lock around the check-and-set.
        """
        with self._mu:
            now = time.time()
            if self._holder is not None and now < self._expires:
                return False, 0   # lock currently held and not expired

            # Acquire: atomically set holder + expiry + mint new token
            with DistributedLock._global_lock:
                DistributedLock._global_fence += 1
                token = DistributedLock._global_fence

            self._holder  = holder_id
            self._token   = token
            self._expires = now + self.ttl
            return True, token

    def release(self, holder_id: str, token: int) -> bool:
        """
        Release the lock only if holder_id and token both match.
        This prevents a slow/crashed worker from releasing another
        worker's lock after TTL expiry.

        Redis equivalent (Lua script for atomicity):
          if redis.call("GET", key) == holder_id then
              redis.call("DEL", key)
              return 1
          else
              return 0
          end
        """
        with self._mu:
            if self._holder == holder_id and self._token == token:
                self._holder  = None
                self._token   = 0
                self._expires = 0.0
                return True
            return False   # wrong holder or stale token

    def is_token_valid(self, token: int) -> bool:
        """
        Resource calls this before accepting a write.
        Returns True only if:
          - token matches the currently active token, AND
          - lock has not expired.
        Any stale lock holder's token will be < current token → rejected.
        """
        with self._mu:
            return (
                token == self._token
                and self._holder is not None
                and time.time() < self._expires
            )

    def current_token(self) -> int:
        """Peek at the current fencing token (for logging/debugging)."""
        with self._mu:
            return self._token


class ProtectedResource:
    """
    Simulates a database / file / external API that validates fencing tokens.
    In production: the resource's write path does:
      if token < resource.last_seen_token: raise StaleWriteError
      resource.last_seen_token = token
      resource.do_write(data)
    """

    def __init__(self, name: str):
        self.name            = name
        self.last_seen_token = 0
        self.data:           list[str] = []

    def write(self, data: str, token: int, writer_id: str) -> bool:
        """
        Accept write only if fencing token is >= last seen.
        This prevents stale lock holders from corrupting state.
        """
        if token < self.last_seen_token:
            print(
                f"  [Resource:{self.name}] ❌ REJECTED write from {writer_id}: "
                f"token={token} < last_seen={self.last_seen_token} (STALE HOLDER)"
            )
            return False
        self.last_seen_token = token
        self.data.append(f"[token={token}|{writer_id}] {data}")
        print(
            f"  [Resource:{self.name}] ✅ ACCEPTED write from {writer_id}: "
            f"token={token}  data={data!r}"
        )
        return True


# ── Fencing Token Demo ─────────────────────────────────────────────

def fencing_demo():
    """
    Demonstrates how fencing prevents stale lock holder corruption.

    Scenario:
      1. Worker A acquires lock → gets token=1
      2. Worker A pauses (GC pause / network partition)
      3. Lock TTL expires automatically
      4. Worker B acquires lock → gets token=2
      5. Worker A resumes, thinks it still has the lock
      6. Worker A tries to write with token=1 → REJECTED ✅
      7. Worker B writes with token=2 → ACCEPTED ✅
    """
    print("\n=== Distributed Lock + Fencing Token Demo ===")

    lock     = DistributedLock("job_lease", ttl=5.0)
    resource = ProtectedResource("inventory_db")

    # Step 1: Worker A acquires lock
    acquired_a, token_a = lock.acquire("worker_A")
    print(f"\nWorker A acquires lock: {acquired_a}, token={token_a}")

    # Step 2: Simulate Worker A pausing (GC pause)
    print("Worker A: GC pause... (simulated by forcing lock expiry)")
    # Force expiry by setting internal expiry to past
    lock._expires = time.time() - 1   # lock appears expired

    # Step 3: Worker B acquires lock (TTL expired)
    acquired_b, token_b = lock.acquire("worker_B")
    print(f"Worker B acquires lock: {acquired_b}, token={token_b}")

    # Step 4: Worker B writes successfully
    print("\nWorker B writes with token=2:")
    resource.write("inventory_count=500", token=token_b, writer_id="worker_B")

    # Step 5: Worker A "wakes up", tries to write with stale token
    print("\nWorker A resumes (stale), tries to write with token=1:")
    resource.write("inventory_count=0", token=token_a, writer_id="worker_A")
    # → REJECTED: token_a (1) < last_seen (2)

    # Step 6: Worker B writes again safely
    print("\nWorker B writes again with current token:")
    resource.write("inventory_count=495", token=token_b, writer_id="worker_B")

    print(f"\nFinal resource state: {resource.data}")
    print(
        "\nKey insight: Without fencing tokens, Worker A's stale write would\n"
        "silently corrupt the database. Fencing makes the resource itself\n"
        "enforce the 'only one valid writer' invariant."
    )
```

---

## Code Implementation: Vector Clocks

Vector clocks capture **causal relationships** between events in a distributed system.
They are strictly more powerful than Lamport clocks.

### Lamport vs Vector Clocks

```text
Lamport Clock (simpler, less information):
  - Single integer per node.
  - If A → B (A happens-before B), then LC(A) < LC(B).
  - But: LC(A) < LC(B) does NOT imply A → B.
  - Cannot detect concurrent events — just total ordering.

Vector Clock (richer, more information):
  - One integer per node, per clock.
  - A → B  iff  VC(A) < VC(B)  (element-wise ≤, strict somewhere)
  - A ∥ B (concurrent) iff neither VC(A) < VC(B) nor VC(B) < VC(A)
  - Can DETECT concurrent edits — essential for conflict resolution.

Real-world use:
  - Amazon Dynamo uses vector clocks to detect concurrent writes.
  - Riak, Voldemort, CouchDB use similar mechanisms.
  - Git commits have an implicit DAG (same concept, different notation).
```

```python
"""
Vector Clock implementation with happens-before and concurrency detection.
"""

import time
from dataclasses import dataclass, field
from typing import Optional


class VectorClock:
    """
    A vector clock for a specific node in a distributed system.
    Each node maintains a vector of logical timestamps — one per known node.

    Rules (Lamport-style, generalized to vectors):
      On local event:   increment own entry.
      On message send:  increment own entry, attach clock to message.
      On message recv:  merge (element-wise max), then increment own entry.

    Happens-before (A → B):
      VC(A)[i] <= VC(B)[i]  for ALL i
      VC(A)[i] <  VC(B)[i]  for SOME i

    Concurrent (A ∥ B):
      NOT (A → B) AND NOT (B → A)
      i.e., VC(A)[j] > VC(B)[j] for some j,
            AND VC(A)[k] < VC(B)[k] for some k
    """

    def __init__(self, node_id: str, all_nodes: list[str]):
        self.node_id  = node_id
        self.clock: dict[str, int] = {n: 0 for n in all_nodes}

    def tick(self) -> "VectorClock":
        """
        Increment own entry. Call before a local event or before sending a message.
        Returns a new clock (immutable-style).
        """
        vc = self._copy()
        vc.clock[self.node_id] += 1
        return vc

    def receive(self, incoming: "VectorClock") -> "VectorClock":
        """
        On receiving a message: merge (take max per node), then tick own entry.
        This captures "I know everything the sender knew, plus my own events."
        """
        vc = self._copy()
        all_nodes = set(self.clock) | set(incoming.clock)
        for node in all_nodes:
            vc.clock[node] = max(
                self.clock.get(node, 0),
                incoming.clock.get(node, 0),
            )
        vc.clock[self.node_id] += 1   # increment after merge
        return vc

    def happens_before(self, other: "VectorClock") -> bool:
        """
        Returns True if self → other (self causally precedes other).
        Requires: self[i] <= other[i] for all i,
                  AND self[i] < other[i] for at least one i.
        """
        all_nodes = set(self.clock) | set(other.clock)
        strict_less = False
        for node in all_nodes:
            a = self.clock.get(node, 0)
            b = other.clock.get(node, 0)
            if a > b:
                return False       # self is NOT before other
            if a < b:
                strict_less = True
        return strict_less         # True only if strictly less somewhere

    def concurrent_with(self, other: "VectorClock") -> bool:
        """
        Returns True if self ∥ other (neither happened before the other).
        This means there was a concurrent write — needs conflict resolution.
        """
        return (
            not self.happens_before(other)
            and not other.happens_before(self)
            and self.clock != other.clock
        )

    def _copy(self) -> "VectorClock":
        vc = VectorClock(self.node_id, list(self.clock.keys()))
        vc.clock = dict(self.clock)
        return vc

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, VectorClock):
            return False
        return self.clock == other.clock

    def __repr__(self) -> str:
        entries = ", ".join(f"{k}:{v}" for k, v in sorted(self.clock.items()))
        return f"VC[{entries}]"


# ── Vector Clock Demo ──────────────────────────────────────────────

def vector_clock_demo():
    """
    Demonstrates vector clocks in a 3-node distributed KV store.

    Scenario:
      Node A and Node B concurrently update the same key.
      Vector clocks detect the conflict. System can then apply
      application-level resolution (LWW, merge, user prompt, etc.)
    """
    print("\n=== Vector Clock Demo ===")
    nodes = ["A", "B", "C"]

    # Each node starts with a zero vector clock
    vc_a = VectorClock("A", nodes)
    vc_b = VectorClock("B", nodes)
    vc_c = VectorClock("C", nodes)

    # Step 1: A writes key="name", value="Alice"
    vc_a = vc_a.tick()
    print(f"\n1. A writes 'name=Alice':   vc_a = {vc_a}")

    # Step 2: A sends to B (replication)
    vc_b = vc_b.receive(vc_a)
    print(f"2. B receives from A:         vc_b = {vc_b}")

    # Step 3: B writes key="name", value="Bob"  (concurrent with next A write)
    vc_b = vc_b.tick()
    print(f"3. B writes 'name=Bob':       vc_b = {vc_b}")

    # Step 4: A writes again (concurrent with B's write — A doesn't know about B's write yet)
    vc_a = vc_a.tick()
    print(f"4. A writes 'name=Alice2':    vc_a = {vc_a}")

    # Step 5: Check causal relationships
    print(f"\n--- Causal Analysis ---")
    print(f"vc_a = {vc_a}")
    print(f"vc_b = {vc_b}")
    print(f"A happened-before B:  {vc_a.happens_before(vc_b)}")
    print(f"B happened-before A:  {vc_b.happens_before(vc_a)}")
    print(f"A concurrent with B:  {vc_a.concurrent_with(vc_b)}")

    if vc_a.concurrent_with(vc_b):
        print(
            "\n⚠  CONFLICT DETECTED: Both A and B wrote 'name' concurrently.\n"
            "   Resolution options:\n"
            "   1. LWW: keep the write with higher wall-clock timestamp\n"
            "   2. Merge: show both values, let user pick\n"
            "   3. Application-defined: e.g., 'Bob' always wins over 'Alice'\n"
            "   4. CRDT: if value is a set, union the sets"
        )

    # Step 6: C receives from both A and B → merges
    vc_c = vc_c.receive(vc_a)
    vc_c = vc_c.receive(vc_b)
    print(f"\n5. C receives from both A and B: vc_c = {vc_c}")
    print(f"   A happened-before C:  {vc_a.happens_before(vc_c)}")
    print(f"   B happened-before C:  {vc_b.happens_before(vc_c)}")


# Run all demos
if __name__ == "__main__":
    raft_demo()
    crdt_demo()
    fencing_demo()
    vector_clock_demo()
```

---

## Multi-Region Failover: Expanded Trade-Off Matrix

### Active-Active vs Active-Passive

```text
┌──────────────────────┬────────────────────────────────┬──────────────────────────────────┐
│ Dimension            │ Active-Active                  │ Active-Passive                   │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Write availability   │ All regions accept writes      │ Only primary accepts writes      │
│                      │ (higher write availability)    │ (standby rejects writes)         │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Read latency         │ Local reads from any region    │ Local reads from any region      │
│                      │ (excellent)                    │ (excellent if replication fast)  │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Write conflicts      │ HIGH: concurrent writes to     │ NONE: single primary = no        │
│                      │ same data → need resolution    │ concurrent write conflicts       │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ RPO (data loss risk) │ Low-to-zero with sync repl.    │ Near-zero (sync) or seconds      │
│                      │ Seconds with async             │ (async) — determined by lag      │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ RTO (recovery time)  │ Near-zero: traffic rerouted    │ Minutes: promote standby,        │
│                      │ by DNS/load balancer           │ update DNS, validate data        │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Operational cost     │ High: conflict resolution      │ Lower: simpler write path,       │
│                      │ logic, testing, monitoring     │ no conflict handling needed      │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Complexity           │ Very high: need CRDT or        │ Moderate: need reliable failover │
│                      │ application merge logic        │ detection + promotion workflow   │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Best for             │ Low-contention data:           │ High-contention data:            │
│                      │ user sessions, counters,       │ financial transactions,          │
│                      │ shopping carts, feeds          │ inventory, order state           │
├──────────────────────┼────────────────────────────────┼──────────────────────────────────┤
│ Real-world examples  │ DynamoDB global tables,        │ PostgreSQL streaming replication, │
│                      │ Cassandra multi-DC,            │ MySQL replica, RDS Multi-AZ,     │
│                      │ CockroachDB, Google Spanner    │ MongoDB replica sets             │
└──────────────────────┴────────────────────────────────┴──────────────────────────────────┘
```

### RPO / RTO Comparison by Strategy

```text
┌──────────────────────────────┬────────────────────┬───────────────────┬─────────────────────┐
│ Strategy                     │ RPO                │ RTO               │ Cost                │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Single region, no HA         │ All data (∞)       │ Hours             │ Low                 │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Single region, Multi-AZ      │ ~0 (sync repl.)    │ 1-2 min (AZ fail) │ Medium              │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Active-Passive, async repl.  │ Seconds to minutes │ 5-15 min          │ Medium              │
│ (cross-region)               │ (replication lag)  │ (promote + DNS)   │                     │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Active-Passive, sync repl.   │ ~0                 │ 2-5 min           │ High                │
│ (cross-region)               │                    │ (promote + DNS)   │ (latency penalty)   │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Active-Active, eventual cons.│ ~0 (local writes)  │ <30 sec           │ Very High           │
│ (multi-region)               │                    │ (DNS reroute)     │ (conflict logic)    │
├──────────────────────────────┼────────────────────┼───────────────────┼─────────────────────┤
│ Active-Active, Spanner-style │ 0 (global tx)      │ <30 sec           │ Extremely High      │
│ (globally consistent)        │                    │                   │ (TrueTime, GPS)     │
└──────────────────────────────┴────────────────────┴───────────────────┴─────────────────────┘

RPO = Recovery Point Objective: max data loss window (how much history can we lose?)
RTO = Recovery Time Objective: max downtime window (how long until service resumes?)
```

### Write Conflict Scenarios and Resolution Strategies

```text
SCENARIO A: Two users update their own profiles (disjoint data)
  Region US: user_1 updates email
  Region EU: user_2 updates email
  Conflict: NONE — different rows, no conflict.
  Strategy: Last-write-wins (LWW) per row is safe and simple.

SCENARIO B: Two regions update the same counter (e.g., "stock count")
  Region US: stock = 10, sells 3 → stock = 7
  Region EU: stock = 10, sells 2 → stock = 8
  Merge naive: 7 or 8? Both wrong! Real answer is 5.
  Strategy: Use PNCounter CRDT.
    Each region tracks its OWN decrements in a GCounter.
    Merge = take max per region → total sold = 3+2=5 → stock=10-5=5. ✅

SCENARIO C: Two regions update the same user's shipping address
  Region US: address = "123 Main St"
  Region EU: address = "456 Oak Ave"   (concurrent edit)
  Conflict: Cannot merge addresses — semantics unclear.
  Strategy: LWWRegister (last timestamp wins) — acceptable for profile data.
            OR: Route all writes for a user to their "home region".
            OR: Use optimistic concurrency control (version vectors).

SCENARIO D: Shopping cart — user adds items from two devices offline
  Device 1: cart = [apple, banana]
  Device 2: cart = [apple, orange]   (concurrent)
  Merge naive: set union → {apple, banana, orange} — usually correct!
  Strategy: ORSet CRDT.
    Handles concurrent add+remove correctly (observed-remove semantics).
    Real example: Amazon Dynamo's shopping cart used vector clocks for this.

SCENARIO E: Financial transfer — debit/credit must be atomic
  Cannot use eventual consistency for transactions spanning accounts.
  Strategy:
    Option 1: Route all financial writes to single primary region.
              (Active-Passive for financial data, Active-Active for other data)
    Option 2: Two-phase commit across regions.
              (High latency: 100-300ms round trip, coordinator bottleneck)
    Option 3: Spanner-style globally consistent transactions.
              (Expensive: requires atomic clocks / GPS receivers + TrueTime)

GENERAL RESOLUTION HIERARCHY:
  1. Avoid conflict: route writes for the same entity to same region (sharding by user_id)
  2. Detect conflict: vector clocks or version numbers on every write
  3. Resolve conflict:
     a. LWW (last write wins)  — simple, loses data
     b. Multi-value (show both) — forces user to resolve
     c. Merge (CRDT)           — works for add-only or commutative ops
     d. Application logic      — domain-specific (e.g., "union of permissions")
```

### Failover Runbook (Active-Passive Cross-Region)

```text
Detection (automated, <30s):
  Health check: GET /health from Route 53 / Cloud DNS health checker
  Alert: if 3 consecutive failures → trigger failover

Promotion sequence:
  1. Confirm primary is down (avoid split-brain from flapping)
  2. Verify replication lag on standby (how much data at risk?)
     if lag > RPO threshold → pause and alert on-call
  3. Promote standby to primary:
     PostgreSQL: pg_promote() or "touch /tmp/promote"
     MySQL: STOP REPLICA; RESET REPLICA ALL;
  4. Update DNS: change A record to standby IP (TTL must be short: 60s)
  5. Verify: send synthetic test transactions, check application logs
  6. Communicate: status page + internal Slack

Failback (after primary recovers):
  1. Do NOT auto-failback — human review of data divergence first
  2. Rebuild old-primary as new-standby (re-sync from current primary)
  3. Optionally failback during low-traffic window with planned maintenance

Common pitfalls:
  - TTL too high: DNS change takes 10min+ to propagate → extended downtime
  - Auto-failback: primary hiccup → double-failover → split brain
  - Missing replication lag check → promote standby that's 60s behind → data loss
  - Fencing not implemented → old primary accepts writes after promotion → corruption
```

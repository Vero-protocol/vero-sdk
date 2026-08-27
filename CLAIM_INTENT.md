# Intent & Scaffolding: Stop submit() from re-signing with a new sequence on transport retry

Closes #86

## Problem Statement
In `src/contract/write.ts`, the retry loop currently reserves a new sequence on every attempt upon transport errors (`AllEndpointsFailed`, `RpcTimeout`). Because the transaction may have already landed on-chain, re-signing with a new sequence produces a distinct valid transaction, leading to potential duplicate executions of value-bearing calls (e.g. `vote`, `startRewardStream`, `emergencyRecover`).

## Implementation Architecture
1. **Single Sequence Reservation**:
   - Reserve sequence once prior to the retry loop.
   - Re-sign with the identical sequence on transport retry so transactions are byte-identical.
2. **Indeterminate State Handling**:
   - Poll for transaction status/hash on `AllEndpointsFailed` / `RpcTimeout` before attempting blind retry.
   - Add backoff/spacing between attempts instead of immediate tight loop.
3. **Preserve BadSequence Semantics**:
   - Keep the refresh-and-retry behavior for genuine `BadSequence` errors intact.
4. **Idempotency & Sequence Continuity**:
   - Prevent sequence cache gaps and eliminate duplicate transaction execution risk.

# Continue: milestone 6 part 2 (2026-11-19)

## State
- Branch `opus/saved-rooms-2`, HEAD `e29d53e` (pushed). Merged into `main` as `b2ac72f` (pushed, P10).
- All 12 lines of `GOAL_ACTIVE` are `[x]`. Results: `DECISIONS.md` P8 and P9. All results are 127.0.0.1.
- Stop points that wait for the operator (`GOAL_WAIT`):
  1. The merge of `opus/saved-rooms-2` into `main`, then the push of `main`.
  2. The push of the handoff branch `handoffs/saved-rooms-2-20261119`.

## After the operator replies
- Merge: `git merge --no-ff opus/saved-rooms-2` on `main` (`main` must still be `5982914`, else merge `main` into
  the branch first and run the fast check and one app start). Change "branch `opus/saved-rooms-2`" to "on main" in
  `CHANGELOG.md` and `README.md`. Push `main`.
- Handoff: skill `agent-kit:handoff`.

## Separate finding (not in this goal)
- Terminal demo with a typed address: mDNS finds the peer at the same time, and the explicit dial can fail with
  `ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS` (base 2 of 6 pass). `DECISIONS.md` P9, E3.

## Next goal
Milestone 6 part 3 (`docs/WORK_PLAN_1.0.md`, section 6): the replay seed (node option `seedHistory` exists), merged
endpoints, refreshed invites, frame bounds, and the encryption text.

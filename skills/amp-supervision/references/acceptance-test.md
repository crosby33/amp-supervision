# Safe acceptance — original-thread supervision

This is a procedure, **not a claim that it has passed** on a platform. It creates private
Amp threads and consumes inference. Obtain human approval for the test machine, scratch
directory and cost before starting. No production data, existing repositories or secrets.
Use reviewed code, the complete skill, a fresh supervisor conversation and the configured
runner. No Linear account or personal global instructions are needed.

## 1. Record the setup

Record the platform/build details from [platform setup](platform-setup.md), the selected
supervisor surface/model, Amp mode, repository revision, bridge/policy hashes and skill
archive hash. Verify the tool descriptions match the reviewed build. Choose a new absolute
scratch path beneath the configured runner workspace and verify it does not exist. Keep
private notes/exports outside Git. Share only deliberately sanitized excerpts.

## 2. Spawn once from the supervisor

Use `amp_spawn` with `executor: "runner"` and omit project. Insert the real scratch path
into this prompt before dispatch:

```text
Work only in a NEW scratch Git repository at <ABSOLUTE_SCRATCH_PATH>.
If it already exists, stop; do not overwrite it. Create README.md.
You are the implementation worker. Work in this original thread; no delegation.
If you load amp-supervision, obey its worker-role guard, not its supervisor workflow.
Do not push, open a PR, merge, deploy, archive, use a tracker or contact external services.
Stop before creating choice.txt. Ask for decision ID colour with options blue and green,
recommendation blue, using the injected blocked envelope.
After receiving a complete decision, record it in docs/decisions.md BEFORE creating
choice.txt. Write the chosen colour plus a newline. Preserve the decision record.
Read both files back and report exact contents and verification. Leave the thread unarchived.
```

Save the returned thread URL and dispatch IDs. Accepted is not completed. On an ambiguous
result, do not repeat the call: use the existing journal's `amp_list`/`amp_read` recovery.

## 3. Check blocked state and restart recovery

Read until `settled: true`, `waiting_on_decision: true`, the correct `colour` envelope and
no pending request. Cap at five minutes; a timeout means investigate, not respawn. Inspect
the actual scratch directory: README exists, `choice.txt` does not.

At this safe idle point, restart only the test MCP client/bridge, keeping the same journal.
Read again and verify the same blocked thread. Do not restart a shared production runner.
On an otherwise idle dedicated WSL test machine, an operator may additionally approve
shutdown/restart of the test distro; retain all state and recover the same runner/thread.
Record which recovery was actually exercised. Never manufacture a lost send by sending twice.

## 4. Choose the non-recommended option

Send exactly once, through `amp_send.message`, after a fresh read:

```json
{"decision":"colour: green","rationale":"Exercise the non-recommended choice","constraints":["Only the named scratch repository; no external writes"]}
```

Read until settled with no pending request. Verify actual files: `choice.txt` is `green`
plus a newline, and `docs/decisions.md` contains date, task/thread, colour=green, rationale
and constraints once. The worker must not have chosen blue or recorded a different rationale.

## 5. Inspect the original worker's full tool history

Export the **entire** original thread through Amp's export/UI and inspect tool calls in
order, including calls preceding the final response:

- The decision record was written before `choice.txt`; final file timestamps alone are
  insufficient to establish ordering.
- No implementation child via `create_thread`, `amp_spawn`, continue-other-thread,
  shell/CLI equivalents, scripts or another interface. Distinguish bounded tool assistance
  from an independently executing implementation thread. Inspect tool arguments/results,
  not only a search count or final claim.
- Blocking and completion came from the same original thread/executor.
- No sends were blindly retried and no journal was cleared.
- If tool history is unavailable/compacted, record this check as unverified, not passed.

For stronger contract acceptance, use a separately authorized fresh scratch run with two
decisions. Reply to only one; verify the worker blocks again without dependent writes, then
answer both and check one complete decision record before work. This is model behavior,
not something unit tests or the JSON schema can establish.

## 6. Verification and PR handoff

The harmless fixture forbids external writes. First have the supervisor report its local
evidence and limitations without inventing a PR. To test actual PR handoff, separately
authorize a disposable GitHub repository, branch and small change. Use the task template,
require tests, a PR URL/head revision, CI/reviewer evidence, and a human handoff. Verify
those against GitHub; neither agent merges. A simulated/local report is not proof of a
working external PR flow. Record any unperformed phase as pending.

Retain private evidence until reviewed. Remove only identified disposable scratch files
after inspection and human approval; never delete a shared journal or unrelated worktree.

## Optional CLI protocol probe (not Desktop/skill acceptance)

From the reviewed checkout, the human may explicitly run:

```sh
bun compat/supervision-acceptance.ts --run-live /absolute/new-private-evidence-directory runner
```

The configured runner ID/directory must be in this shell's environment. `orb` is an explicit
alternative and creates an isolated cloud scratch directory. This harness is the sole writer
to its thread and uses its own evidence-directory journal. Never point Desktop or another
supervisor at that thread with a different journal. This isolation is for NEW disposable
test threads only, never a way to bypass pending requests on existing threads.

The probe records mutation attempts before dispatch, chooses green, and verifies local
files for runner mode. `protocol_complete` is not the full-history audit or a PR/client
acceptance result. After a stop **before any send attempt**, an accepted recorded spawn may
be resumed with `--resume-before-decision /same/evidence-directory`; the harness refuses
after any send attempt, even if no response was received. Missing spawn URL, attempted send
or ambiguous state require read-only reconciliation with the original journal. Do not start
a new run merely to get past the old failure. Preserve the evidence directory.

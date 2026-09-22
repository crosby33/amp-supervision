# Protocol, authority and recovery

The bridge is an operator-launched Bun/TypeScript stdio MCP server. It has no HTTP
listener, scheduler, queue consumer or orchestration authority. It exposes the authenticated
Amp account to its trusted client: thread reads contain private data and dispatch can run
tools with the runner account's permissions. Neither the starting directory nor the worker
prompt is a filesystem sandbox. Do not expose it to untrusted clients or the network.

## Process and request model

- Runner spawn: `amp -x <marked-task> --executor runner:<configured-id> --visibility private`
  from the operator-configured directory. Start the runner in that same directory.
- Orb spawn: `amp -ox <marked-task> --visibility private`, with `--project` when specified.
  `no-project` omits that flag and runs outside the caller's checkout, from the OS temp directory.
- Optional `--mode` forwards low/medium/high/ultra. Returned `requested_mode` is not evidence
  of the observed model or mode. Continuations do not change mode or executor.
- Send: `amp threads continue <id> -ox <marked-message>` continues the original executor.
- Read/list: `amp threads export <id>` / `amp threads list --json` with pagination.

Arguments go directly to the executable, never a shell. Commands are bounded to 120 seconds
and 16 MiB per output stream. Raw CLI failure output is not returned to the client. The
bridge does not install or upgrade Amp. CLI/export changes can break compatibility; stop
on an unknown response rather than relaxing acknowledgment checks.

## What the response proves

`dispatch_status: accepted` means the CLI returned a thread URL, not that the worker
started, completed, obeyed instructions or produced correct code.

`settled` requires a final assistant `end_turn`, an idle state referencing that same message,
and (when journaled) the exact latest marked user request. Only a settled final response
whose entire text is a fenced JSON blocked envelope sets `waiting_on_decision: true`.
Running states, tool results, stale responses and malformed envelopes do not qualify.
False `waiting_on_decision` alone is never a success signal.

The blocked envelope has exactly `status: "blocked"`, `summary`, `decisions_needed`,
`changes`, `tests` and `next_action`. Decisions have unique `id`, `question`, at least two
`options`, `recommendation` and `impact`. Strings must be nonempty. Arrays `changes` and
`tests` may be empty. A decision reply has exactly `decision`, `rationale`, `constraints`.

The worker contract requires resolving every decision and recording it before work. These
are model instructions, not enforced filesystem ordering. A substring match on a decision
ID would not prove it was answered. Use the acceptance history audit, not a claimed guarantee.

## One journal and one writer

Default journal: `~/.local/state/amp-supervision/requests.sqlite` (0700 new directory,
0600 database, restrictive umask). `AMP_SUPERVISION_STATE_DIR` overrides it. All clients
controlling the same threads must use the same journal and Linux/macOS user. It stores
correlation IDs, prompt SHA-256 digests, pending state and provenance—not prompts or tokens.
Local notes and acceptance exports can contain private data; keep those out of Git too.

Sends reserve transactionally before dispatch; competing bridge clients cannot send past
an outstanding request. A read clears it only after the exact request's final response.
This is **not a remote lock**: another web/CLI sender can enqueue work that an export does
not yet show. Use one supervisor writer per thread. Never mix the harness and Desktop
as writers to the same test thread. Never reset/copy the journal to bypass a pending request.

## Recovery table

| Condition | Safe action |
| --- | --- |
| Lost spawn URL / CLI timeout / connection lost during dispatch | Do not retry. Use `amp_list` with the same journal to locate the candidate, then `amp_read`; exact prompt digest can bind the orphan. If uncertain, stop for human investigation. |
| Lost send response / old final message | Keep journal, use `amp_read`, wait for exact acknowledgment; never resend because a timeout expired. |
| Offline runner / sleep / WSL shutdown | Restore the same environment and runner ID/directory; reconnect bridge to the same journal. Read before deciding anything. No cloud fallback. |
| Archived thread | Bridge returns a refusal and suggested unarchive command. Human decides; bridge never unarchives. |
| Missing/non-executable Amp (`ENOENT`/`EACCES`) | No process started; reservation is released/restored. Fix executable setup, then make a new authorized attempt. Other errors remain ambiguous. |
| CLI/export schema drift or compacted-away request | Keep state and stop. Failure to prove delivery is not proof of non-delivery. |
| Bridge source changed while process ran | Mutation refused; read/list still reconcile. Restart from reviewed code, keeping journal. |

## Installation identity and approved cutover

Run `bun -e 'import {captureBuild} from "./src/supervision-mcp.ts"; const b=captureBuild(); console.log(JSON.stringify({build_id:b.build_id,worker_policy_id:b.worker_policy_id}))'`
from the reviewed checkout and save those IDs privately. Compare with the `amp_spawn`
tool description and returned dispatch IDs. The source hash covers this one source file,
not dependencies or other scripts. Moving an unchanged file alone does not change its hash.

Before an upgrade, stop new dispatch and account for every outstanding request. With human
approval, point the client launcher at the reviewed checkout, rebuild/reinstall the skill,
fully quit/reopen clients and start a fresh supervisor conversation. Preserve the journal
and runner identity. Verify both IDs from every client before dispatch. Existing workers
keep their original prompt; sends apply no new worker policy (`applied_worker_policy_id`
is null). Do not resend or migrate them to make their policy match.

The public repository is the maintained source. Any prior private installation remains
unchanged until this cutover is explicitly approved and re-accepted. Retire its maintenance
copy at that point; archiving a repository is a separate human-authorized action.

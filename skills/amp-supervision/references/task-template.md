# Task brief template

Fill placeholders before dispatch. Omit a tracker when none is used. The human must
authorize the actual scope and actions; this template itself grants no permissions.

```text
Task: <short name and desired outcome>
Repository: <absolute path on the configured runner, or repository in the Orb project>
Executor: <runner ID/directory, or Orb project>
Context: <requirements and relevant documents, supplied here or accessible to the worker>
Acceptance: <observable outputs, rejection cases and tests>
Allowed: <e.g. local edits and tests on a task branch>
External actions: <none, or exact authorized GitHub destination and PR scope>
Human-only approvals: merge, deployment, destructive actions, credentials, spending,
access changes and private disclosure; also <task-specific restrictions>.

You are the implementation worker. Implement in this original thread and executor.
Do not dispatch an implementation child unless the human explicitly requests it for this task.
Follow repository guidance. Surface conflicts or unavailable environments here.
Stop before a blocking decision and return the injected blocked JSON envelope.
Do not answer your own decision. Record the external response in docs/decisions.md
before dependent work; ask again if any choice is unanswered or ambiguous.
When finished, report changes, verification commands/results and limitations here.
If a PR is authorized, also report its URL, head revision, CI and reviewer dispositions.
Do not merge. Leave the thread available for inspection.
```

The bridge injects the worker contract; installing this skill into the worker is not
required. If the worker does load it, its role guard applies before all supervisor steps.

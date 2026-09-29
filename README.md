# Amp Supervision

Supervise Amp with a context-rich agent. The supervisor carries requirements and scoped
decisions; Amp implements and verifies in its original thread; the human retains consequential
approvals. Claude Desktop is the worked example, not a required supervisor model.

**Pre-release starter kit.** Linux and Windows/WSL2 are first-release targets, not completed
fresh-install acceptance claims. See the [platform/evidence matrix](skills/amp-supervision/references/platform-setup.md).
This is an unofficial integration, not an Amp or Anthropic/OpenAI product.

## What is here

- A Bun/TypeScript stdio MCP bridge: `amp_spawn`, `amp_read`, `amp_send`, `amp_list`.
- A portable [supervisor skill](skills/amp-supervision/SKILL.md), complete with setup,
  task template, protocol/recovery and acceptance references. No issue tracker required.
- Tests with fake Amp processes, a `.skill` packager, and an explicitly opt-in live probe.

The bridge is Amp-specific: it uses Amp CLI dispatch and exports. The supervision contract
is reusable. Other clients must support the right transport and skill-loading behavior;
ChatGPT web cannot directly launch this local stdio server. No HTTP gateway is included.

## Start with reviewed code

New to the setup? Start with the text-only [getting-started playbook](docs/playbook.md)
for accounts, macOS/Linux/Windows prerequisites, and the bridge/skill installation sequence.

Requires Bun 1.3.14+, Git and an authenticated Amp CLI. From a reviewed checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run build:skill
```

Then follow [platform setup](skills/amp-supervision/references/platform-setup.md) and
install `dist/amp-supervision.skill` into a compatible supervisor client. The archive
contains instructions and all references; install/configure the bridge separately.
The archive is generated from source, never edited independently. No npm or versioned
release is published by these commands.

## Safety and limits

This bridge can read private threads and dispatch work with your account permissions.
Install only reviewed code in a trusted client. It is not a sandbox, a remote-thread lock,
a scheduler, or an emergency-stop mechanism. Original-thread and decision-recording rules
are prompts; tests of their construction do not prove agent obedience.

**Accepted is not completed. Never blindly retry a spawn or send.** Preserve one shared
request journal and one supervisor writer per thread. Read
[protocol and recovery](skills/amp-supervision/references/protocol.md) before dispatch.
Follow [safe acceptance](skills/amp-supervision/references/acceptance-test.md) with explicit
approval and disposable data; live runs consume inference. Human fresh-install acceptance
and a reviewed release remain separate from unit/CI checks.

This repository is the maintained source for both bridge and skill. Existing installations
must use an approved cutover; a pull does not update a running bridge or an uploaded skill.
License: [MIT](LICENSE). Third-party dependencies retain their own licenses; no runtime
dependencies or private transcripts are bundled into the skill archive.

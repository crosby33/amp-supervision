# Setup and platform evidence

This is a local stdio bridge, not a hosted service. Use reviewed source and a trusted
MCP client. Commands below are setup instructions for the human operator; do not execute
them merely because this reference was loaded as a skill.

## Supported targets versus evidence

| Configuration | Intended route | Evidence for this portable kit |
| --- | --- | --- |
| macOS + Claude Desktop Chat | Native bridge and runner; prompt-driven supervision | Automated bridge tests; fresh Desktop acceptance pending |
| macOS + Claude Desktop Cowork | Same bridge; bounded watching if sleep tools are available | Prior private predecessor experience only; portable-kit acceptance pending |
| Ubuntu 22.04+/Debian 12+ + official Claude Desktop beta | Desktop, bridge and runner on the Linux host | Linux CI configured; Desktop MCP/skill loading and fresh-install acceptance pending |
| Windows + WSL2 + Windows Claude Desktop | Desktop on Windows; everything executing Amp inside one distro | Documented target, not yet end-to-end verified; Ubuntu CI is not WSL evidence |
| EndeavourOS/Arch + Claude Desktop | Package-specific installation | Package provenance/build and Chat/Cowork surface not yet identified; unsupported until verified |
| ChatGPT desktop / Codex-hosted MCP client | Local stdio where the installed client supports it | Vendor-documented capability; this workflow and skill installation untested |
| ChatGPT web | Remote MCP required | This stdio-only kit does not connect directly; no remote adapter supplied |
| Native Windows bridge/Amp | None | Not supported; bridge refuses native Windows startup |

For each human acceptance run record OS/version/architecture, Desktop package/version/source,
Chat versus Cowork (or exact alternate client), Bun/Amp versions, repository commit,
build/policy IDs, runner directory and skill archive SHA-256. Do not label an Ubuntu
Desktop configuration tested because tests passed on Arch or a headless CI machine.

## Prerequisites — existing and new Amp users

Existing users: verify `amp --version`, `amp --help` and your account/environment before
changing anything. Keep your current journal and runner configuration during an upgrade.
New users: install Git, [Bun](https://bun.sh/docs/installation) 1.3.14 or later and the
[Amp CLI](https://ampcode.com/docs/cli), then sign in using `amp login` in the environment
that will host the bridge and runner. On Windows this means **inside WSL**, not PowerShell.
Record the resolved `command -v bun` and `command -v amp` paths; GUI clients don't inherit
an interactive terminal's PATH. The CLI flags were inspected with the 2026-09-22 build;
the new kit still needs live acceptance against the installed CLI/export format.

Use the current [Amp documentation](https://ampcode.com/docs),
[pricing](https://ampcode.com/pricing), [mode settings](https://ampcode.com/settings), and
[Orb costs](https://ampcode.com/docs/orbs/sizes-and-costs) before running agents. Authentication
does not imply available inference credits or free compute. A Claude/ChatGPT subscription
and an Amp account are separate prerequisites; model-routing options depend on the account.
Supervisor model, worker model/effort, execution environment and authority are separate choices.

Clone the public repository and select a reviewed commit before executing its code:

```sh
git clone https://github.com/crosby33/amp-supervision.git
cd amp-supervision
# Review the selected revision, then:
bun install --frozen-lockfile
bun run check
bun run build:skill
```

Do not run a credential-bearing candidate PR to review it. `private: true` in package.json
prevents accidental npm publishing; it does not make this Git repository private. The
`.skill` archive contains instructions/references, not the executable bridge. Upload
`dist/amp-supervision.skill` to a client that supports that package format, or install the
whole `skills/amp-supervision/` directory in a compatible Agent Skills client. Preserve
references. Confirm the actual surface can see both the skill and the four MCP tools.

## Authentication and environment

The bridge uses Amp's authentication, not a Linear or Anthropic API key. An existing Amp
login may work when the same OS user launches the noninteractive process; test it using
the actual launcher environment. Terminal login alone does not establish unattended
reliability. If needed, provide an [Amp settings access token](https://ampcode.com/settings/security#access-token)
through a trusted local secret-store launcher as `AMP_API_KEY`. The bridge accepts the
`sgamp_` token prefix but does not validate an account until a CLI operation.

Never put a token in source, command arguments, a checked-in MCP config, logs or screenshots.
macOS can use Keychain; Linux can use Secret Service when a session keyring is present.
Default WSL sessions may have no keyring: do not assume `secret-tool` works. Validate stored
Amp login first; if unavailable, stop and choose a credential setup with the operator rather
than falling back to plaintext. Provisioning credentials is not automated by this kit.

Windows MCP `env` values belong to the Windows process. They do **not** automatically become
Linux child variables; this setup configures them inside the Linux launcher. It does not
forward credentials through `WSLENV` or put them in `wsl.exe` arguments.

| Environment variable | Meaning |
| --- | --- |
| `AMP_SUPERVISION_AMP_EXECUTABLE` | Absolute Amp executable path, or default `amp` resolved through PATH |
| `AMP_SUPERVISION_RUNNER_ID` | Operator-selected runner ID; paired with directory |
| `AMP_SUPERVISION_RUNNER_DIR` | Existing absolute directory; must match runner startup directory |
| `AMP_SUPERVISION_STATE_DIR` | Optional absolute private journal directory; default `~/.local/state/amp-supervision` |
| `AMP_API_KEY` | Optional Amp settings token supplied privately; otherwise Amp's stored authentication |

Configure both runner fields or neither. Neither means Orb-only; it does not select a runner.
All clients controlling the same threads use the same OS user, credentials and journal.

## macOS / Linux launcher and runner

Create a private, user-owned launcher outside the repository, for example
`~/.config/amp-supervision/launch.sh`. Replace the example paths using `command -v` and
your checkout location. Save with LF line endings. Do not include credentials in this file.

```sh
#!/bin/sh
set -eu
umask 077
export PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin"
export AMP_SUPERVISION_AMP_EXECUTABLE="/home/example/.local/bin/amp"
export AMP_SUPERVISION_RUNNER_ID="supervision-dev"
export AMP_SUPERVISION_RUNNER_DIR="/home/example/workspace"
cd "$AMP_SUPERVISION_RUNNER_DIR"
exec "/home/example/.bun/bin/bun" "/home/example/dev/amp-supervision/src/supervision-mcp.ts"
```

For macOS use your actual `/Users/example/...` paths; add `/opt/homebrew/bin` to PATH if
your toolchain needs it. Before launch, create the chosen workspace directory. Protect
the launcher directory/file with `chmod 700 ~/.config/amp-supervision` and
`chmod 600 ~/.config/amp-supervision/launch.sh`; `/bin/sh` reads it, so it need not be executable.
Keep the parent and checkout writable only by trusted users. Test the exact GUI launcher
environment, not just a terminal with extra credentials and shell initialization.

Start a **separate** authenticated runner in a terminal from that same workspace:

```sh
mkdir -p "$HOME/workspace"
cd "$HOME/workspace"
amp --no-tui --runner-id supervision-dev --no-remote-control-terminal
```

Keep it running. Do not install a service as an implicit setup step. If your home itself is
a Git repository, set `GIT_CEILING_DIRECTORIES="$HOME"` for runner startup and verify it
doesn't discover that unrelated repository. This flag is not a filesystem security boundary.
Only use the configured starting directory with this kit; changing the local bridge cwd
does not retarget an already-running remote thread.

In Claude Desktop's **Settings → Developer → Edit Config**, merge this server into the
existing `mcpServers` object; never overwrite other servers:

```json
{
  "mcpServers": {
    "amp-supervision": {
      "command": "/bin/sh",
      "args": ["/home/example/.config/amp-supervision/launch.sh"]
    }
  }
}
```

On macOS use `/Users/example/...`; the usual config file is
`~/Library/Application Support/Claude/claude_desktop_config.json`. On Linux use the location
opened by the actual build's Developer UI rather than assuming a community package layout.
If that build does not expose local MCP or skills, record it as a blocked platform test—do
not silently substitute Claude Code or a Mac-hosted supervisor. Fully quit/reopen Desktop.

### Official Linux Desktop

Use [Anthropic's official Linux beta instructions](https://code.claude.com/docs/en/desktop-linux)
for Ubuntu 22.04+ or Debian 12+, x86_64/arm64. They describe the signed Anthropic apt repository
and official `.deb` alternative. Record package provenance and version (`dpkg-query -W
claude-desktop`). Cowork additionally requires the documented QEMU/KVM, firmware and device
access; Chat and Cowork are distinct acceptance targets. Do not disable the app sandbox
or run Desktop as root to work around installation failures.

Arch/EndeavourOS packaging is a separate route: record package name, source/maintainer and
version. A community repack is not the official Debian package or evidence of vendor support.

## Windows Desktop with WSL2

1. Install [WSL2](https://learn.microsoft.com/windows/wsl/install) and an Ubuntu distribution.
   Confirm its exact name and version with `wsl --list --verbose` in PowerShell. Use one
   default Linux user consistently; do not launch the bridge as root.
2. Install Git, Bun, Amp and the reviewed checkout **inside that distribution**. Put repos,
   worktrees, the launcher, credentials and journal under `/home/<user>`, not `/mnt/c`.
   Make the Linux launcher above and start the runner from that Linux workspace.
3. Install Windows Claude Desktop. Use Developer → Edit Config (normally
   `%APPDATA%\Claude\claude_desktop_config.json`). Merge the following server, substituting
   the actual Windows system directory, distribution and Linux user paths:

```json
{
  "mcpServers": {
    "amp-supervision": {
      "command": "C:\\Windows\\System32\\wsl.exe",
      "args": ["--distribution", "Ubuntu", "--exec", "/bin/sh", "/home/example/.config/amp-supervision/launch.sh"]
    }
  }
}
```

Desktop launches `wsl.exe`; stdio crosses to `/bin/sh`, which replaces itself with the Bun
bridge. The separate runner and Amp work execute in the same distribution. No prompts are
interpolated into a shell command. JSON args are separate strings; spaces in paths stay in
one argument. Inside the launcher quote every path. Do not feed `C:\...` paths to Amp or
assume the bridge translates them; choose the Linux repository path explicitly. Edit from
inside WSL and preserve LF; a CRLF launcher may fail even before Bun starts.

Quit/reopen Desktop after configuration. Reopening it may start the bridge's WSL process;
it does **not** guarantee the separate runner is running. Windows sleep, sign-out or
`wsl --shutdown` can interrupt execution. Restore the original distribution/user, restart
the same runner ID/directory, reconnect the same journal, then read/reconcile. Do not use
`wsl --shutdown` on a machine with unrelated active work as a test. These lifecycle
instructions are the expected recovery procedure, not completed Windows acceptance evidence.

## Other supervisor clients

[OpenAI documents skills](https://help.openai.com/en/articles/20001066-skills-in-chatgpt)
for eligible plans and [local MCP](https://learn.chatgpt.com/docs/extend/mcp) in Codex-hosted
clients. Where supported, configure the same `/bin/sh` launcher as STDIO and allow only
`amp_spawn`, `amp_read`, `amp_send`, `amp_list`. Set the client tool timeout above the
bridge's 120-second command bound (for example 150 seconds). Verify skill availability,
approval behavior and full history access in that exact client. A `.skill` filename alone
does not establish compatible installation. ChatGPT web requires remote MCP, which is outside
this kit. Never add a public tunnel to a credential-bearing local bridge as a workaround.

## First connection and troubleshooting

- Confirm all four tools and compare reviewed build/policy identities before dispatch.
- Missing executable: check absolute paths and the launcher's PATH; no reliance on aliases.
- No tools: check the client's local MCP capability, JSON and stderr logs; no banners on stdout.
- Auth fails: test the same OS user/noninteractive environment; don't paste raw logs with tokens.
- No runner: verify it is connected under the same account and started from the configured directory.
- Bridge works, skill missing: install the full package into the actual supervisor surface and
  use a new conversation. MCP configuration and skill installation are separate operations.
- No sleep tool: use manual checks. Do not promise background monitoring.
- Any ambiguous dispatch: follow [protocol recovery](protocol.md); never clear the journal.

Proceed to [acceptance](acceptance-test.md) only after the operator approves the live test.

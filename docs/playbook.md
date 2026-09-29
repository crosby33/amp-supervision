# Amp Supervision: getting started

> First text-only draft, checked against the starter kit and vendor documentation on
> 23 September 2026. This is a setup guide, not a completed fresh-install test report.
> Windows/WSL2 and Desktop acceptance remain pending. Editorial polish, real worked-example
> evidence and visuals will follow those runs.

## 1. What you are setting up

Use a context-rich assistant to supervise Amp while Amp implements and tests in its own
thread. This guide uses Claude Desktop as the supervisor. The supervisor skill is reusable;
the bridge is Amp-specific because it calls the Amp CLI.

There are three separate pieces to install:

- **Amp CLI and runner:** execute work on your machine. A runner is an Amp process that
  stays open in a terminal and accepts work for its configured directory.
- **MCP bridge:** gives the supervisor four tools: `amp_spawn`, `amp_read`, `amp_send` and
  `amp_list`. MCP is the protocol the desktop app uses to call those tools.
- **Supervisor skill:** instructions and references that teach the supervisor how to brief
  Amp, handle decisions, inspect progress and report back. Uploading a skill does not
  install the bridge or start a runner.

| Role | Context and execution | Authority |
| --- | --- | --- |
| Human | Chooses the task, machine, account and budget | Retains merge, deployment, destructive-action, access, spending and private-disclosure approvals |
| Supervisor, e.g. Claude | Holds the brief; calls the bridge from a compatible client | Resolves scoped, reversible decisions within the human-approved task |
| Amp worker | Receives the brief and works in its original thread on the configured runner | Implements and verifies; stops for decisions; does not create an implementation child without explicit human authorization |

The runner has your operating-system account's permissions. Its starting directory and
the worker's instructions are **not a sandbox**. Start with disposable files, not a
production repository. A supervisor without repository access cannot certify implementation
from Amp's final message alone. Using different model providers is not independent review.

Claude.ai is useful for preparing the brief or editing this guide, but the browser alone
does not launch this local stdio MCP bridge. ChatGPT web has the same transport limitation.
Other supervisor clients need their own compatible local MCP connection, skill installation
and acceptance test; they are not verified by this Claude Desktop example.

## 2. Accounts and prerequisites

You need:

- An **Amp account**, signed in on the machine/environment running the bridge and runner.
  Check [current Amp pricing](https://ampcode.com/pricing) and available usage before dispatch.
- A **Claude account** for the worked example, and Claude Desktop with access to local MCP
  servers and custom skills. Organization policy can restrict these features. This setup
  does not require an Anthropic API key or a Linear account.
- **Git**, **Bun 1.3.14 or later**, an internet connection and a text editor that can save
  plain text. Bun runs the bridge and builds the skill archive.
- On Windows, **WSL2 with Ubuntu** and Windows Claude Desktop. Installing WSL may need
  administrator access, virtualization enabled and a reboot.
- Permission to install software and run a local agent. A Claude subscription does not
  automatically provide Amp credits. Cloud Orbs are optional and have separate compute costs;
  this walkthrough uses a local runner.

Existing Amp users can keep their working installation. Verify its version and sign-in;
do not replace credentials, clear a request journal or repoint a working bridge merely to
follow this guide. Existing bridge users should follow the
[approved upgrade procedure](../skills/amp-supervision/references/protocol.md#installation-identity-and-approved-cutover).

## 3. Prepare your platform

| Platform | Desktop app | Where Git, Bun, Amp, bridge, runner and repositories live |
| --- | --- | --- |
| macOS | Native Claude Desktop | On the Mac, under the same user account |
| Linux | Official Claude Desktop Linux beta on Ubuntu/Debian | On the Linux host, under the same user account |
| Windows | Native Windows Claude Desktop | Inside one WSL2 Ubuntu distribution, under its normal Linux user |

### macOS

1. Install [Claude Desktop](https://claude.ai/download) and sign in.
2. Open Terminal. Run `git --version`. If Git is missing, run `xcode-select --install`,
   complete Apple's Command Line Tools installation, then check Git again.
3. Continue with the shared Bun/Amp installation below in Terminal.

### Linux

Ubuntu 22.04+ or Debian 12+, x86_64/arm64, is the reference route. Install Claude Desktop
using [Anthropic's official Linux beta instructions](https://code.claude.com/docs/en/desktop-linux),
including its signing-key verification. Sign in and confirm the installed build actually
offers local MCP configuration and skills before continuing. Cowork has additional
QEMU/KVM requirements; Chat and Cowork are separate acceptance targets.

For the command-line prerequisites on Ubuntu/Debian:

```sh
sudo apt update
sudo apt install git curl unzip
```

Then use the shared installation below. EndeavourOS/Arch users need their distribution's
equivalent packages and must record the Desktop package's source and version. A community
Desktop package is not the official Debian route. Working on Arch does not prove Ubuntu
works, or vice versa. Do not disable the Desktop sandbox to make an unsupported build run.

### Windows: create the WSL2 environment first

Install [Windows Claude Desktop](https://claude.ai/download) on Windows. Follow
[Microsoft's WSL installation guide](https://learn.microsoft.com/windows/wsl/install).
For a new installation, the usual starting point in **PowerShell as Administrator** is:

```powershell
wsl --install -d Ubuntu
```

Reboot if prompted, open Ubuntu and finish creating your Linux username/password. In
PowerShell, check the installed distribution and that its version is **2**:

```powershell
wsl --list --verbose
```

If WSL already exists, inspect it first; do not reinstall or unregister a distribution.
Use Microsoft's instructions if an existing installation needs conversion to WSL2.

From here, run the Ubuntu prerequisite commands above and all subsequent `sh` blocks
**inside the Ubuntu terminal**, not PowerShell. Install Linux Bun and Linux Amp there.
Keep the checkout, workspace, credentials and journal under `/home/<your-linux-user>`,
not `/mnt/c`. The desktop app stays on Windows; it will launch the bridge through
`wsl.exe`. You do not need a second Claude Desktop installation inside WSL.

## 4. Install Bun and Amp, then sign in

These are the vendor installer commands for macOS, Linux and WSL. They download and run
installation scripts; use only the official sources and review them if required by your
organization. Do not run the installers with `sudo`.

```sh
curl -fsSL https://bun.com/install | bash
curl -fsSL https://ampcode.com/install.sh | bash
```

Sources: [Bun installation](https://bun.sh/docs/installation) and
[Amp CLI installation](https://ampcode.com/docs/cli). Use the Amp install page's
workspace-specific instructions instead if your organization supplies them.

Open a new terminal so installer PATH changes take effect, then run:

```sh
git --version
bun --version
amp --version
amp login
command -v bun
command -v amp
```

Follow Amp's login instructions. On Windows, this login must happen inside the same WSL
distribution and Linux user you will use for the runner. Existing authenticated users do
not need to sign in again unnecessarily.

Save the two absolute executable paths printed by `command -v`; the desktop app may not
inherit your terminal's PATH. If a command is missing, fix its PATH using the vendor
instructions before configuring the bridge. Do not substitute a shell alias for an executable.

Amp uses its own authentication. Try the stored Amp login first. If it fails from the
desktop launcher, use the canonical
[authentication guidance](../skills/amp-supervision/references/platform-setup.md#authentication-and-environment).
Do not paste API keys into this document, chat, launcher scripts or MCP JSON. WSL may not
have a session keyring; do not assume a Linux secret-store command works there.

## 5. Clone the companion repository and build the skill

Choose a stable installation location: Desktop will refer to this checkout by absolute
path. The following layout works on macOS, Linux and inside WSL:

```sh
mkdir -p "$HOME/dev"
cd "$HOME/dev"
git clone https://github.com/crosby33/amp-supervision.git
cd amp-supervision
git rev-parse HEAD
```

If that directory already exists, inspect it instead of overwriting it. Review the selected
revision before running its code; a public repository or successful clone is not a trust
guarantee. Do not connect a credential-bearing desktop client to an unreviewed PR checkout.
After reviewing the checkout:

```sh
bun install --frozen-lockfile
bun run check
bun run build:skill
```

Stop if any step fails. The checks use fake Amp processes; they do not launch live agents.
The last command creates `dist/amp-supervision.skill`, a ZIP-format archive containing the
skill, its references and license. The bridge remains in `src/supervision-mcp.ts`; it is
not bundled into the archive. Nothing has been activated in Desktop yet.

## 6. Configure the bridge and start the runner

The [platform setup reference](../skills/amp-supervision/references/platform-setup.md) owns
the executable launcher and MCP JSON examples. Use those examples directly rather than
maintaining a second, diverging copy in this playbook.

1. Choose a workspace separate from the bridge checkout, for example `~/workspace`.
   Create it if needed. This is the runner's starting directory, not a security boundary.
2. Create `~/.config/amp-supervision/` if it does not exist. Create `launch.sh` inside it
   using the [macOS/Linux launcher example](../skills/amp-supervision/references/platform-setup.md#macos--linux-launcher-and-runner).
   On Windows, create this file **inside WSL**. Use LF line endings.
3. Replace every example path with a real absolute path: Amp and Bun from `command -v`,
   the workspace directory, and this checkout's `src/supervision-mcp.ts`. On macOS use
   `/Users/example/...`; on Linux/WSL use `/home/example/...`, replacing `example` with
   your own username. Keep paths quoted.
4. Keep the runner ID `supervision-dev`, or select another ID consistently. Both runner
   ID and directory must be configured. Protect the launcher directory/file with the
   permissions in the reference. Do not add credentials or logging to stdout.
5. In a **separate terminal**, run the reference's runner-start commands from the same
   workspace. Keep this terminal running. On Windows it must be a WSL terminal in the
   same distribution and user. The runner is separate from the bridge; opening Desktop
   does not start it for you.
6. Open the desktop application's **Settings → Developer → Edit Config**. These are
   Desktop's developer settings, not the web account's connector settings. Back up an
   existing config before editing; merge the server into `mcpServers`, preserving other entries.
   - **macOS/Linux:** use the reference's `/bin/sh` server entry with the absolute launcher path.
   - **Windows:** use the [Windows/WSL2 entry](../skills/amp-supervision/references/platform-setup.md#windows-desktop-with-wsl2).
     Match the exact distribution name from `wsl --list --verbose`; pass the Linux launcher
     path to `wsl.exe`, not a `C:\...` path. Do not assume Windows environment variables
     automatically reach Linux.
7. Save valid JSON, fully quit Claude Desktop and reopen it. Confirm the server starts
   and exposes all four tools. No separate `bun run start` terminal is needed: Desktop
   starts the bridge through the launcher and communicates over its stdin/stdout.

The default request journal is `~/.local/state/amp-supervision/requests.sqlite`. Keep it
private and persistent. If you override its directory, use an absolute path. Every client
controlling the same threads must use the same journal and OS user; use only one supervisor
writer per thread. Never clear the journal to bypass an outstanding request.

## 7. Install and activate the supervisor skill

The bridge provides tools; the skill provides operating instructions. You need both.

1. Read [Anthropic's current skill instructions](https://support.claude.com/en/articles/12512180-using-skills-in-claude).
   Enable **Code execution and file creation** under **Settings → Capabilities** if required.
   Team/Enterprise users may need their organization to permit skills and skill creation.
2. Open **Customize → Skills**, choose **+ → Create skill → Upload a skill** and select
   the built archive. UI wording can vary by release. If the picker accepts only `.zip`,
   make an identical copy from the repository root:

   ```sh
   cp dist/amp-supervision.skill dist/amp-supervision.zip
   ```

   Upload that ZIP. Do not upload only `SKILL.md`: the referenced files must accompany it.
   This is a filename compatibility copy, not a different build.
3. On Windows, browse to the archive through File Explorer's `\\wsl.localhost\Ubuntu\home\...`
   route, replacing the distribution/user/path as necessary. Alternatively, copy **only
   the skill archive** to Downloads for upload; leave the executable installation in WSL.
4. Enable the uploaded `amp-supervision` skill and start a fresh Desktop conversation.
   Uploading through your Claude account does not itself connect the local bridge: confirm
   this actual Desktop Chat or Cowork surface can access both the skill and MCP tools.

Ask in the new conversation:

> Use the amp-supervision skill. Confirm that you can access amp_spawn, amp_read,
> amp_send and amp_list. Do not start or continue any thread yet. Report the configured
> runner ID/directory and bridge/policy identities from the tool description. Ask before
> dispatching work.

Compare those identities with the
[reviewed installation identity](../skills/amp-supervision/references/protocol.md#installation-identity-and-approved-cutover).
If tools or skill access are missing, stop and fix the connection. Do not silently switch
clients or expose the bridge through a public tunnel. An authorized `amp_list` call can
check authentication without starting work, but it returns private thread metadata to
the supervisor; only make that call in a trusted conversation.

## 8. Try one reversible task

First approve a disposable scratch location and a small inference budget. Follow the
[safe acceptance procedure](../skills/amp-supervision/references/acceptance-test.md) from
the supervisor, not by independently sending to the same thread from another client.
The example asks Amp to create a new scratch repository, stop for a blue/green decision,
record the supervisor's choice, then write and verify a small file. It forbids pushes,
PRs, deployment and use of existing repositories.

The loop is: brief once → spawn once → read progress → answer a blocked decision → read
completion → inspect evidence. **Accepted dispatch is not completed work.** The supervisor
cannot steer a running turn; it waits for a current settled response. Manual checks are
the default. Bounded watching needs an actual sleep/wait tool and your explicit request;
a conversational promise is not background monitoring.

Check the files and the original thread's tool history yourself: the decision record must
precede dependent work, and no unsolicited implementation child should appear. A final
message claiming success is not that audit. For real work, use the
[task brief template](../skills/amp-supervision/references/task-template.md), with acceptance
criteria and explicit permission boundaries. PR creation, merging and deployment are
separate actions, not implied by the scratch example.

Choose worker effort deliberately. The bridge can forward `low`, `medium`, `high` or
`ultra`; omission leaves the CLI default in effect. Begin with a bounded task and a suitable
mode rather than assuming the most expensive one is necessary. Modes and underlying
models change; check your current [Amp settings](https://ampcode.com/settings). Changing
effort does not grant additional authority, and continuations do not change mode/executor.

## 9. When something fails

A failure worth understanding before starting: a send can reach Amp even if the bridge
loses its response. Repeating it because the UI timed out can duplicate work. The journal
preserves the outstanding request so the supervisor can inspect the original thread.
This failure case is exercised with fake processes in the test suite; it is not a claimed
live incident or proof of Desktop acceptance.

| Symptom | First action |
| --- | --- |
| Executable not found | Recheck absolute paths and launcher PATH; GUI launch differs from your terminal |
| Tools absent | Check Desktop JSON, local MCP support and logs; fully quit/reopen Desktop |
| Tools present, skill absent | Enable/upload the complete skill and start a fresh conversation |
| Authentication fails | Check the same OS user and launcher environment; never share raw credential-bearing logs |
| Runner offline | Restore the original runner ID/directory; on Windows check the same WSL distribution/user |
| Spawn/send times out or its result is unknown | Preserve the journal, inspect with `amp_list`/`amp_read`; do not resend or respawn blindly |
| Bridge source changed | Stop new dispatch and use the approved upgrade/restart procedure; retain journal and worker threads |

See the full [protocol and recovery reference](../skills/amp-supervision/references/protocol.md).
Windows sleep or WSL shutdown can interrupt work. Reopening Desktop does not prove the
runner is back. Do not shut down a shared WSL installation merely to test recovery.

## 10. Before the next session

- Confirm the approved checkout, actual supervisor surface, skill and bridge identities.
- Confirm the runner is connected in the intended workspace under the right account.
- Keep one supervisor writer and one shared journal for the threads you control.
- Include the repository, executor, context, acceptance criteria and permission limits in the brief.
- Resolve every blocked decision explicitly; the worker records it before dependent work.
- Inspect verification evidence; keep merge, release and deployment decisions with the human.
- Record unverified platform/client behavior as pending, not passed.

## Editorial handoff

This first draft prioritizes installation and the Amp side. The next editorial pass should
refine the audience and narrative, add a genuinely observed worked example and failure
lesson, and incorporate fresh Windows/Linux acceptance corrections. No screenshots or
designed assets are included. Keep the launcher, transport configuration and recovery
contract canonical in the linked repository references; update those sources if testing
finds a technical error rather than correcting only this prose.

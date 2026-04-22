# Install

The current installer is still a bootstrap flow: it assumes a local checkout of the `asynq-agentd` repository and creates lightweight wrapper binaries that run the daemon directly from source.

## macOS / Linux

```bash
./scripts/install.sh
```

The script:

- checks `node` and `pnpm`
- installs workspace dependencies with `pnpm install`
- creates `asynq-agentd` and `asynq-agentctl` wrappers
- can install a user service via `launchd` or `systemd --user`
- lets the user choose an access mode (`local`, `tailscale`, `custom`)
- offers first-class Tailscale onboarding in `auto`, `manual`, or `skip` mode
- can best-effort install the Tailscale CLI formula with Homebrew on macOS or the official Tailscale install script on Linux
- uses a CLI-first Tailscale flow on macOS with the Homebrew system service (`sudo brew services start tailscale` + `tailscale up`)
- removes stale per-user Homebrew `tailscaled` LaunchAgents on macOS so only the system daemon remains
- validates that a detected `.ts.net` MagicDNS hostname resolves locally before the installer treats it as a safe pairing URL
- writes a reusable env file with bind host, port, and pairing URL defaults
- asks for a public daemon URL so pairing QR codes can point at the right address
- opens a browser pairing QR automatically once the daemon has created `auth.json`
- best-effort configures local speech transcription by downloading a default Whisper model and wiring `asynq-agentctl speech setup`

Hosted one-line setup can use a thin Pages wrapper like:

```bash
curl -fsSL https://agentd.asynq.org/install.sh | sh
```

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

The PowerShell installer:

- checks `node` and `pnpm`
- installs workspace dependencies with `pnpm install`
- creates `asynq-agentd.cmd` and `asynq-agentctl.cmd`
- can register a per-user Scheduled Task that starts the daemon on logon
- supports the same access-mode defaults and env-file setup as the Unix installer
- prompts for service mode, port, access mode, and pairing URL when those values were not passed explicitly
- offers first-class Tailscale onboarding and can best-effort install Tailscale with `winget`
- attempts `tailscale up` during install so the generated public URL can point at the real tailnet hostname
- accepts a public daemon URL for pairing
- prints pairing instructions, and opens a browser QR immediately if the daemon has already created `auth.json`

Hosted one-line setup can use a thin Pages wrapper like:

```powershell
irm https://agentd.asynq.org/install.ps1 | iex
```

## Notes

- The hosted `install.sh` and `install.ps1` entrypoints are intentionally thin wrappers today: they clone the repo into a temporary directory and then run `scripts/install.sh` or `scripts/install.ps1`.
- The installer currently runs from source rather than building a standalone binary.
- `asynq-agentd` stores runtime state in `~/.asynq-agentd` by default unless `ASYNQ_AGENTD_HOME` is set.
- If Tailscale is selected but auto-onboarding cannot complete, the installer still falls back safely: it keeps the generated env file, prints the next manual step, and lets you fix the public URL later.
- On macOS, the installer prefers the Homebrew `tailscale` formula over the GUI app flow so the `tailscale` CLI works consistently during onboarding, but it now treats the Homebrew service as system-only and verifies local MagicDNS resolution before trusting a `.ts.net` hostname.
- On Windows, the installer now writes both a PowerShell env file and a `.cmd` env file so the generated wrapper binaries really inherit the saved runtime settings.
- Pairing requires `auth.json`, which is generated on first daemon start. If the installer cannot find it yet, run `asynq-agentctl pairing` after the daemon is up (or use `--qr` to force terminal QR).
- Buddy on iPhone requires an `https://...` daemon endpoint for reliable pairing and live updates. In Tailscale Admin Console, enable certs at `DNS → HTTPS Certificates → Enable HTTPS`, then let `asynq-agentctl pairing` auto-bootstrap TLS when possible.
- Claude-backed tasks require a logged-in Claude Code CLI.
- Codex-backed tasks require a working `codex` CLI.
- Local voice dictation works best when `whisper-cli` and `ffmpeg` are installed. The installer now best-effort downloads the default Whisper model, and you can rerun setup later with `asynq-agentctl speech setup --install-model --restart`.

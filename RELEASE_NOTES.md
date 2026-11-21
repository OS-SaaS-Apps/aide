# AIDE Release Notes

## v1.0.7

### New
- **SSH panes** — connect a terminal pane to a remote host over SSH (via `ssh2`).
  - Profile manager: host, port, user, auth by password, SSH key or none (Tailscale SSH).
  - Secrets (password, private key, passphrase) are encrypted with Windows DPAPI (Electron `safeStorage`) and never leave the main process.
  - Interactive prompts for host-key confirmation (with a warning when a key changes), password, passphrase and 2FA.
  - Tailscale detection: lists online peers to pick a host from.
  - Test-connection button per profile.
- **Layout Designer** — visual, modal editor for the pane grid: draw panels, resize tracks, merge/split cells, set pane types and shared defaults (cwd, shell). Custom layouts are saved and reusable alongside the built-in ones.
- **Welcome screen** shown in empty tabs, with quick access to layouts.
- **Prompt archive** dialog to browse and reuse past prompts.
- **Pane settings** dialog and **quick tab** creation.
- **Maximize / restore** a pane within the main window.
- **Pane detach / adopt** — a running terminal can move between windows without losing its process or scrollback.
- **Claude Code session continuity** — sessions are tracked per pane and resumed when they still exist; last app state is saved on exit.

### Improvements
- OSC 52 clipboard support, so TUI apps (e.g. Claude Code fullscreen mode) can copy to the system clipboard.
- Fixed xterm scrollbar rendering.
- Large styling pass across dialogs, the designer and SSH UI.

### Build
- `postinstall` now rebuilds only `node-pty` (`electron-rebuild -o node-pty`); `npmRebuild` disabled in electron-builder.
- `ssh/` added to packaged files; new dependency `ssh2 ^1.17.0`.

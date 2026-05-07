# AIDE

A tiled workspace built with Electron — combine terminal, browser, file explorer, text editor, and Claude Code integration panes in any layout.

## Pane Types

| Key | Pane | Description |
|-----|------|-------------|
| `1` | Terminal | Full PTY shell (PowerShell 7 / `powershell.exe` / Git Bash / `cmd.exe`) |
| `2` | Browser | Embedded Chromium webview |
| `3` | Explorer | File system browser with copy/paste, rename, delete |
| `4` | Text Editor | Simple in-app text editor |
| — | Memory Vault | Persistent notes for Claude Code (via MCP) |
| — | Task Board | Kanban-style task list for Claude Code (via MCP) |

Up to 6 panes per tab. All pane types can be mixed freely.

## Features

- **Flexible layouts** — pick a built-in layout or define your own in `layouts.conf` using ASCII art
- **Multiple tabs** — each tab has its own independent pane set and layout
- **Pane settings** — configure shell, working directory, URL, or init command per pane via the ⚙ button
- **Detach pane** — pop any pane into its own window and reattach it later
- **Drag to swap** — drag a pane header onto another to swap positions
- **Resize** — drag the dividers between panes
- **Session save/restore** — save named sessions and restore the full layout on next open
- **Speech-to-text** — click the mic button to dictate into the focused terminal (Whisper tiny via `sherpa-onnx`)
- **Dark mode** — VS Code-inspired dark theme applied to embedded webviews too
- **Clipboard** — read/write from terminal keybindings

## Claude Code Integration

AIDE has first-class support for [Claude Code](https://claude.ai/code) workflows.

### Memory Vault & Task Board panes

Add a **Memory Vault** or **Task Board** pane from the toolbar. Each pane manages a folder of structured notes or tasks that are exposed to Claude Code via a local MCP server.

When you click **Associate** on a Memory or Tasks pane, AIDE:

1. Writes an `.mcp.json` into the working directory of every Claude Code terminal in the current tab, registering the MCP server.
2. Injects a `CLAUDE.md` snippet so Claude knows the tools are available.
3. For Memory: adds a `UserPromptSubmit` hook that automatically searches relevant memories before each prompt.

Restart Claude Code in the pane after associating to activate the MCP tools.

### Session resume

When a terminal pane has an init command that starts Claude Code (e.g. `claude`), AIDE tracks the session ID and injects `--resume <id>` automatically on the next start so your conversation continues where it left off.

### Summary generation

AIDE can generate a short summary of any Claude Code session by reading its `.jsonl` transcript and asking Claude to summarise it.

## Layouts

Layouts are defined as ASCII art in `layouts.conf`. Copy the bundled file to your user config directory to customise it:

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\AIDE\layouts.conf` |
| macOS | `~/Library/Application Support/AIDE/layouts.conf` |
| Linux | `~/.config/AIDE/layouts.conf` |

### Format

```
[Layout Name]
<ascii art>
```

| Character | Meaning |
|-----------|---------|
| `1` | New Terminal pane |
| `2` | New Browser pane |
| `3` | New Explorer pane |
| `4` | New Text Editor pane |
| ` ` (space) | Extend pane left/up |
| Shorter row | All columns extend the row above |

### Examples

```
# Terminal + browser side by side
21

# Browser spanning 2 rows, two stacked terminals on the right
21
 1

# Vibe layout (2 terminals + browser, repeated)
112
11
112
11
```

## Speech-to-Text

STT uses the Whisper tiny model (~40 MB, downloaded on first use from [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx/releases)). The model is stored in your user data directory. Click the mic button in the toolbar to start/stop recording; transcribed text is injected into the focused terminal.

Language selection is available in STT settings.

## Prerequisites

- **Node.js** 18 or later — https://nodejs.org
- **Visual Studio Build Tools 2022** (required by `node-pty`)
  - Install the **Desktop development with C++** workload
  - Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/

> **`.npmrc` note:** `node-pty` needs `msvs_version=2022`. If `npm install` fails to locate MSBuild, add `msbuild_path=<path to MSBuild.exe>` to a local `.npmrc`.

## Install & Run

```bash
npm install   # also runs electron-rebuild for node-pty
npm start
```

## Build

Produces an NSIS installer and a portable `.exe` in `dist/`:

```bash
npm run dist
```

## License

MIT

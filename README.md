# AIConsole

A tiled workspace built with Electron — combine terminal, browser, file explorer, and text editor panes in any layout.

## Pane Types

| Key | Pane | Description |
|-----|------|-------------|
| `1` | Terminal | Full PTY shell (PowerShell 7 / `powershell.exe` fallback) |
| `2` | Browser | Embedded Chromium webview |
| `3` | Explorer | File system browser |
| `4` | Text Editor | Simple in-app text editor |

Up to 6 panes per tab.

## Features

- **Flexible layouts** — pick a built-in layout or define your own in `layouts.conf` using ASCII art
- **Multiple tabs** — each tab has its own independent set of panes and layout
- **Pane settings** — configure shell command, working directory, or URL per pane via the ⚙ button
- **Detach pane** — pop any pane into its own window, reattach later
- **Drag to swap** — drag a pane header onto another to swap positions
- **Speech-to-text** — click the mic button to dictate into the focused terminal (powered by Whisper tiny via `sherpa-onnx`)
- **Dark mode** — VS Code-inspired dark theme, applied to embedded webviews too

## Prerequisites

- **Node.js** 18 or later — https://nodejs.org
- **Visual Studio Build Tools 2022** (required by `node-pty` native addon)
  - Install the "Desktop development with C++" workload
  - Download: https://visualstudio.microsoft.com/visual-cpp-build-tools/

> **Note for `.npmrc`:** `node-pty` needs `msvs_version=2022`. If `npm install` fails to find MSBuild, add `msbuild_path=<path to MSBuild.exe>` to a local `.npmrc`.

## Install & Run

```bash
npm install   # also runs electron-rebuild for node-pty
npm start
```

## Layouts

Layouts are defined as ASCII art in `layouts.conf` (bundled) or in your user config directory:

- Windows: `%APPDATA%\AIConsole\layouts.conf`
- macOS: `~/Library/Application Support/AIConsole/layouts.conf`
- Linux: `~/.config/AIConsole/layouts.conf`

Example:

```
[Browser + 2 Terminals]
21
 1
```

Characters: `1` = Terminal, `2` = Browser, `3` = Explorer, `4` = Text Editor, space = extend left/up.

## Speech-to-Text

STT uses the Whisper tiny model (~40 MB, downloaded on first use). The model is fetched from the [k2-fsa/sherpa-onnx releases](https://github.com/k2-fsa/sherpa-onnx/releases) and stored in your user data directory. Click the mic button in the toolbar to start/stop recording; transcribed text is injected into the focused terminal.

## Build

```bash
npm run dist   # produces an NSIS installer and portable .exe in dist/
```

# clawd-doom

Play **DOOM** inside [Claude Code](https://claude.com/claude-code), in your terminal.

Type `/doom` and a pane opens with the game running in it, drawn in coloured half-block pixels. **Just type
to play**: the pane takes the keyboard and every key goes to the game, no click needed. `Esc` hands the
keyboard back to Claude Code; click the DOOM pane to take it again. Claude keeps working while you play.

It ships with [Freedoom](https://freedoom.github.io/) (free, BSD-licensed DOOM-compatible levels and art), so
it works straight after install. Point it at your own `DOOM.WAD`, `DOOM1.WAD` (shareware) or `DOOM2.WAD` to
play the real thing.

## Install

```
/plugin install clawd-doom --marketplace StudentOcd/clawd-doom
```

Requires Claude Code with function-hook mods (early access), and a terminal that draws block characters and
24-bit colour (Windows Terminal, iTerm2, kitty, WezTerm, VS Code's terminal, most Linux terminals).

## Play

| Command | What it does |
| --- | --- |
| `/doom` | Opens the DOOM pane and starts the game |
| `/doom-quit` | Quits the game and closes the pane (closing the pane quits too) |

| Key | Action |
| --- | --- |
| `W` / `S` | Forward / back |
| `A` / `D` | Turn left / right |
| `Q` / `E` | Strafe left / right |
| `Shift` + any of those | Run |
| `F` | Fire (hold to keep firing) |
| `Space` | Use: open doors, press switches |
| `1` – `7` | Weapons |
| `M` | Automap |
| `X` | Menu (Esc can't reach the game: it gives the keyboard back) |
| `Enter`, `Y`, `N` | Menu choices |

The keys go through a small field under the picture, which is why only letters, digits, Space and Enter are
used. If your terminal passes mouse clicks to Claude Code, clicking the help line under the field also lets
the arrow keys, `Tab` and `Backspace` work.

A terminal tells programs when a key is pressed but never when it's released, so a held key keeps you moving
until about half a second after your last press, about as long as the terminal waits before it starts repeating
a held key. Tap to nudge, hold to keep moving.

The picture fits the pane at 4:3; widen the terminal (or the pane) for more pixels. Saves and settings are
kept in the plugin's folder.

## Options

Set in the install screen or later in `/config`:

| Option | What it is |
| --- | --- |
| **Your own WAD file** | Full path to an IWAD you own. Empty plays Freedoom. |

## How it works

DOOM itself can't run inside a plugin (no WebAssembly there), so the plugin ships a small native engine per
platform in `bin/`, built from [doomgeneric](https://github.com/ozkl/doomgeneric) with a platform layer of its
own (`engine/doomgeneric_claude.c`):

- the engine renders at 320×200, scales each frame to the pane's size and writes it to stdout as one line of
  half-block cells, in exactly the form Claude Code's `Raster` element takes, so the plugin hands each frame
  straight to the terminal;
- the plugin writes the keys you hold to a small control file the engine reads every frame;
- the plugin refreshes that file every second, and the engine quits by itself if it stops, so no game is ever
  left running unseen.

Engines included: Windows x64, macOS (Apple silicon and Intel), Linux (x64 and arm64). No sound.

## Develop

```
engine/build.sh native   # this machine's engine, with cc
engine/build.sh          # every platform (needs zig: pip install ziglang)
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

## License

GPL-2.0, as DOOM's source (via doomgeneric) is. Freedoom (`wad/`) is under its own BSD-style license, in
`wad/COPYING-freedoom.txt`. DOOM is a trademark of id Software; this project is not affiliated with id.

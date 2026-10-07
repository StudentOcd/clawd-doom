import type { Screen } from '../types'

// Shown while loading, so you can tell which version is running. Keep in step with plugin.json.
export const VERSION = '0.1.2'
export const PANE = 'doom'
export const CONTROL_FILE = '.clawd-doom-control'
// What the engine printed, kept for when something goes wrong.
export const LOG_FILE = 'clawd-doom.log'
export const NO_PICTURE_MS = 15_000
// The key field is emptied once it holds this many characters.
export const FIELD_LIMIT = 80
// How often held keys are checked for release, and how often the engine hears we are still here.
export const KEY_TICK_MS = 40
export const HEARTBEAT_MS = 1000

// DOOM's own key codes (doomkeys.h).
const UP = 0xad, DOWN = 0xaf, LEFT = 0xac, RIGHT = 0xae
const STRAFE_L = 0xa0, STRAFE_R = 0xa1, USE = 0xa2, FIRE = 0xa3
const ESCAPE = 27, ENTER = 13, TAB = 9, RUN = 0x80 + 0x36

// A terminal only says when a key goes down, never when it comes up. So a key
// counts as held for a while after each press: long enough to bridge the pause
// before the terminal's key repeat starts, then a little past each repeat.
export const FIRST_HOLD_MS = 520
export const REPEAT_HOLD_MS = 140
export const TAP_MS = 120

type Binding = { codes: number[]; tap?: boolean }

// Every key here can be typed into the pane's field (letters, digits, Space, Enter),
// so the game plays with no click; arrows, Tab and Backspace work once the strip is clicked.
const KEYS: Record<string, Binding> = {
  w: { codes: [UP] }, up: { codes: [UP] },
  s: { codes: [DOWN] }, down: { codes: [DOWN] },
  a: { codes: [LEFT] }, left: { codes: [LEFT] },
  d: { codes: [RIGHT] }, right: { codes: [RIGHT] },
  q: { codes: [STRAFE_L] }, ',': { codes: [STRAFE_L] },
  e: { codes: [STRAFE_R] }, '.': { codes: [STRAFE_R] },
  // Capitals (Shift held) run.
  W: { codes: [UP, RUN] }, S: { codes: [DOWN, RUN] }, A: { codes: [LEFT, RUN] }, D: { codes: [RIGHT, RUN] },
  Q: { codes: [STRAFE_L, RUN] }, E: { codes: [STRAFE_R, RUN] },
  f: { codes: [FIRE] }, F: { codes: [FIRE] },
  ' ': { codes: [USE], tap: true }, space: { codes: [USE], tap: true },
  return: { codes: [ENTER], tap: true }, enter: { codes: [ENTER], tap: true },
  // Escape never reaches the game (it hands the keyboard back), so the menu has its own key.
  x: { codes: [ESCAPE], tap: true }, X: { codes: [ESCAPE], tap: true }, backspace: { codes: [ESCAPE], tap: true },
  m: { codes: [TAB], tap: true }, M: { codes: [TAB], tap: true }, tab: { codes: [TAB], tap: true },
  y: { codes: [121], tap: true }, n: { codes: [110], tap: true },
  '-': { codes: [45], tap: true }, '=': { codes: [61], tap: true },
}

for (const digit of '1234567') {
  KEYS[digit] = { codes: [digit.charCodeAt(0)], tap: true }
}

export function bindingFor(key: string): Binding | null {
  return KEYS[key] ?? KEYS[key.toLowerCase()] ?? null
}

// What was typed into the field since it last held `before`: the new characters,
// or none when the text shrank or was replaced (Enter, a reset, a deletion).
export function typedSince(before: string, after: string): string {
  return after.startsWith(before) ? after.slice(before.length) : ''
}

// Held keys: DOOM key code to the time it is let go.
export type Held = Map<number, number>

// Presses a terminal key: true when it changed which keys are held.
export function press(held: Held, key: string, now: number): boolean {
  const binding = bindingFor(key)

  if (!binding) {
    return false
  }

  let changed = false

  for (const code of binding.codes) {
    const until = held.get(code)
    const isHeld = until !== undefined && until > now
    const next = binding.tap ? now + TAP_MS : now + (isHeld ? REPEAT_HOLD_MS : FIRST_HOLD_MS)

    changed ||= !isHeld
    held.set(code, Math.max(until ?? 0, next))
  }

  return changed
}

// Lets go of the keys whose time is up: true when any was.
export function release(held: Held, now: number): boolean {
  let changed = false

  for (const [code, until] of held) {
    if (until <= now) {
      held.delete(code)
      changed = true
    }
  }

  return changed
}

// What the engine reads every frame: a heartbeat, the size to draw, the keys held.
export function controlText(seq: number, columns: number, rows: number, held: Held): string {
  return `${seq} ${columns} ${rows}\n${[...held.keys()].sort((a, b) => a - b).join(' ')}\n`
}

// One line of the engine's output: "F<columns>,<rows>,<cells>", or null for anything else.
export function parseFrame(line: string): Screen | null {
  if (!line.startsWith('F')) {
    return null
  }

  const first = line.indexOf(',')
  const second = line.indexOf(',', first + 1)
  const columns = Number(line.slice(1, first))
  const rows = Number(line.slice(first + 1, second))
  const cells = line.slice(second + 1).trimEnd()

  if (first < 0 || second < 0 || !Number.isInteger(columns) || !Number.isInteger(rows) || cells.length === 0) {
    return null
  }

  return { columns, rows, cells }
}

// The biggest 4:3 picture that fits the pane's body, in cells (each cell two pixels tall).
// Two rows are kept beneath it: the key field and the line of help.
export function fitScreen(bodyColumns: number, bodyRows: number): { columns: number; rows: number } {
  const room = Math.max(4, bodyRows - 2)
  let columns = Math.min(512, Math.max(16, bodyColumns))
  let rows = Math.floor((columns * 3) / 8)

  if (rows > room) {
    rows = room
    columns = Math.floor((rows * 8) / 3)
  }

  return { columns: Math.max(16, columns), rows: Math.max(6, Math.min(256, rows)) }
}

// The engine built for this machine, under the plugin's bin folder.
export function enginePath(root: string, uname: string): string {
  const isWindows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')

  if (isWindows) {
    return `${root}\\bin\\win32-x64\\clawd-doom.exe`
  }

  const [system = '', machine = ''] = uname.trim().toLowerCase().split(/\s+/)
  const os = system === 'darwin' ? 'darwin' : 'linux'
  const arch = /arm64|aarch64/.test(machine) ? 'arm64' : 'x64'

  return `${root}/bin/${os}-${arch}/clawd-doom`
}

export const join = (root: string, name: string) =>
  /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\') ? `${root}\\${name}` : `${root}/${name}`

export const HELP =
  'type to play: W/S move · A/D turn · Q/E strafe · F fire · Space doors · Shift run · 1-7 weapons · M map · Enter select · X menu · Esc gives the keyboard back'

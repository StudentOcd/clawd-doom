import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Screen } from '../types'
import {
  CONTROL_FILE,
  HEARTBEAT_MS,
  HELP,
  KEY_TICK_MS,
  PANE,
  controlText,
  enginePath,
  fitScreen,
  join,
  parseFrame,
  press,
  release,
} from './doom'
import type { Held } from './doom'

const screen = atom({ plugin: 'clawd-doom', key: 'screen' } as const, null as Screen | null)
const status = atom({ plugin: 'clawd-doom', key: 'status' } as const, '')

// The running game, kept in one object so the helpers can sit at the top level of the file.
type Game = {
  isRunning: boolean
  stop: () => void
  timers: Timer[]
  held: Held
  seq: number
  want: { columns: number; rows: number }
  // The size the pane's Raster was drawn at, and the newest frame not yet shown.
  shown: { columns: number; rows: number } | null
  pending: Screen | null
  isShowing: boolean
  redrawnAt: number
  writing: Promise<void>
  controlPath: string
}

const game: Game = {
  isRunning: false,
  stop: () => {},
  timers: [],
  held: new Map(),
  seq: 0,
  want: { columns: 120, rows: 45 },
  shown: null,
  pending: null,
  isShowing: false,
  redrawnAt: 0,
  writing: Promise.resolve(),
  controlPath: '',
}

// Tells the engine the size to draw and the keys held; writes run one after another.
function writeControl($: EngineInterface) {
  const text = controlText(game.seq, game.want.columns, game.want.rows, game.held)
  game.writing = game.writing.then(() => $.fs.write(game.controlPath, text)).catch(() => {})

  return game.writing
}

// Shows the newest frame: a repaint of the Raster in place, or a redraw when its size changed.
async function show($: EngineInterface, frame: Screen) {
  game.pending = frame

  if (game.isShowing) {
    return
  }

  game.isShowing = true

  try {
    while (game.pending) {
      const next = game.pending
      game.pending = null
      const fits = game.shown?.columns === next.columns && game.shown.rows === next.rows
      const blitted = fits ? await $.ui.blit({ requestId: PANE, key: 'screen', ...next }) : { deny: 'resized' }

      // A full redraw is heavy, so one that keeps failing (the pane hidden) is held to twice a second.
      if (blitted.deny !== undefined) {
        const now = await $.clock.now()

        if (!fits || now - game.redrawnAt >= 500) {
          game.redrawnAt = now
          game.shown = { columns: next.columns, rows: next.rows }
          await update($, screen, () => next)
        }
      }
    }
  } finally {
    game.isShowing = false
  }
}

async function setStatus($: EngineInterface, text: string) {
  await update($, status, () => text)
}

function stop($: EngineInterface) {
  for (const timer of game.timers) {
    timer.cancel()
  }

  game.timers = []
  game.held.clear()

  if (game.isRunning) {
    game.isRunning = false
    game.stop()
    void setStatus($, 'DOOM stopped. /doom to play again')
  }
}

async function start($: EngineInterface, wad: string) {
  if (game.isRunning) {
    return
  }

  const root = $.plugin.root
  const isWindows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\')
  let uname = ''

  if (!isWindows) {
    try {
      uname = (await $.process.run(['uname', '-sm'])).stdout
    } catch {
      // assume Linux on x64
    }
  }

  const engine = enginePath(root, uname)
  const iwad = wad || join(join(root, 'wad'), 'freedoom1.wad')

  if (!(await $.fs.exists(engine))) {
    await setStatus($, `No DOOM engine for this machine (looked for ${engine}).`)

    return
  }

  if (!(await $.fs.exists(iwad))) {
    await setStatus($, `WAD not found: ${iwad}`)

    return
  }

  if (!isWindows) {
    // An install may lose the executable bit.
    await $.process.run(['chmod', '+x', engine]).catch(() => undefined)
  }

  game.controlPath = join(root, CONTROL_FILE)
  game.isRunning = true
  game.seq += 1
  game.shown = null
  await writeControl($)
  await setStatus($, 'loading DOOM…')

  game.timers = [
    $.clock.every(KEY_TICK_MS, () => {
      void $.clock.now().then(now => {
        if (release(game.held, now)) {
          void writeControl($)
        }
      })
    }),
    $.clock.every(HEARTBEAT_MS, () => {
      game.seq += 1
      void writeControl($)
    }),
  ]

  const stream = $.process.spawn({
    argv: [engine, '-iwad', iwad],
    cwd: root,
    env: { CLAWD_DOOM_CONTROL: game.controlPath },
  })
  game.stop = () => void stream.return?.(undefined as never)

  // The loop is the engine's life: it runs on after the command answers.
  void (async () => {
    let buffer = ''
    let error = ''
    let isFirst = true

    try {
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') {
          error = chunk.text.trim().split('\n').at(-1) ?? error
          continue
        }

        buffer += chunk.text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        let frame: Screen | null = null

        for (const line of lines) {
          frame = parseFrame(line.replace(/\r$/, '')) ?? frame
        }

        if (frame) {
          if (isFirst) {
            isFirst = false
            void setStatus($, '')
          }

          void show($, frame)
        }
      }
    } catch (failure) {
      error = String(failure)
    }

    if (game.isRunning) {
      stop($)
      await setStatus($, error ? `DOOM stopped: ${error}` : 'DOOM quit. /doom to play again')
    }
  })()
}

export const register: Register = (on, options) => {
  const wad = typeof options.wad === 'string' ? options.wad.trim() : ''

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'doom', description: 'Play DOOM in a pane' })
    await $.command.register({ name: 'doom-quit', description: 'Quit DOOM and close its pane' })

    return next(e)
  })

  on('command.run', { command: 'doom' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'DOOM', focus: true, rows: 60 })
    await start($, wad)

    return {
      text: opened.isPlaced
        ? 'DOOM is running in the pane. Click the screen to take the keyboard; Esc gives it back.'
        : `DOOM is running, but its pane is waiting for room: ${opened.reason}`,
    }
  })

  on('command.run', { command: 'doom-quit' }, async $ => {
    stop($)
    await $.ui.close({ id: PANE })

    return { text: 'DOOM quit.' }
  })

  // Every key the person presses on the screen.
  on('ui.message', { requestId: 'doom' }, async ($, e, next) => {
    const data = e.data as { key?: unknown } | null

    if (game.isRunning && data && typeof data.key === 'string') {
      if (press(game.held, data.key, await $.clock.now())) {
        await writeControl($)
      }
    }

    return next(e)
  })

  on('ui.close', { id: 'doom' }, async ($, e, next) => {
    stop($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'doom' }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    if (e.surface !== 'terminal') {
      return <Text>DOOM plays in the terminal only.</Text>
    }

    const { Raster, Client } = $.ui.resolve(e)
    const want = fitScreen(e.props.bodyColumns, e.props.scroll.bodyRows)

    if (want.columns !== game.want.columns || want.rows !== game.want.rows) {
      game.want = want

      if (game.isRunning) {
        void writeControl($)
      }
    }

    const frame = await read($, screen)
    const said = await read($, status)

    return (
      <Box flexDirection="column">
        {frame ? (
          <Raster key="screen" columns={frame.columns} rows={frame.rows} cells={frame.cells} />
        ) : (
          <Text>{said || 'Type /doom to start.'}</Text>
        )}
        <Client key="keys" module="./keys.tsx" props={{ help: HELP, status: frame ? said : '' }} />
      </Box>
    )
  })
}

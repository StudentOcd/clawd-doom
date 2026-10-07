import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import {
  FIRST_HOLD_MS,
  FIELD_LIMIT,
  HEARTBEAT_MS,
  NO_PICTURE_MS,
  REPEAT_HOLD_MS,
  TAP_MS,
  controlText,
  enginePath,
  fitScreen,
  parseFrame,
  press,
  release,
  typedSince,
  VERSION,
} from '../hooks/doom'
import type { Held } from '../hooks/doom'

const NOW = 1_800_000_000_000
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array) {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }

  return out
}

// A frame as the engine writes it: every cell an upper half block in `color` over black.
function frameLine(columns: number, rows: number, color: number) {
  const words = new Uint32Array(columns * rows * 3)

  for (let i = 0; i < columns * rows; i++) {
    words.set([0x2580, color, 0], i * 3)
  }

  return `F${columns},${rows},${base64(new Uint8Array(words.buffer))}\n`
}

const PANE_PROPS = {
  title: 'DOOM',
  isFocused: true,
  bodyColumns: 64,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

// The machine beneath the plugin: a clock, the files it writes, and an engine
// that streams the frames the test hands it until the test or the plugin ends it.
function world(on: On, options: { engineExists?: boolean } = {}) {
  const clock = mock.clock(on, { now: NOW })
  // What the plugin writes to the control file, and to its log.
  const writes: string[] = []
  const logs: string[] = []
  const spawned: { argv: readonly string[]; env?: Record<string, string> }[] = []
  const engine = { send: (_text: string) => {}, end: () => {}, isAlive: false }

  on('command.register', () => ({ value: undefined as never }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined as never }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'Linux x86_64\n', stderr: '' } as never }))
  on('fs.exists', ($, e) => ({ value: (options.engineExists ?? true) || !e.path.includes('/bin/') }))
  on('fs.write', ($, e) => {
    ;(e.path.endsWith('.log') ? logs : writes).push(e.text)

    return { value: undefined as never }
  })
  on('process.spawn', async function* ($, e) {
    spawned.push({ argv: e.argv, ...(e.env ? { env: e.env } : {}) })
    const queue: string[] = []
    let wake = () => {}
    engine.isAlive = true
    engine.send = text => {
      queue.push(text)
      wake()
    }
    engine.end = () => {
      engine.isAlive = false
      wake()
    }

    try {
      while (engine.isAlive || queue.length) {
        if (queue.length) {
          yield { stream: 'stdout' as const, text: queue.shift()! }
        } else {
          await new Promise<void>(resolve => (wake = resolve))
        }
      }
    } finally {
      engine.isAlive = false
    }

    return { value: { code: 0, signal: null } }
  })

  return { clock, writes, logs, spawned, engine }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const doom = ($: Engine, command = 'doom') => $.command.run({ command, args: '' } as never)
const mount = ($: Engine) =>
  $.ui.mount({ plugin: 'clawd-doom', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'doom' })

type Pane = Awaited<ReturnType<typeof mount>>

const rasters = async (pane: Pane) => pane.findAll({ type: 'Raster' })
const shown = async (pane: Pane) => (await pane.findAll({ type: 'Text' })).map(text => text.text).join('\n')

describe('playing', () => {
  test('/doom starts the engine for this machine and draws its frames', async ($, on) => {
    const { clock, spawned, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.argv[0]).toMatch(/\/bin\/linux-x64\/clawd-doom$/)
    expect(spawned[0]!.argv.slice(1, 3)).toEqual(['-nogui', '-iwad'])
    expect(spawned[0]!.argv[3]).toMatch(/\/wad\/freedoom1\.wad$/)
    expect(spawned[0]!.env?.CLAWD_DOOM_CONTROL).toMatch(/\.clawd-doom-control$/)

    engine.send(frameLine(64, 24, 0xff0000))
    await clock.advance(10)
    const drawn = await rasters(pane)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.props).toEqual(expect.objectContaining({ columns: 64, rows: 24 }))

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('frames split across chunks still arrive whole', async ($, on) => {
    const { clock, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    const line = frameLine(32, 12, 0x00ff00)
    engine.send('Doom Generic 0.1\n' + line.slice(0, 50))
    engine.send(line.slice(50))
    await clock.advance(10)
    expect((await rasters(pane))[0]!.props).toEqual(expect.objectContaining({ columns: 32, rows: 12 }))
    expect(await shown(pane)).not.toContain('loading DOOM')

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('keys on the screen reach the engine, held and then let go', async ($, on) => {
    const { clock, writes, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    await pane.key({ key: 'w' })
    expect(writes.at(-1)).toMatch(/\n173\n$/)

    await clock.advance(FIRST_HOLD_MS + 100)
    expect(writes.at(-1)).toMatch(/\n\n$/)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('typing into the field plays, no click needed', async ($, on) => {
    const { clock, writes, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)
    expect(await pane.find({ key: 'play' })).toBeTruthy()

    await pane.input({ key: 'play', text: 'w', kind: 'change' })
    expect(writes.at(-1)).toMatch(/\n173\n$/)

    await pane.input({ key: 'play', text: 'wf', kind: 'change' })
    expect(writes.at(-1)).toMatch(/\n163 173\n$/)

    await clock.advance(FIRST_HOLD_MS + 100)
    await pane.input({ key: 'play', text: 'wf', kind: 'submit' })
    expect(writes.at(-1)).toMatch(/\n13\n$/)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('the field empties itself once it fills up, without pressing anything', async ($, on) => {
    const { clock, writes, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    let text = ''

    for (let i = 0; i <= FIELD_LIMIT; i++) {
      text += 'w'
      await pane.input({ key: 'play', text, kind: 'change' })
    }

    expect((await pane.find({ key: 'play' }))!.props).toEqual(expect.objectContaining({ value: '›' }))

    // The field now reads '›' and what follows is new; the old text shrinking away presses nothing.
    await clock.advance(FIRST_HOLD_MS + 100)
    await pane.input({ key: 'play', text: '›', kind: 'change' })
    expect(writes.at(-1)).toMatch(/\n\n$/)
    await pane.input({ key: 'play', text: '›f', kind: 'change' })
    expect(writes.at(-1)).toMatch(/\n163\n$/)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('the heartbeat keeps the engine alive, and /doom-quit stops it', async ($, on) => {
    const { clock, writes, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    const before = writes.length
    await clock.advance(HEARTBEAT_MS * 3)
    expect(writes.length).toBeGreaterThanOrEqual(before + 3)

    // A real engine is mid-frame; this one is woken by one more line of output to notice the stop.
    await doom($, 'doom-quit')
    engine.send('noise\n')
    await clock.advance(10)
    expect(engine.isAlive).toBe(false)

    const after = writes.length
    await clock.advance(HEARTBEAT_MS * 3)
    expect(writes.length).toBe(after)
    await pane.unmount()
  })

  test('while it loads, the pane shows what the engine is doing', async ($, on) => {
    const { clock, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    engine.send('W_Init: Init WADfiles.\n')
    await clock.advance(10)
    expect(await shown(pane)).toContain(`loading DOOM ${VERSION}… W_Init: Init WADfiles.`)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('no picture after a while: says so, with what the engine last printed and where the log is', async ($, on) => {
    const { clock, logs, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    engine.send('R_Init: Init DOOM refresh daemon\n')
    await clock.advance(NO_PICTURE_MS + HEARTBEAT_MS)
    const said = await shown(pane)
    expect(said).toContain('No picture after')
    expect(said).toContain('R_Init: Init DOOM refresh daemon')
    expect(said).toContain('clawd-doom.log')
    expect(logs.some(text => text.startsWith(`clawd-doom ${VERSION}`) && text.includes('R_Init'))).toBe(true)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })

  test('no engine for this machine: says so instead of starting', async ($, on) => {
    const { spawned } = world(on, { engineExists: false })
    await start($)
    const pane = await mount($)
    await doom($)

    expect(spawned).toHaveLength(0)
    expect(await shown(pane)).toContain('No DOOM engine for this machine')
    await pane.unmount()
  })

  test('the pane asks the engine for a picture that fits it', async ($, on) => {
    const { clock, writes, engine } = world(on)
    await start($)
    const pane = await mount($)
    await doom($)

    expect(writes.at(-1)).toMatch(/^\d+ 64 24\n/)
    await pane.redraw({ ...PANE_PROPS, bodyColumns: 160, scroll: { offset: 0, bodyRows: 50 } })
    await clock.advance(10)
    expect(writes.at(-1)).toMatch(/^\d+ 128 48\n/)

    engine.end()
    await clock.advance(10)
    await pane.unmount()
  })
})

describe('keys', () => {
  test('a first press holds past the pause before key repeat, repeats hold briefly', () => {
    const held: Held = new Map()
    expect(press(held, 'w', NOW)).toBe(true)
    expect(held.get(0xad)).toBe(NOW + FIRST_HOLD_MS)

    expect(press(held, 'w', NOW + 500)).toBe(false)
    expect(held.get(0xad)).toBe(NOW + 500 + REPEAT_HOLD_MS)

    expect(release(held, NOW + 500 + REPEAT_HOLD_MS)).toBe(true)
    expect(held.size).toBe(0)
  })

  test('menu and use keys are taps, capitals run, unknown keys do nothing', () => {
    const held: Held = new Map()
    press(held, 'return', NOW)
    expect(held.get(13)).toBe(NOW + TAP_MS)

    press(held, 'W', NOW)
    expect([...held.keys()]).toEqual(expect.arrayContaining([0xad, 0x80 + 0x36]))

    expect(press(held, 'z', NOW)).toBe(false)
  })

  test('only what was added to the field counts as typed', () => {
    expect(typedSince('ww', 'wwf')).toBe('f')
    expect(typedSince('wwf', 'ww')).toBe('')
    expect(typedSince('abc', 'xyz')).toBe('')
  })

  test('the control file lists the held keys in order', () => {
    const held: Held = new Map([
      [0xa3, NOW],
      [0xad, NOW],
    ])
    expect(controlText(7, 120, 45, held)).toBe('7 120 45\n163 173\n')
  })
})

describe('frames and machines', () => {
  test('frame lines parse, anything else is ignored', () => {
    expect(parseFrame('F2,1,AAAA')).toEqual({ columns: 2, rows: 1, cells: 'AAAA' })
    expect(parseFrame('Z_Init: Init zone memory')).toBe(null)
    expect(parseFrame('Fx,1,AAAA')).toBe(null)
  })

  test('the picture is the biggest 4:3 that fits', () => {
    expect(fitScreen(120, 100)).toEqual({ columns: 120, rows: 45 })
    expect(fitScreen(200, 31)).toEqual({ columns: 77, rows: 29 })
    expect(fitScreen(4, 4)).toEqual({ columns: 16, rows: 6 })
  })

  test('each machine gets its own engine', () => {
    expect(enginePath('C:\\Users\\me\\.claude\\plugins\\clawd-doom', '')).toBe(
      'C:\\Users\\me\\.claude\\plugins\\clawd-doom\\bin\\win32-x64\\clawd-doom.exe',
    )
    expect(enginePath('/p', 'Darwin arm64')).toBe('/p/bin/darwin-arm64/clawd-doom')
    expect(enginePath('/p', 'Darwin x86_64')).toBe('/p/bin/darwin-x64/clawd-doom')
    expect(enginePath('/p', 'Linux aarch64')).toBe('/p/bin/linux-arm64/clawd-doom')
    expect(enginePath('/p', 'Linux x86_64')).toBe('/p/bin/linux-x64/clawd-doom')
  })
})

// One frame of the game as the terminal draws it: a Raster's size and cells.
export type Screen = { columns: number; rows: number; cells: string }

declare module 'claude-code' {
  interface PluginState {
    'clawd-doom': {
      screen: Screen | null
      status: string
      field: string
    }
  }
}

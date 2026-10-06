import type { ClientModule } from 'claude-code'

type Props = { help: string; status: string }

// The strip under the screen. Once clicked it holds the keyboard, and every key
// goes to the hooks module, which plays it into the game.
const Keys: ClientModule<Props, boolean> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onKey(event => surface.post({ key: event.key }))
    surface.setState(true)
  }

  const { Text } = surface.elements

  return Text({ dimColor: true, wrap: 'truncate-end', children: props.status ? `${props.status} · ${props.help}` : props.help })
}

export default Keys

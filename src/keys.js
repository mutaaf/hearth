// One vocabulary of remote keys for every brand. The web UI only ever sends
// these names; each driver translates to its TV's native key code.
export const KEYS = {
  up: { lg: 'UP', samsung: 'KEY_UP' },
  down: { lg: 'DOWN', samsung: 'KEY_DOWN' },
  left: { lg: 'LEFT', samsung: 'KEY_LEFT' },
  right: { lg: 'RIGHT', samsung: 'KEY_RIGHT' },
  ok: { lg: 'ENTER', samsung: 'KEY_ENTER' },
  back: { lg: 'BACK', samsung: 'KEY_RETURN' },
  home: { lg: 'HOME', samsung: 'KEY_HOME' },
  menu: { lg: 'MENU', samsung: 'KEY_MENU' },
  info: { lg: 'INFO', samsung: 'KEY_INFO' },
  exit: { lg: 'EXIT', samsung: 'KEY_EXIT' },
  volup: { lg: 'VOLUMEUP', samsung: 'KEY_VOLUP' },
  voldown: { lg: 'VOLUMEDOWN', samsung: 'KEY_VOLDOWN' },
  mute: { lg: 'MUTE', samsung: 'KEY_MUTE' },
  chup: { lg: 'CHANNELUP', samsung: 'KEY_CHUP' },
  chdown: { lg: 'CHANNELDOWN', samsung: 'KEY_CHDOWN' },
  play: { lg: 'PLAY', samsung: 'KEY_PLAY' },
  pause: { lg: 'PAUSE', samsung: 'KEY_PAUSE' },
  stop: { lg: 'STOP', samsung: 'KEY_STOP' },
  rewind: { lg: 'REWIND', samsung: 'KEY_REWIND' },
  forward: { lg: 'FASTFORWARD', samsung: 'KEY_FF' },
  source: { samsung: 'KEY_SOURCE' },
};

export function keyCode(brand, name) {
  return KEYS[name]?.[brand] ?? null;
}

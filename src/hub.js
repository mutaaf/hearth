import { closeBridge } from './atv-bridge.js';
import { AppleTvDriver } from './drivers/appletv.js';
import { GoogleTvDriver } from './drivers/googletv.js';
import { LgDriver } from './drivers/lg.js';
import { RokuDriver } from './drivers/roku.js';
import { SamsungDriver } from './drivers/samsung.js';
import { Hub as CoreHub } from './hub-core.js';

// The home server's hub: the shared core (src/hub-core.js) with every brand
// and the Apple TV bridge. The phone app builds its own from the core.
export const DRIVERS = { lg: LgDriver, samsung: SamsungDriver, roku: RokuDriver, androidtv: GoogleTvDriver, appletv: AppleTvDriver };

export class Hub extends CoreHub {
  constructor(opts = {}) {
    super({ drivers: DRIVERS, onClose: closeBridge, ...opts });
  }
}

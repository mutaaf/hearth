"""pyatv's side of test/fixtures/pyatv-airplay-crosscheck.mjs (run that)."""
import asyncio
import sys

import pyatv
from pyatv.conf import AppleTV, ManualService
from pyatv.const import Protocol

PORT, CREDS, PIN = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
PROPS = {"model": "AppleTV11,1", "osvers": "17.0", "features": "0x4A7FDFD5,0xBC157FDE", "flags": "0x244"}


def conf(credentials):
    atv = AppleTV("127.0.0.1", "Fake")
    atv.add_service(ManualService("AA:BB:CC:DD:EE:FF", Protocol.AirPlay, PORT, PROPS, credentials=credentials))
    return atv


async def main():
    loop = asyncio.get_running_loop()
    atv = await pyatv.connect(conf(CREDS), loop)
    try:
        playing = None
        for _ in range(30):
            playing = await atv.metadata.playing()
            if playing.title:
                break
            await asyncio.sleep(0.2)
        app = atv.metadata.app
        print("pyatv with Hearth's credential:", app.identifier if app else None, "|", app.name if app else None,
              "|", playing.series_name, "|", playing.title, "|", playing.device_state, "|", playing.total_time)
        if not playing.title:
            sys.exit(1)
    finally:
        atv.close()
    handler = await pyatv.pair(conf(None), Protocol.AirPlay, loop, name="pyatv-check")
    try:
        await handler.begin()
        handler.pin(PIN)
        await handler.finish()
        print("pyatv paired:", handler.has_paired)
        print("CREDS", handler.service.credentials)
    finally:
        await handler.close()


asyncio.run(main())

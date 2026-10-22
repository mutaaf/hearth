#!/usr/bin/env python3
"""Hearth's Apple TV bridge: one long-lived process for every Apple TV.

Speaks JSON lines over stdio. Node (src/atv-bridge.js) writes requests:

    {"id": 7, "op": "connect", "key": "appletv-…", "ip": "…", "credentials": {…}}

and reads replies ({"id": 7, "ok": true, "result": …} or
{"id": 7, "ok": false, "code": "offline", "error": "…"}) plus pushed events:

    {"event": "ready", "pyatv": "0.18.0"}
    {"event": "state", "key": "…", "state": {…}}
    {"event": "closed", "key": "…", "reason": "…"}

pyatv does the protocol work (Companion for keys/power/apps, AirPlay's
tunnelled MRP for now-playing). Logs go to stderr; stdout is the protocol.
"""

import asyncio
import json
import logging
import sys

try:
    import pyatv
    from pyatv import exceptions
    from pyatv.const import (
        DeviceState,
        FeatureName,
        FeatureState,
        InputAction,
        PairingRequirement,
        PowerState,
        Protocol,
    )
    from pyatv.interface import AudioListener, DeviceListener, PowerListener, PushListener
except ImportError as err:  # pragma: no cover - reported to Node, which explains it
    sys.stdout.write(json.dumps({"event": "fatal", "error": f"pyatv is not installed ({err})"}) + "\n")
    sys.stdout.flush()
    sys.exit(3)

logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="[appletv-bridge] %(message)s")
log = logging.getLogger("hearth")

PROTOCOLS = {"companion": Protocol.Companion, "airplay": Protocol.AirPlay}
PAIR_NAME = "Hearth"
SCAN_TIMEOUT = 4

# Hearth key → (remote_control method, accepts InputAction). A whitelist: the
# bridge never calls an arbitrary attribute named by the caller.
REMOTE = {
    "up": True, "down": True, "left": True, "right": True, "select": True, "menu": True, "home": True,
    "play_pause": False, "play": False, "pause": False, "stop": False, "next": False, "previous": False,
    "skip_forward": False, "skip_backward": False, "channel_up": False, "channel_down": False,
    "volume_up": False, "volume_down": False, "control_center": False, "guide": False, "top_menu": False,
}


def emit(msg):
    sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class BridgeError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def is_apple_tv(conf):
    raw = conf.device_info.raw_model or ""
    if raw.startswith("AppleTV"):
        return True
    # pyatv knows the model even when a TXT record is missing.
    return conf.device_info.model.name.startswith(("Gen", "AppleTV"))


def describe(conf):
    di = conf.device_info
    services = {}
    for s in conf.services:
        services[s.protocol.name.lower()] = {"port": s.port, "pairing": s.pairing.name}
    return {
        "name": conf.name,
        "ip": str(conf.address),
        "identifier": conf.identifier,
        "model": di.raw_model or di.model_str,
        "modelName": di.model_str,
        "os": di.operating_system.name,
        "version": di.version,
        "appleTv": is_apple_tv(conf),
        "services": services,
    }


async def find(loop, ip=None, identifier=None):
    """Locate one device: unicast to its IP first, then by identifier."""
    if ip:
        confs = await pyatv.scan(loop, hosts=[ip], timeout=SCAN_TIMEOUT)
        if confs:
            return confs[0]
    if identifier:
        confs = await pyatv.scan(loop, identifier=identifier, timeout=SCAN_TIMEOUT)
        if confs:
            return confs[0]
    raise BridgeError("offline", "The Apple TV didn’t answer. Is it on the same Wi-Fi?")


class Device(DeviceListener, PowerListener, PushListener, AudioListener):
    """One live connection, plus the listeners that turn pushes into state."""

    def __init__(self, bridge, key, atv):
        self.bridge = bridge
        self.key = key
        self.atv = atv
        self.playing = None
        self.closed = False

    def available(self, name):
        try:
            return self.atv.features.in_state(FeatureState.Available, name)
        except Exception:
            return False

    def snapshot(self):
        atv = self.atv
        power = "unknown"
        try:
            ps = atv.power.power_state
            power = "on" if ps == PowerState.On else "off" if ps == PowerState.Off else "unknown"
        except Exception:
            pass
        state = {"online": True, "power": power, "app": None, "appTitle": None,
                 "title": None, "playing": None, "volume": None}
        if self.available(FeatureName.App):
            try:
                app = atv.metadata.app
                if app:
                    state["app"] = app.identifier
                    state["appTitle"] = app.name
            except Exception:
                pass
        p = self.playing
        if p is not None:
            title = p.title
            if p.series_name and title and p.series_name not in title:
                title = f"{p.series_name}: {title}"
            state["title"] = title or None
            state["position"] = p.position
            state["duration"] = p.total_time
            state["playing"] = {DeviceState.Playing: "playing", DeviceState.Paused: "paused",
                                DeviceState.Loading: "loading", DeviceState.Seeking: "playing"}.get(p.device_state)
        if self.available(FeatureName.Volume):
            try:
                state["volume"] = round(atv.audio.volume)
            except Exception:
                pass
        state["volumeLevel"] = self.available(FeatureName.SetVolume)
        return state

    def push(self):
        if not self.closed:
            emit({"event": "state", "key": self.key, "state": self.snapshot()})

    # DeviceListener
    def connection_lost(self, exception):
        self.bridge.drop(self.key, f"lost: {exception}")

    def connection_closed(self):
        self.bridge.drop(self.key, "closed")

    # PowerListener
    def powerstate_update(self, old_state, new_state):
        self.push()

    # PushListener
    def playstatus_update(self, updater, playstatus):
        self.playing = playstatus
        self.push()

    def playstatus_error(self, updater, exception):
        log.debug("playstatus error %s: %s", self.key, exception)

    # AudioListener
    def volume_update(self, old_level, new_level):
        self.push()

    def volume_device_update(self, output_device, old_level, new_level):
        pass

    def outputdevices_update(self, old_devices, new_devices):
        pass


class Bridge:
    def __init__(self, loop):
        self.loop = loop
        self.devices = {}  # key → Device
        self.pairings = {}  # key → (protocol name, PairingHandler)

    def drop(self, key, reason):
        dev = self.devices.pop(key, None)
        if dev and not dev.closed:
            dev.closed = True
            emit({"event": "closed", "key": key, "reason": reason})

    # ── ops ──────────────────────────────────────────────
    async def op_ping(self, req):
        return {"pyatv": version()}

    async def op_scan(self, req):
        confs = await pyatv.scan(self.loop, timeout=req.get("timeout", 5))
        return [describe(c) for c in confs]

    async def op_info(self, req):
        return {**describe(await find(self.loop, req.get("ip"), req.get("identifier"))), "pyatv": version()}

    async def op_pair_begin(self, req):
        key, proto = req["key"], req["protocol"]
        await self.cancel_pairing(key)
        conf = await find(self.loop, req.get("ip"), req.get("identifier"))
        if not conf.get_service(PROTOCOLS[proto]):
            raise BridgeError("unsupported", f"This Apple TV doesn’t offer {proto} pairing")
        handler = await pyatv.pair(conf, PROTOCOLS[proto], self.loop, name=PAIR_NAME)
        try:
            await handler.begin()
        except Exception:
            await handler.close()
            raise
        self.pairings[key] = (proto, handler)
        return {"protocol": proto, "devicePin": handler.device_provides_pin, "identifier": conf.identifier}

    async def op_pair_pin(self, req):
        key = req["key"]
        if key not in self.pairings:
            raise BridgeError("expired", "That code expired. Ask the Apple TV for a new one.")
        proto, handler = self.pairings.pop(key)
        try:
            handler.pin(int(str(req["pin"]).strip()))
            await handler.finish()
            if not handler.has_paired:
                raise BridgeError("auth", "The Apple TV didn’t accept that code")
            return {"protocol": proto, "credentials": handler.service.credentials}
        except exceptions.PairingError as err:
            raise BridgeError("auth", f"The Apple TV didn’t accept that code ({err})")
        finally:
            await handler.close()

    async def op_pair_cancel(self, req):
        await self.cancel_pairing(req["key"])
        return {}

    async def cancel_pairing(self, key):
        old = self.pairings.pop(key, None)
        if old:
            try:
                await old[1].close()
            except Exception:
                pass

    async def op_connect(self, req):
        key = req["key"]
        await self.op_disconnect({"key": key})
        conf = await find(self.loop, req.get("ip"), req.get("identifier"))
        creds = req.get("credentials") or {}
        for service in conf.services:
            name = service.protocol.name.lower()
            if name in creds and creds[name]:
                service.credentials = creds[name]
            elif name == "raop" or name == "dmap" or service.pairing == PairingRequirement.Mandatory:
                # Hearth doesn't stream audio, and an unpaired protocol would
                # only fail (or pop a code on the TV). Leave them alone.
                service.enabled = False
        atv = await pyatv.connect(conf, self.loop)
        dev = Device(self, key, atv)
        self.devices[key] = dev
        atv.listener = dev
        try:
            atv.power.listener = dev
        except Exception:
            pass
        try:
            atv.audio.listener = dev
        except Exception:
            pass
        if dev.available(FeatureName.PushUpdates):
            try:
                atv.push_updater.listener = dev
                atv.push_updater.start()
            except Exception as err:
                log.debug("push updates unavailable for %s: %s", key, err)
        info = describe(conf)
        return {"identifier": conf.identifier, "ip": info["ip"], "name": info["name"],
                "model": info["model"], "state": dev.snapshot()}

    async def op_disconnect(self, req):
        dev = self.devices.pop(req["key"], None)
        if dev:
            dev.closed = True
            try:
                dev.atv.push_updater.stop()
            except Exception:
                pass
            for task in dev.atv.close():
                try:
                    await asyncio.wait_for(task, 3)
                except Exception:
                    pass
        return {}

    def device(self, req):
        dev = self.devices.get(req["key"])
        if not dev:
            raise BridgeError("offline", "Not connected to that Apple TV")
        return dev

    async def op_state(self, req):
        return self.device(req).snapshot()

    async def op_remote(self, req):
        dev = self.device(req)
        method = req["method"]
        if method not in REMOTE:
            raise BridgeError("unsupported", f"Unknown button {method}")
        fn = getattr(dev.atv.remote_control, method)
        if REMOTE[method]:
            action = InputAction.Hold if req.get("hold") else InputAction.SingleTap
            await fn(action=action)
        else:
            await fn()
        return {}

    async def op_power(self, req):
        dev = self.device(req)
        if req.get("on"):
            await dev.atv.power.turn_on()
        else:
            await dev.atv.power.turn_off()
        return {}

    async def op_apps(self, req):
        dev = self.device(req)
        apps = await dev.atv.apps.app_list()
        return sorted(({"id": a.identifier, "title": a.name or a.identifier} for a in apps),
                      key=lambda a: a["title"].lower())

    async def op_launch(self, req):
        dev = self.device(req)
        await dev.atv.apps.launch_app(req["app"])
        return {}

    # Typing into whatever text field has focus (search boxes). Companion only
    # accepts text while tvOS shows its keyboard.
    async def op_text(self, req):
        dev = self.device(req)
        kb = dev.atv.keyboard
        if req.get("backspace"):
            current = await kb.text_get() or ""
            await kb.text_set(current[: max(0, len(current) - int(req["backspace"]))])
        if req.get("text"):
            await kb.text_append(str(req["text"]))
        return {}

    async def op_set_volume(self, req):
        dev = self.device(req)
        await dev.atv.audio.set_volume(float(req["level"]))
        return {}

    # ── plumbing ─────────────────────────────────────────
    async def handle(self, req):
        rid = req.get("id")
        op = getattr(self, f"op_{req.get('op')}", None)
        try:
            if not op:
                raise BridgeError("unsupported", f"Unknown op {req.get('op')}")
            result = await asyncio.wait_for(op(req), req.get("timeout", 30))
            emit({"id": rid, "ok": True, "result": result})
        except BridgeError as err:
            emit({"id": rid, "ok": False, "code": err.code, "error": str(err)})
        except exceptions.NotSupportedError as err:
            emit({"id": rid, "ok": False, "code": "unsupported", "error": str(err) or "Not supported"})
        except exceptions.AuthenticationError as err:
            emit({"id": rid, "ok": False, "code": "auth", "error": f"The Apple TV refused Hearth ({err}). Pair it again."})
        except (asyncio.TimeoutError, OSError, exceptions.ConnectionFailedError, exceptions.ConnectionLostError) as err:
            emit({"id": rid, "ok": False, "code": "offline", "error": str(err) or "The Apple TV didn’t answer"})
        except Exception as err:  # noqa: BLE001 - every failure must reach Node
            log.exception("op %s failed", req.get("op"))
            emit({"id": rid, "ok": False, "code": "error", "error": f"{type(err).__name__}: {err}"})


def version():
    try:
        from importlib.metadata import version as v
        return v("pyatv")
    except Exception:
        return "unknown"


async def main():
    loop = asyncio.get_running_loop()
    bridge = Bridge(loop)
    reader = asyncio.StreamReader(limit=1 << 20)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    emit({"event": "ready", "pyatv": version()})
    tasks = set()
    while True:
        line = await reader.readline()
        if not line:
            break  # Node went away: exit with it
        try:
            req = json.loads(line)
        except ValueError:
            continue
        task = asyncio.create_task(bridge.handle(req))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    for key in list(bridge.devices):
        await bridge.op_disconnect({"key": key})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

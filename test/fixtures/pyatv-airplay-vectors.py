"""Known-answer vectors for src/atv/{mrp,bplist,airplay,http}.js, made by pyatv itself.

~/.hearth/py/bin/python -I test/fixtures/pyatv-airplay-vectors.py > test/fixtures/pyatv-airplay-vectors.json
(pyatv 0.18.0, PYATV_VERSION in src/atv-bridge.js). test/appletv-js.test.js asserts Hearth's bytes equal these.
"""
import json, plistlib
from pyatv.protocols.mrp import messages, protobuf as pb
from pyatv.settings import InfoSettings
from pyatv.auth.hap_session import HAPSession
from pyatv.protocols.airplay.channels import BaseDataStreamChannel, DataStreamMessage
from pyatv.protocols.airplay.utils import encode_plist_body
out = {}
def fix(m, uid='11111111-2222-3333-4444-555555555555', ident=None):
    m.uniqueIdentifier = uid
    if ident: m.identifier = ident
    return m.SerializeToString().hex()
info = InfoSettings(name='Hearth')
out['deviceInfo'] = fix(messages.device_information(info, 'AAAA-BBBB'), ident='ID-1')
out['setConnectionState'] = fix(messages.set_connection_state())
out['clientUpdatesConfig'] = fix(messages.client_updates_config(), ident='ID-2')
out['getKeyboardSession'] = fix(messages.get_keyboard_session(), ident='ID-3')
out['sendCommandToggle'] = fix(messages.command(pb.CommandInfo_pb2.TogglePlayPause), ident='ID-4')
# a SET_STATE as an Apple TV would send it
m = messages.create(pb.SET_STATE_MESSAGE)
s = pb.extract_inner(m)
s.playbackState = pb.PlaybackState.Playing
s.playerPath.client.bundleIdentifier = 'com.example.tv'
s.playerPath.client.displayName = 'Example TV'
s.playerPath.player.identifier = 'MediaRemote-DefaultPlayer'
s.playbackQueue.location = 0
item = s.playbackQueue.contentItems.add()
item.identifier = 'item-1'
item.metadata.title = 'The Long Night In'
item.metadata.seriesName = 'Porch Lights'
item.metadata.seasonNumber = 2
item.metadata.episodeNumber = 5
item.metadata.duration = 2640.5
item.metadata.elapsedTime = 61.25
item.metadata.playbackRate = 1.0
item.metadata.elapsedTimeTimestamp = 800000000.0
s.playbackStateTimestamp = 800000000.0
out['setState'] = fix(m)
m = messages.create(pb.SET_NOW_PLAYING_CLIENT_MESSAGE)
c = pb.extract_inner(m).client
c.bundleIdentifier = 'com.example.tv'; c.displayName = 'Example TV'; c.processIdentifier = 412
out['setNowPlayingClient'] = fix(m)
# plists
event = {"isRemoteControlOnly": True, "osName": "iPhone OS", "sourceVersion": "550.10", "timingProtocol": "None", "model": "iPhone10,6", "deviceID": "FF:70:79:61:74:76", "osVersion": "14.7.1", "osBuildVersion": "18G82", "macAddress": "02:70:79:61:74:76", "sessionUUID": "AAAAAAAA-0000-4000-8000-000000000001", "name": "Hearth"}
out['eventSetup'] = plistlib.dumps(event, fmt=plistlib.FMT_BINARY).hex()
data = {"streams": [{"controlType": 2, "channelID": "C0000000-0000-4000-8000-000000000002", "seed": 12345678901234567890, "clientUUID": "C0000000-0000-4000-8000-000000000003", "type": 130, "wantsDedicatedSocket": True, "clientTypeUUID": "1910A70F-DBC0-4242-AF95-115DB30604E1"}]}
out['dataSetup'] = plistlib.dumps(data, fmt=plistlib.FMT_BINARY).hex()
small = dict(data); small = {"streams": [dict(data["streams"][0], seed=4611686018427387904)]}
out['dataSetupSmallSeed'] = plistlib.dumps(small, fmt=plistlib.FMT_BINARY).hex()
mixed = {"a": [1, True, 1.0, 1.5, -3, 300, 70000, 2**40, b"\x00\x01", "x", "é", None if False else "x"], "z": {"k": "x"}}
out['mixed'] = plistlib.dumps(mixed, fmt=plistlib.FMT_BINARY).hex()
big = {"list": ["s%d" % i for i in range(300)]}
out['big'] = plistlib.dumps(big, fmt=plistlib.FMT_BINARY).hex()
# data stream frame with one protobuf
msg = messages.set_connection_state(); msg.uniqueIdentifier = '11111111-2222-3333-4444-555555555555'
payload = encode_plist_body({"params": {"data": BaseDataStreamChannel.encode_protobufs([msg])}})
out['dataFrame'] = BaseDataStreamChannel.encode_message(DataStreamMessage(b"sync" + 8*b"\x00", b"comm", 0x123456789, 0, payload)).hex()
class Dummy(BaseDataStreamChannel):
    def handle_received(self): pass
out['replyFrame'] = Dummy.encode_reply(Dummy.__new__(Dummy), 0x123456789).hex()
# HAP framing
sess = HAPSession(); sess.enable(bytes(range(32)), bytes(range(32, 64)))
plain = bytes((i * 7) & 0xff for i in range(1500))
out['hapPlain'] = plain.hex()
out['hapSealed'] = sess.encrypt(plain).hex() + sess.encrypt(b"second").hex()
print(json.dumps(out, indent=1))

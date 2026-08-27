#!/usr/bin/env python3
"""A minimal, spec-compliant MPRIS player, so the Linux path can be proven.

`playerctl` is a real binary speaking a real protocol. With nothing on the other
end of the bus it exits early with "No players found" -- which means a test run
without a player can only ever prove that nothing is playing. It cannot prove
the format template is valid, because playerctl never gets far enough to read
it. That is the gap this closes.

This publishes org.mpris.MediaPlayer2.upnextfixture on the session bus, so CI
exercises the whole chain end to end: our format template -> playerctl -> D-Bus
-> a player that answers -> our parser.

Deliberately *not* a mock of playerctl. Mocking the thing under test would prove
only that the mock agrees with our guess about it, which is precisely the
failure this exists to rule out.

Run under `dbus-run-session` so there is a session bus to publish on.
"""

import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

BUS_NAME = "org.mpris.MediaPlayer2.upnextfixture"
PATH = "/org/mpris/MediaPlayer2"
ROOT = "org.mpris.MediaPlayer2"
PLAYER = "org.mpris.MediaPlayer2.Player"
PROPS = "org.freedesktop.DBus.Properties"

# A colon and a pipe on purpose. Both are delimiters somebody would reasonably
# reach for, and a colon in a title is the bug that already shipped once -- it
# made "Nights: The Remix" parse as a URI with the scheme "nights".
TITLE = "Nights: The Remix | Live"
ARTIST = "Frank Ocean"
ALBUM = "Blonde"
LENGTH_US = 307_000_000  # microseconds, per the spec
POSITION_US = 12_500_000


class Fixture(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, PATH)
        self.status = "Playing"

    # -- properties ---------------------------------------------------------

    def _player_props(self):
        return {
            "PlaybackStatus": self.status,
            "LoopStatus": "None",
            "Rate": dbus.Double(1.0),
            "MinimumRate": dbus.Double(1.0),
            "MaximumRate": dbus.Double(1.0),
            "Shuffle": False,
            "Volume": dbus.Double(1.0),
            "Position": dbus.Int64(POSITION_US),
            "CanGoNext": True,
            "CanGoPrevious": True,
            "CanPlay": True,
            "CanPause": True,
            "CanSeek": False,
            "CanControl": True,
            "Metadata": dbus.Dictionary(
                {
                    "mpris:trackid": dbus.ObjectPath("/org/upnext/fixture/track/1"),
                    "mpris:length": dbus.Int64(LENGTH_US),
                    "xesam:title": TITLE,
                    # An array, as the spec says -- not a bare string. Players
                    # that get this wrong are why the parser trims.
                    "xesam:artist": dbus.Array([ARTIST], signature="s"),
                    "xesam:album": ALBUM,
                },
                signature="sv",
            ),
        }

    def _root_props(self):
        return {
            "CanQuit": False,
            "CanRaise": False,
            "HasTrackList": False,
            "Identity": "upnext fixture",
            "SupportedUriSchemes": dbus.Array([], signature="s"),
            "SupportedMimeTypes": dbus.Array([], signature="s"),
        }

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, interface, prop):
        return self.GetAll(interface)[prop]

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        if interface == PLAYER:
            return self._player_props()
        if interface == ROOT:
            return self._root_props()
        return {}

    @dbus.service.method(PROPS, in_signature="ssv")
    def Set(self, interface, prop, value):
        pass

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass

    # -- transport ----------------------------------------------------------
    #
    # Enough of one to prove `sendMpris` reaches a player and changes something
    # a later read can observe.

    def _set(self, status):
        self.status = status
        self.PropertiesChanged(PLAYER, {"PlaybackStatus": status}, [])

    @dbus.service.method(PLAYER)
    def Play(self):
        self._set("Playing")

    @dbus.service.method(PLAYER)
    def Pause(self):
        self._set("Paused")

    @dbus.service.method(PLAYER)
    def PlayPause(self):
        self._set("Paused" if self.status == "Playing" else "Playing")

    @dbus.service.method(PLAYER)
    def Stop(self):
        self._set("Stopped")

    @dbus.service.method(PLAYER)
    def Next(self):
        pass

    @dbus.service.method(PLAYER)
    def Previous(self):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    name = dbus.service.BusName(BUS_NAME, bus, do_not_queue=True)
    Fixture(bus)

    # The harness waits for this line rather than sleeping a guessed interval.
    print("ready", flush=True)
    try:
        GLib.MainLoop().run()
    except KeyboardInterrupt:
        pass
    del name


if __name__ == "__main__":
    sys.exit(main())

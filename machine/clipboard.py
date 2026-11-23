"""Own only the clipboard of the private Xvfb display. GTK handles X11 selection
negotiation and incremental transfers. Report reads of pixels, not TARGETS probes."""

import json
import os
import sys
import threading

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

owner = Gtk.Invisible.new()
owner.realize()
selection = Gdk.SELECTION_CLIPBOARD
png = Gdk.Atom.intern('image/png', False)
current = None


def report(**fields):
    print(json.dumps(fields), flush=True)


def clear(key):
    global current
    if current and current[0] == key:
        current = None
        Gtk.selection_owner_set(None, selection, Gdk.CURRENT_TIME)
        Gtk.selection_clear_targets(owner, selection)


def offer(key, mime, data):
    global current
    if not data:
        clear(key)
        return False
    try:
        loader = GdkPixbuf.PixbufLoader.new()
        oversized = []

        def dimensions(loader, width, height):
            if width * height > 32 * 1024 * 1024:
                oversized.append(True)
                loader.set_size(1, 1)

        loader.connect('size-prepared', dimensions)
        loader.write(data)
        loader.close()
        if oversized:
            raise ValueError('Image exceeds 32 megapixels.')
        pixels = loader.get_pixbuf()
        if not pixels:
            raise ValueError('Could not decode the image.')
        Gtk.selection_clear_targets(owner, selection)
        Gtk.selection_add_target(owner, selection, png, 0)
        if mime != 'image/png':
            Gtk.selection_add_target(owner, selection, Gdk.Atom.intern(mime, False), 1)
        if not Gtk.selection_owner_set(owner, selection, Gdk.CURRENT_TIME):
            raise ValueError('Could not own the session clipboard.')
        current = [key, mime, data, pixels, False]
        GLib.timeout_add_seconds(30, clear, key)
        report(id=key, state='offered')
    except Exception:
        report(id=key, state='error', message='Could not decode or offer this clipboard image.')
    return False


def requested(widget, target, info, timestamp):
    if not current:
        return
    key, mime, data, pixels, consumed = current
    if info == 1 or mime == 'image/png':
        target.set(target.get_target(), 8, data)
    elif not target.set_pixbuf(pixels):
        return
    if not consumed:
        current[4] = True
        report(id=key, state='read')


def commands():
    stream = sys.stdin.buffer
    try:
        while header := stream.readline(180):
            key, mime, count = header.decode('ascii').split()
            size = int(count)
            if not 0 <= size <= 129 * 1024 * 1024:
                break
            data = stream.read(size)
            if len(data) != size:
                break
            GLib.idle_add(offer, key, mime, data)
    finally:
        GLib.idle_add(Gtk.main_quit)


owner.connect('selection-get', requested)
report(display=os.environ['DISPLAY'], authority=os.environ['XAUTHORITY'])
threading.Thread(target=commands, daemon=True).start()
Gtk.main()

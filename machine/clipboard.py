"""Bridge the private Xvfb clipboard in both directions. GTK handles X11
selection negotiation and incremental transfers: offer pasted images to the
agent, and forward text copied to CLIPBOARD by the agent back to Outpost."""

import base64
import json
import os
import sys
import threading

import gi

gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gdk, GdkPixbuf, GLib, Gtk  # noqa: E402

MAX_COPY_BYTES = 1024 * 1024

owner = Gtk.Invisible.new()
owner.realize()
selection = Gdk.SELECTION_CLIPBOARD
clipboard = Gtk.Clipboard.get(selection)
png = Gdk.Atom.intern('image/png', False)
current = None
copy_generation = 0


def report(**fields):
    print(json.dumps(fields), flush=True)


def clear(key):
    global current, copy_generation
    if current and current[0] == key:
        current = None
        copy_generation += 1
        Gtk.selection_owner_set(None, selection, Gdk.CURRENT_TIME)
        Gtk.selection_clear_targets(owner, selection)
    return False


def cleared(_widget, _event):
    global current
    current = None
    return False


def offer(key, mime, data):
    global current, copy_generation
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
        copy_generation += 1
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


def owner_changed(cb, event):
    global copy_generation
    if event.reason != Gdk.OwnerChange.NEW_OWNER:
        return
    if event.owner is not None and event.owner == owner.get_window():
        return
    copy_generation += 1
    generation = copy_generation

    def on_text(_clipboard, text):
        if generation != copy_generation or not text:
            return
        raw = text.encode('utf-8', 'surrogatepass')
        if not raw or len(raw) > MAX_COPY_BYTES:
            return
        try:
            raw.decode('utf-8')
        except UnicodeDecodeError:
            return
        report(state='copied', data=base64.b64encode(raw).decode('ascii'))

    cb.request_text(on_text)


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
owner.connect('selection-clear-event', cleared)
clipboard.connect('owner-change', owner_changed)
report(display=os.environ['DISPLAY'], authority=os.environ['XAUTHORITY'])
threading.Thread(target=commands, daemon=True).start()
Gtk.main()

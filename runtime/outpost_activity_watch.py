"""Wake each connected observer when target-owned activity metadata changes.

Watch the directory because writers replace files atomically. Notifications are
only hints to reread durable state; periodic reconciliation covers lost events,
unsupported filesystems and exhausted kernel watch limits.
"""

import ctypes
import os
import struct

EVENT = struct.Struct('iIII')
IN_CLOSE_WRITE = 0x00000008
IN_MOVED_TO = 0x00000080
IN_DELETE = 0x00000200
IN_DELETE_SELF = 0x00000400
IN_MOVE_SELF = 0x00000800
IN_Q_OVERFLOW = 0x00004000
IN_IGNORED = 0x00008000


class ActivityWatch:
    def __init__(self, path):
        self.descriptor = None
        self.names = {os.fsencode(path.stem + suffix) for suffix in ('.json', '.events.json', '.seen.json')}
        try:
            libc = ctypes.CDLL(None, use_errno=True)
            initialize = libc.inotify_init1
            initialize.argtypes, initialize.restype = [ctypes.c_int], ctypes.c_int
            add = libc.inotify_add_watch
            add.argtypes, add.restype = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32], ctypes.c_int
            descriptor = initialize(os.O_NONBLOCK | os.O_CLOEXEC)
            if descriptor < 0:
                return
            self.descriptor = descriptor
            mask = IN_CLOSE_WRITE | IN_MOVED_TO | IN_DELETE | IN_DELETE_SELF | IN_MOVE_SELF
            if add(descriptor, os.fsencode(path.parent), mask) < 0:
                self.close()
        except (AttributeError, OSError):
            self.close()

    def changed(self):
        if self.descriptor is None:
            return False
        try:
            # One bounded, nonblocking drain per relay tick. Other sessions and
            # derived cache/lock writes must not trigger a feedback loop.
            data = os.read(self.descriptor, 65536)
        except BlockingIOError:
            return False
        except OSError:
            self.close()
            return True
        changed, offset = False, 0
        while offset + EVENT.size <= len(data):
            _, mask, _, size = EVENT.unpack_from(data, offset)
            offset += EVENT.size
            name = data[offset : offset + size].split(b'\0', 1)[0]
            offset += size
            if mask & (IN_IGNORED | IN_DELETE_SELF | IN_MOVE_SELF):
                self.close()
                return True
            changed |= bool(mask & IN_Q_OVERFLOW) or name in self.names
        return changed

    def close(self):
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None

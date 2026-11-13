"""Owner-only file replacement for target state and installed helpers."""

import os
import tempfile


def replace_file(path, data, mode=0o600):
    """Write `data` (str or bytes) to `path` in one rename, so readers see the old
    or the new file and never a partial one. A failure leaves no temporary file."""
    descriptor, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(data.encode() if isinstance(data, str) else data)
            os.fchmod(stream.fileno(), mode)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

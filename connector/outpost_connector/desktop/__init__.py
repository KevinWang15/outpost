"""One OS URL handler, shared by every connector launcher."""

from . import macos, windows

HANDLERS = {'macos': macos, 'wsl': windows}

"""Launch the shared web terminal in a browser app window. No terminal proxy here."""

from .. import link
from ..desktop import HANDLERS
from ..platforms import detect

ID = 'terminal-app'
NAME = 'Terminal app'
PLATFORMS = ('macos', 'wsl')
PATH = '/terminal/app'


def install(context):
    return ['Terminal app: uses Google Chrome or Microsoft Edge']


def uninstall(context):
    pass  # No browser profiles or browser installations are owned by Outpost.


def open(url, context):
    target = link.trusted(link.parse(url))
    # Only the short-lived launch token crosses the OS boundary. It is erased
    # by the page before rendering and exchanged by the existing WebSocket.
    HANDLERS[detect().name].open_app(target.server + PATH + '#token=' + target.token, context)

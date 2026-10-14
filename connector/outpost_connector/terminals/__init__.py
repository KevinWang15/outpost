"""Connector launchers, one per entry in shared/terminals.ts.

Each adapter module defines ID, NAME and PLATFORMS, plus:
  install(context) -> list of messages   # optional terminal profile/key mappings
  uninstall(context)
  open(url, context)                     # launch the client; desktop/ owns URL handlers
"""

from . import iterm2, terminal_app, windows_terminal

ADAPTERS = {adapter.ID: adapter for adapter in (terminal_app, iterm2, windows_terminal)}


class Context:
    """Where the connector is installed, and how adapters run commands (replaceable in tests)."""

    def __init__(self, home, launcher, run):
        self.home = home
        self.launcher = launcher
        self.run = run


def for_platform(name):
    return [adapter for adapter in ADAPTERS.values() if name in adapter.PLATFORMS]

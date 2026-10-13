"""Native terminal adapters, one per entry in shared/terminals.ts.

Each adapter module defines ID, NAME and PLATFORM, plus:
  install(context) -> list of messages   # profile, key mappings, outpost:// handler
  uninstall(context)
  open(url, context)                     # open a tab running `outpost-connector attach <url>`
"""
from . import iterm2, windows_terminal

ADAPTERS = {adapter.ID: adapter for adapter in (iterm2, windows_terminal)}


class Context:
    """Where the connector is installed, and how adapters run commands (replaceable in tests)."""
    def __init__(self, home, launcher, run):
        self.home = home
        self.launcher = launcher
        self.run = run


def for_platform(name):
    return [adapter for adapter in ADAPTERS.values() if adapter.PLATFORM == name]

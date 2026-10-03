"""Coding-session adapter contract shared by management and terminal attachment."""
from abc import ABC, abstractmethod
import os
from pathlib import Path
import re
import shlex


def storage_home(environment, key, default, cwd=None):
    home = environment.get('HOME', str(Path.home()))
    path = environment.get(key) or str(Path(home) / default)
    if path.startswith('~/'):
        path = str(Path(home) / path[2:])
    path = Path(path)
    return (path if path.is_absolute() else Path(cwd or os.getcwd()) / path).resolve()


class CodingSessionAdapter(ABC):
    """Own native identity, creation, discovery, text decoding, and exact-ID attachment for one CLI."""
    tool = ''
    id_pattern = r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}'
    storage_key = ''
    storage_directory = ''
    selection_options = ()

    def valid_id(self, value):
        return isinstance(value, str) and bool(re.fullmatch(self.id_pattern, value))

    def valid_storage(self, storage):
        if not isinstance(storage, dict) or set(storage) != {self.storage_key}:
            return False
        value = storage[self.storage_key]
        return isinstance(value, str) and 0 < len(value) <= 4096 and os.path.isabs(value) \
            and all(ord(c) >= 32 and ord(c) != 127 for c in value)

    def home(self, environment, cwd=None):
        return storage_home(environment, self.storage_key, self.storage_directory, cwd)

    def storage(self, home):
        return {self.storage_key: str(home)}

    def selects_session(self, arguments):
        for argument in arguments:
            if argument == '--':
                break
            if any(argument == option or argument.startswith(option + '=')
                   or (len(option) == 2 and argument.startswith(option))
                   for option in self.selection_options):
                return True
        return False

    def argument_guard(self):
        """Check expanded Bash arguments before launching the pinned conversation."""
        patterns = '|'.join(shlex.quote(option) + ('*' if len(option) == 2 else '|' + shlex.quote(option + '=') + '*')
                            for option in self.selection_options)
        return ('for argument in "$@"; do\n'
                '  case "$argument" in\n'
                '    --) break ;;\n'
                '    ' + patterns + ') printf "%s\\n" '
                + shlex.quote('The manager controls the coding CLI session ID. Remove session-selection arguments and use the session finder.')
                + ' >&2; exit 64 ;;\n'
                '  esac\n'
                'done')

    @property
    @abstractmethod
    def sessions(self):
        """Native session store; loaded only for management operations."""

    def discover(self, environment, scan, cwd=None):
        return self.sessions.discover(environment, scan, cwd)

    def text(self, record):
        return self.sessions.text(record)

    def create(self, root, environment, executable):
        return self.sessions.create(root, environment, executable)

    def find(self, session_id, environment, cwd=None):
        return self.sessions.find(session_id, environment, cwd)

    @abstractmethod
    def activity_files(self, session):
        """Native main-agent event logs for this exact conversation and store."""

    def activity_event(self, record):
        """Return (working/idle/finished, native timestamp), or None for non-turn events."""
        return self.sessions.activity_event(record)

    def activity_marker(self, records):
        """Select a native turn event and its byte offset from bounded reverse records."""
        return self.sessions.activity_marker(records)

    @abstractmethod
    def arguments(self, session):
        """Literal arguments which attach to the exact native conversation."""


def adapters():
    from outpost_codex_adapter import CodexAdapter
    from outpost_claude_adapter import ClaudeAdapter
    from outpost_kimi_adapter import KimiAdapter
    return {adapter.tool: adapter for adapter in (CodexAdapter(), ClaudeAdapter(), KimiAdapter())}

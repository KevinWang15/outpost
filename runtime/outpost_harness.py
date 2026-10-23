"""Coding harness adapter contract, shared by management and terminal attachment.

Add a harness: an adapter module (identity, launch arguments, MCP, activity),
a store module (discovery, search text, allocation, turn markers), an entry in
adapters() below, and an entry in shared/harnesses.ts.
"""

import os
import re
import shlex
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import NamedTuple, Optional, Union


class LiveStatusUnavailable(ValueError):
    """The native status service does not own this CLI's conversation."""


def storage_home(environment, key, default, cwd=None):
    home = environment.get('HOME', str(Path.home()))
    path = environment.get(key) or str(Path(home) / default)
    if path.startswith('~/'):
        path = str(Path(home) / path[2:])
    path = Path(path)
    return (path if path.is_absolute() else Path(cwd or os.getcwd()) / path).resolve()


@dataclass(frozen=True)
class LiveActivity:
    """Native API state when lifecycle hooks are unavailable, independent of seen completions."""

    state: str
    path: Optional[Path] = None
    detail: Optional[str] = None


class NativeActivity(NamedTuple):
    """A main-agent lifecycle record; contains no prompt or tool content."""

    state: str
    timestamp: Optional[Union[str, int, float]]
    turn: Optional[str] = None


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
        return (
            isinstance(value, str)
            and 0 < len(value) <= 4096
            and os.path.isabs(value)
            and all(ord(c) >= 32 and ord(c) != 127 for c in value)
        )

    def home(self, environment, cwd=None):
        return storage_home(environment, self.storage_key, self.storage_directory, cwd)

    def storage(self, home):
        return {self.storage_key: str(home)}

    def selects_session(self, arguments):
        for argument in arguments:
            if argument == '--':
                break
            if any(
                argument == option
                or argument.startswith(option + '=')
                or (len(option) == 2 and argument.startswith(option))
                for option in self.selection_options
            ):
                return True
        return False

    def argument_guard(self):
        """Check expanded Bash arguments before launching the pinned conversation."""
        patterns = '|'.join(
            shlex.quote(option) + ('*' if len(option) == 2 else '|' + shlex.quote(option + '=') + '*')
            for option in self.selection_options
        )
        return (
            'for argument in "$@"; do\n'
            '  case "$argument" in\n'
            '    --) break ;;\n'
            '    '
            + patterns
            + ') printf "%s\\n" '
            + shlex.quote(
                'Outpost controls the coding CLI session ID. Remove session-selection arguments and use Find conversations.'
            )
            + ' >&2; exit 64 ;;\n'
            '  esac\n'
            'done'
        )

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
        """Return NativeActivity, or None for non-turn events."""
        return self.sessions.activity_event(record)

    def activity_marker(self, records):
        """Select a native turn event and its byte offset from reverse records."""
        return self.sessions.activity_marker(records)

    def activity_update(self, record, offset, previous, history):
        return self.sessions.activity_update(record, offset, previous, history)

    def live_activity(self, session, running):
        """Return LiveActivity when the harness owns a live status API; otherwise use turn markers."""
        return None

    @abstractmethod
    def prepare_activity(self, directory, session, generation, executable):
        """Return optional activity setup after prepare_launch has succeeded.

        A harness whose shared plugin already provides hooks can return no
        arguments. Failures are recorded without preventing the agent launch.
        """

    @abstractmethod
    def prepare_launch(self, directory, session):
        """Prepare required native integration once and return launch arguments.

        directory is Outpost's state directory; shared helpers are installed.
        Configure MCP and any shared native plugin here. Persisted configuration
        must never contain a managed session's identity or credentials. Returned
        options precede arguments(session) and then user arguments.
        """

    @abstractmethod
    def arguments(self, session):
        """Literal arguments which attach to the exact native conversation."""

    def image_reference(self, path):
        """Text pasted into the CLI for an uploaded image; a plain path by default."""
        return path


def adapters():
    from outpost_claude import ClaudeAdapter
    from outpost_codex import CodexAdapter
    from outpost_kimi import KimiAdapter

    return {adapter.tool: adapter for adapter in (CodexAdapter(), ClaudeAdapter(), KimiAdapter())}

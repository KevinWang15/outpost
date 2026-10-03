"""Coding CLI contracts and bounded, read-only conversation discovery on the target."""
from abc import ABC, abstractmethod
from dataclasses import dataclass
import datetime
import json
import os
import re
import time
from outpost_coding_protocol import adapters


def clean(value, limit=280):
    if not isinstance(value, str):
        return ''
    value = re.sub(r'\s+', ' ', value)
    return ''.join(c for c in value if ord(c) >= 32 and ord(c) != 127).strip()[:limit]


def timestamp(value):
    try:
        if isinstance(value, (float, int)):
            value = datetime.datetime.fromtimestamp(value / 1000 if value > 1e11 else value, datetime.timezone.utc)
        else:
            value = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return value.astimezone(datetime.timezone.utc).isoformat()
    except (ValueError, TypeError, AttributeError, OverflowError, OSError):
        return None


def strings(value, depth=0):
    """Extract textual content, never inline image data or protocol metadata."""
    if depth > 100:
        return  # Corrupt, deeply nested records must not interrupt other sessions.
    if isinstance(value, str):
        if not value.startswith('data:'):
            yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item, depth + 1)
    elif isinstance(value, dict):
        if value.get('type') in ('image', 'image_url', 'input_image', 'base64', 'audio', 'input_audio'):
            return
        for key, item in value.items():
            if key not in {'type', 'role', 'id', 'uuid', 'timestamp', 'time', 'mime_type', 'mimeType',
                           'image_url', 'image', 'source', 'blob', 'blobId', 'signature', 'encrypted_content',
                           'sessionId', 'session_id', 'agentId', 'toolCallId', 'parent_tool_use_id', 'call_id',
                           'cwd', 'workDir', 'createdAt', 'updatedAt'}:
                yield from strings(item, depth + 1)


class SearchLimit(Exception):
    pass


class Scan:
    def __init__(self, seconds=12, byte_limit=256 * 1024 * 1024):
        self.deadline = time.monotonic() + seconds
        self.bytes_left = byte_limit
        self.skipped = 0
        self.files = 0
        self.stores = set()

    def enter_store(self, tool, directory):
        """Scan a canonical store only once per request, even across managed sessions."""
        key = (tool, str(directory))
        if key in self.stores:
            return False
        self.stores.add(key)
        return True

    def check(self):
        if time.monotonic() >= self.deadline or self.bytes_left < 0 or self.files > 20000:
            raise SearchLimit()

    def records(self, path):
        self.check()
        self.files += 1
        try:
            # Ignore symlinks and special files; discovery must not follow files outside a CLI store.
            if path.is_symlink() or not path.is_file():
                return
            with path.open('rb') as stream:
                while True:
                    self.check()
                    line = stream.readline(8 * 1024 * 1024 + 1)
                    if not line:
                        break
                    self.bytes_left -= len(line)
                    self.check()
                    if not line.endswith(b'\n') and len(line) > 8 * 1024 * 1024:
                        self.skipped += 1
                        while line and not line.endswith(b'\n'):
                            self.check()
                            line = stream.readline(64 * 1024)
                            self.bytes_left -= len(line)
                        continue
                    try:
                        record = json.loads(line)
                        if isinstance(record, dict):
                            yield record
                    except (ValueError, UnicodeError, RecursionError):
                        self.skipped += 1  # A running CLI may be in the middle of appending a record.
        except (OSError, UnicodeError):
            self.skipped += 1

    def document(self, path):
        self.check()
        self.files += 1
        try:
            if not path.is_file() or path.is_symlink():
                return {}
            with path.open('rb') as stream:
                raw = stream.read(8 * 1024 * 1024 + 1)
            self.bytes_left -= len(raw)
            self.check()
            if len(raw) > 8 * 1024 * 1024:
                self.skipped += 1
                return {}
            document = json.loads(raw)
            return document if isinstance(document, dict) else {}
        except (OSError, ValueError, UnicodeError, RecursionError):
            self.skipped += 1
            return {}


@dataclass
class CodingSession:
    id: str
    root: str
    title: str
    created: str
    updated: str
    history: list
    storage: dict


class CodingSessionStore(ABC):
    """Native discovery, conversation parsing, and allocation, separate from terminal attachment."""
    def __init__(self, adapter):
        self.adapter = adapter

    @abstractmethod
    def discover(self, environment, scan, cwd=None):
        """Yield native sessions without writing files or invoking a model."""

    @abstractmethod
    def text(self, record):
        """Yield conversation text from a native record, excluding storage metadata."""

    @abstractmethod
    def create(self, root, environment, executable):
        """Allocate an ID which the CLI will use for its conversation."""

    @abstractmethod
    def activity_event(self, record):
        """Decode main-agent turn markers without returning conversation content."""

    def activity_marker(self, records):
        for record, offset in records:
            event = self.activity_event(record)
            if event is not None:
                return event, offset
        return None

    def find(self, session_id, environment, cwd=None):
        if not self.adapter.valid_id(session_id):
            raise ValueError('Invalid coding CLI session ID')
        scan = Scan()
        try:
            for session in self.discover(environment, scan, cwd):
                if session.id == session_id:
                    return session
        except SearchLimit:
            raise ValueError('Session discovery exceeded its limit. Retry with a narrower CLI storage directory.')
        raise ValueError('Coding CLI session was not found on this target. Search again to refresh its metadata.')


def store_paths(directory, pattern, scan, within=None):
    root = (within or directory).resolve()
    for path in directory.glob(pattern):
        scan.check()
        try:
            if path.is_symlink():
                continue
            path.resolve().relative_to(root)
            yield path
        except (OSError, ValueError):
            scan.skipped += 1


def search(query, tool=None, environments=None):
    if not isinstance(query, str) or not query.strip() or len(query) > 256 or any(ord(c) < 32 or ord(c) == 127 for c in query):
        raise ValueError('Enter a search keyword of 1–256 characters.')
    query = query.strip().casefold()
    implementations = adapters()
    if tool is not None and tool not in implementations:
        raise ValueError('Unsupported coding tool')
    selected = [implementations[tool]] if tool else list(implementations.values())
    scopes = [(dict(os.environ), None), *(environments or [])]
    scan = Scan()
    results, warnings, seen = [], [], set()
    truncated = False
    try:
        for adapter in selected:
            for environment, cwd in scopes:
                for session in adapter.discover(environment, scan, cwd):
                    key = (adapter.tool, session.id, tuple(sorted(session.storage.items())))
                    if key in seen:
                        continue
                    seen.add(key)
                    excerpt = None
                    for path in session.history:
                        for record in scan.records(path):
                            for text in adapter.text(record):
                                folded = text.casefold()
                                if query in folded:
                                    # Keep a single bounded excerpt; transcripts never cross the transport.
                                    folded_position = folded.find(query)
                                    position, length = 0, 0
                                    for index, character in enumerate(text):
                                        if length >= folded_position:
                                            position = index
                                            break
                                        length += len(character.casefold())
                                    excerpt = clean(text[max(0, position - 70):position + len(query) + 180])
                                    break
                            if excerpt is not None:
                                break
                        if excerpt is not None:
                            break
                    if excerpt is None and query not in session.title.casefold() and query not in session.id.casefold():
                        continue
                    results.append({'tool': adapter.tool, 'cliSessionId': session.id, 'rootDir': session.root,
                                    'title': clean(session.title, 160), 'createdAt': session.created,
                                    'updatedAt': session.updated, 'excerpt': excerpt,
                                    'cliSessionEnv': session.storage})
                    results.sort(key=lambda item: (item['updatedAt'] or '', item['tool'], item['cliSessionId']), reverse=True)
                    if len(results) > 50:
                        results.pop()
                        truncated = True
    except SearchLimit:
        truncated = True
        warnings.append('Search reached its time, file, or byte limit. Results are partial; choose one coding tool to narrow the search.')
    if scan.skipped:
        warnings.append(f'{scan.skipped} unreadable, incomplete, or oversized records were skipped.')
    return {'sessions': results, 'truncated': truncated, 'warnings': warnings}

"""Bounded native-history reads. Source files are never modified.

The server owns indexing, embeddings, account boundaries and opaque client
cursors. Targets need only Python's standard library and their native stores.
"""

import hashlib
import json
import os
import time
import uuid
from pathlib import Path

from outpost_conversations import Scan, SearchLimit, clean, strings, timestamp
from outpost_harness import adapters

MAX_LINE = 8 * 1024 * 1024
MAX_TEXT = 1024 * 1024


def digest(data):
    return hashlib.sha256(data).hexdigest()


def scopes(sessions):
    yield dict(os.environ), None
    for session in sessions:
        yield dict(os.environ, **{**session['env'], **session['cliSessionEnv']}), session['rootDir']


def roots(sessions):
    found = {}
    for environment, cwd in scopes(sessions):
        for tool, adapter in adapters().items():
            home = adapter.home(environment, cwd)
            found[(tool, str(home))] = adapter, home
    return found


def safe_path(home, path):
    relative = path.relative_to(home)
    current = home
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('History symlinks are not followed')
    path.resolve().relative_to(home.resolve())
    if not path.is_file():
        raise ValueError('History source is no longer available')
    return relative.parts


def describe(adapter, home, path, scan, cache):
    """Metadata parsing belongs to the same native store as conversation search."""
    safe_path(home, path)
    session = adapter.sessions.history_session(path, home, scan, cache)
    stat = path.stat()
    return {
        'id': digest((adapter.tool + '\0' + str(home) + '\0' + str(path)).encode()),
        'tool': adapter.tool,
        'nativeId': session.id,
        'home': str(home),
        'path': str(path),
        'title': clean(session.title, 200),
        'cwd': session.root,
        'size': stat.st_size,
        'modified': str(stat.st_mtime_ns),
        'format': session.history_format,
    }


def managed_name(sessions, source):
    for session in sessions:
        if (
            session['tool'] == source['tool']
            and session['cliSessionId'] == source['nativeId']
            and source['home'] in session['cliSessionEnv'].values()
        ):
            source['nativeTitle'] = source['title']
            source['title'] = session['name']
            source['managedSessionId'] = session['id']
            break
    return source


def catalog(sessions, after=None, limit=100):
    if after is not None and (not isinstance(after, str) or len(after) > 8192):
        raise ValueError('Invalid history catalog cursor')
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 200:
        raise ValueError('Invalid history catalog limit')
    candidates, warnings, cache = [], [], {}
    for (tool, _), (adapter, home) in roots(sessions).items():
        for path in adapter.sessions.history_paths(home):
            key = tool + '\0' + str(home) + '\0' + str(path)
            if after is None or key > after:
                candidates.append((key, adapter, home, path))
    candidates.sort(key=lambda item: item[0])
    scan = Scan(seconds=15, byte_limit=32 * 1024 * 1024)
    sources, last = [], None
    for key, adapter, home, path in candidates[:limit]:
        try:
            sources.append(managed_name(sessions, describe(adapter, home, path, scan, cache)))
        except SearchLimit:
            warnings.append('History metadata scan reached its limit; the next refresh continues this page.')
            break
        except (OSError, ValueError, KeyError, TypeError):
            warnings.append('An unreadable or invalid native history source was skipped.')
        last = key
    return {
        'sources': sources,
        'next': last
        if last is not None and (len(candidates) > limit or len(sources) < len(candidates[:limit]))
        else None,
        'warnings': warnings[:10],
    }


def source_for(value, allowed, scan, cache):
    if not isinstance(value, dict):
        raise ValueError('Invalid history source')
    key = value.get('tool'), value.get('home')
    if key not in allowed or not isinstance(value.get('path'), str):
        raise ValueError('History source is outside the configured CLI stores')
    adapter, home = allowed[key]
    path = Path(value['path'])
    safe_path(home, path)
    return adapter, path, describe(adapter, home, path, scan, cache)


def fingerprint(stream, offset):
    prefix_size, tail_size = min(offset, 4096), min(offset, 256)
    stream.seek(0)
    prefix = digest(stream.read(prefix_size))
    stream.seek(offset - tail_size)
    tail = digest(stream.read(tail_size))
    return prefix, prefix_size, tail, tail_size


def read_batch(sessions, sources):
    if not isinstance(sources, list) or len(sources) > 100:
        raise ValueError('Provide at most 100 history sources')
    allowed, scan, cache = roots(sessions), Scan(seconds=15), {}
    files, warnings, total = [], [], 0
    deadline = time.monotonic() + 12
    for item in sources:
        if total >= 8 * 1024 * 1024 or time.monotonic() >= deadline:
            break
        try:
            adapter, path, source = source_for(item.get('source'), allowed, scan, cache)
            managed_name(sessions, source)
            previous = item.get('checkpoint') or {}
            offset = previous.get('offset', 0)
            if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
                raise ValueError('Invalid history checkpoint')
            with path.open('rb') as stream:
                stat = os.fstat(stream.fileno())
                size = stat.st_size
                source.update(size=size, modified=str(stat.st_mtime_ns))
                reset = not previous or offset > size
                if previous and not reset:
                    prefix, prefix_size, tail, tail_size = fingerprint(stream, offset)
                    reset = prefix != previous.get('prefix') or tail != previous.get('tail')
                    if size == previous.get('size') and source['modified'] != previous.get('modified'):
                        reset = True
                if reset:
                    offset = 0
                generation = uuid.uuid4().hex if reset else previous['generation']
                stream.seek(offset)
                messages = []
                while stream.tell() < size and total < 8 * 1024 * 1024 and time.monotonic() < deadline:
                    position = stream.tell()
                    line = stream.readline(min(MAX_LINE + 1, size - position))
                    if not line.endswith(b'\n'):
                        if len(line) <= MAX_LINE:
                            break  # An incomplete trailing record is retried after append.
                        while line and not line.endswith(b'\n'):
                            line = stream.readline(min(65536, size - stream.tell()))
                        warnings.append('An oversized native history record was skipped.')
                        offset = stream.tell()
                        continue
                    offset = stream.tell()
                    total += len(line)
                    try:
                        record = json.loads(line)
                        if not isinstance(record, dict):
                            continue
                        for message in adapter.sessions.history_messages(record, source.get('format', '')):
                            text = message.get('text')
                            if not isinstance(text, str) or not text.strip():
                                continue
                            if len(text) > MAX_TEXT:
                                warnings.append(
                                    'A very large message was indexed as a prefix; read_message can fetch the remainder while this machine is online.'
                                )
                            messages.append(
                                {
                                    **message,
                                    'position': position,
                                    'text': text[:MAX_TEXT],
                                    'truncated': len(text) > MAX_TEXT,
                                    'totalChars': len(text),
                                    'contentHash': digest(text.encode()),
                                }
                            )
                    except (ValueError, TypeError, KeyError, AttributeError, RecursionError):
                        warnings.append('An invalid native history record was skipped.')
                prefix, prefix_size, tail, tail_size = fingerprint(stream, offset)
                checkpoint = {
                    'offset': offset,
                    'size': size,
                    'modified': source['modified'],
                    'generation': generation,
                    'prefix': prefix,
                    'prefixSize': prefix_size,
                    'tail': tail,
                    'tailSize': tail_size,
                }
                files.append(
                    {
                        'source': source,
                        'checkpoint': checkpoint,
                        'reset': reset,
                        'messages': messages,
                        'pending': offset < size,
                    }
                )
        except SearchLimit:
            warnings.append('History reading reached its metadata limit; refresh again to continue.')
            break
        except (OSError, ValueError, TypeError, KeyError) as error:
            warnings.append(str(error)[:200])
    return {'files': files, 'warnings': list(dict.fromkeys(warnings))[:10]}


def read_message(sessions, request):
    adapter, path, source = source_for(request.get('source'), roots(sessions), Scan(seconds=5), {})
    position, offset, limit = request.get('position'), request.get('offset', 0), request.get('limit', 8000)
    if (
        any(not isinstance(n, int) or isinstance(n, bool) or n < 0 for n in (position, offset, limit))
        or not 1 <= limit <= 20000
    ):
        raise ValueError('Invalid history message page')
    with path.open('rb') as stream:
        stream.seek(position)
        line = stream.readline(MAX_LINE + 1)
    if len(line) > MAX_LINE:
        raise ValueError('This native history record exceeds the read limit')
    record = json.loads(line)
    for entry in adapter.sessions.history_messages(record, source.get('format', '')):
        text = entry.get('text', '')
        if digest(text.encode()) != request.get('contentHash'):
            continue
        end = min(len(text), offset + limit)
        return {'text': text[offset:end], 'totalChars': len(text), 'nextOffset': end if end < len(text) else None}
    raise ValueError('The native message changed. Refresh the history index and search again.')


def message(role, content, created=None, turn=None, kind='message'):
    text = '\n'.join(strings(content))
    return {
        'role': role,
        'text': text,
        'timestamp': timestamp(created),
        'turnId': turn if isinstance(turn, str) else None,
        'kind': kind,
    }

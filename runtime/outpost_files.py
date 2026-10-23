"""Durable, immutable session attachments. No terminal or client lifetime dependencies."""

import datetime
import fcntl
import json
import os
import re
import shutil
import stat
import tempfile
import uuid
from contextlib import contextmanager
from pathlib import Path

MAX_BYTES = 32 * 1024 * 1024
MAX_FILES = 100
MAX_TOTAL_BYTES = 256 * 1024 * 1024
STATE = Path.home() / '.outpost'


def session_directory(session):
    if not isinstance(session, str) or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', session):
        raise ValueError('Invalid Outpost session ID')
    return STATE / 'files' / session


def file_directory(session, identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r'[0-9a-f]{32}', identifier):
        raise ValueError('Invalid session file ID')
    return session_directory(session) / identifier


@contextmanager
def locked(session):
    # A separate lock keeps file I/O out of the session registry and PTY path.
    directory = STATE / 'files'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(directory / (session_directory(session).name + '.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def require_session(session):
    session_directory(session)
    registry = json.loads((STATE / 'registry.json').read_text())
    if not any(item['id'] == session for item in registry['sessions']):
        raise FileNotFoundError('Outpost session no longer exists')


def list_files(session):
    directory = session_directory(session)
    if not directory.exists():
        return []
    result = []
    for child in directory.iterdir():
        if re.fullmatch(r'[0-9a-f]{32}', child.name):
            try:
                result.append(json.loads((child / 'metadata.json').read_text()))
            except FileNotFoundError:
                continue  # A concurrent deletion is already reflected in the next list.
    return sorted(result, key=lambda item: (item['createdAt'], item['id']), reverse=True)


def media_type(prefix):
    # Only passive raster formats are previewed. HTML/SVG and other files download as bytes.
    if prefix.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'image/png'
    if prefix.startswith(b'\xff\xd8\xff'):
        return 'image/jpeg'
    if prefix[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if prefix.startswith(b'RIFF') and prefix[8:12] == b'WEBP':
        return 'image/webp'
    return 'application/octet-stream'


def sync_directory(directory):
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def publish(session, path, name=None):
    require_session(session)
    if not isinstance(path, str) or not path or len(path) > 4096:
        raise ValueError('Provide a file path')
    source = Path(path).expanduser()
    if not source.is_absolute():
        raise ValueError('Use an absolute path for the file to publish')
    name = source.name if name is None else name
    if (
        not isinstance(name, str)
        or not 0 < len(name.encode('utf-8')) <= 240
        or name in ('.', '..')
        or any(ord(c) < 32 or ord(c) == 127 or c in '/\\' for c in name)
    ):
        raise ValueError('Provide a filename without directories or control characters (240 UTF-8 bytes maximum)')
    directory = session_directory(session)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Snapshot first; a source file changed or deleted later cannot change an attachment.
    temporary = Path(tempfile.mkdtemp(prefix='.publishing-', dir=directory))
    try:
        descriptor = os.open(source, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as incoming, open(temporary / 'content', 'xb') as output:
            info = os.fstat(incoming.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('Only regular files can be published')
            if info.st_size > MAX_BYTES:
                raise ValueError('Files must be at most 32 MiB')
            total, prefix = 0, b''
            while True:
                chunk = incoming.read(min(65536, MAX_BYTES + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError('Files must be at most 32 MiB')
                if not prefix:
                    prefix = chunk[:16]
                output.write(chunk)
            after = os.fstat(incoming.fileno())
            if (info.st_size, info.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError('File changed while publishing. Finish writing it and retry.')
            output.flush()
            os.fsync(output.fileno())
        metadata = {
            'id': uuid.uuid4().hex,
            'name': name,
            'size': total,
            'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'mediaType': media_type(prefix),
        }
        with open(temporary / 'metadata.json', 'x') as output:
            json.dump(metadata, output)
            output.flush()
            os.fsync(output.fileno())
        sync_directory(temporary)
        with locked(session):
            require_session(session)
            files = list_files(session)
            if len(files) >= MAX_FILES or sum(item['size'] for item in files) + total > MAX_TOTAL_BYTES:
                raise ValueError(
                    'Session file storage is full (100 files / 256 MiB). Remove files before publishing more.'
                )
            os.rename(temporary, directory / metadata['id'])
            sync_directory(directory)
        return metadata
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def remove(session, identifier):
    with locked(session):
        directory = file_directory(session, identifier)
        if not directory.exists():
            return
        # Readers never see partially deleted entries.
        discarded = directory.with_name('.removed-' + uuid.uuid4().hex)
        os.rename(directory, discarded)
        shutil.rmtree(discarded)
        sync_directory(directory.parent)


def read_file(session, identifier):
    with locked(session):
        directory = file_directory(session, identifier)
        metadata = json.loads((directory / 'metadata.json').read_text())
        stream = open(directory / 'content', 'rb')
        if os.fstat(stream.fileno()).st_size != metadata['size'] or not 0 <= metadata['size'] <= MAX_BYTES:
            stream.close()
            raise ValueError('Stored file is incomplete')
        return metadata, stream


def remove_session(session):
    with locked(session):
        shutil.rmtree(session_directory(session), ignore_errors=True)

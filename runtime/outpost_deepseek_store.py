"""Read-only DeepSeek Harness JSONL generations, including native Zstandard logs."""

import json
import os
import re
import shutil
import subprocess
import tempfile
from contextlib import contextmanager
from types import SimpleNamespace

from outpost_conversations import CodingSession, CodingSessionStore, clean, timestamp
from outpost_harness import NativeActivity
from outpost_rpc import JsonRpcProcess

# dsh already requires Node >=24.9, whose Zstandard decoder avoids an extra
# Python package or platform-specific zstd executable on execution targets.
DECOMPRESS = r"""
const fs=require('node:fs'),zlib=require('node:zlib');
try {
  const fd=fs.openSync(process.argv[1],'r'),limit=256*1024*1024;
  if(fs.fstatSync(fd).size>limit)throw new Error('Compressed history exceeds limit');
  const input=fs.readFileSync(fd);fs.closeSync(fd);
  const head=Number(process.argv[2]);let offset=0,size=0;
  // Node decodes a single frame and can accept a torn input as a prefix.
  // Find each complete frame first, including its optional checksum.
  function frameEnd(start){
    let p=start;
    function take(n){if(p+n>input.length)throw 'torn';const at=p;p+=n;return at}
    if(input.readUInt32LE(take(4))!==0xfd2fb528)throw new Error('Frame magic');
    const flags=input[take(1)],single=Boolean(flags&32),content=flags>>>6,dict=flags&3;
    if(flags&24)throw new Error('Reserved frame flags');
    take((single?0:1)+(dict===3?4:dict)+(content===0?(single?1:0):2**content));
    for(;;){
      const block=input.readUIntLE(take(3),3),kind=(block>>>1)&3;
      if(kind===3)throw new Error('Reserved block kind');
      take(kind===1?1:block>>>3);
      if(block&1)break;
    }
    if(flags&4)take(4);
    return p;
  }
  while(offset<input.length){
    let end;
    try{end=frameEnd(offset)}catch(error){if(error==='torn'&&offset>0){process.stderr.write('incomplete');break}throw error}
    const decoded=zlib.zstdDecompressSync(input.subarray(offset,end),{maxOutputLength:limit-size});
    offset=end;size+=decoded.length;
    let written=0;
    while(written<decoded.length)written+=fs.writeSync(1,decoded,written);
    if(head&&size>=head)break;
  }
}catch(error){process.stderr.write('Invalid or oversized DeepSeek Zstandard history\n');process.exitCode=1}
"""


def decode(path, output, head=0):
    node = shutil.which('node')
    if not node:
        raise ValueError('Reading compressed DeepSeek history requires Node.js 24.9 or newer.')
    try:
        result = subprocess.run(
            [node, '--disable-warning=ExperimentalWarning', '-e', DECOMPRESS, str(path), str(head)],
            stdout=output,
            stderr=subprocess.PIPE,
            timeout=10,
        )
    except subprocess.TimeoutExpired as error:
        raise ValueError('DeepSeek history decompression timed out.') from error
    if result.returncode:
        raise ValueError('Could not decode DeepSeek history. Check Node.js and the native log integrity.')
    return result.stderr == b'incomplete'


class DeepSeekSessionStore(CodingSessionStore):
    @contextmanager
    def history_stream(self, path):
        if path.suffix != '.zstd':
            with super().history_stream(path) as value:
                yield value
            return
        revision = path.stat()
        with tempfile.TemporaryFile() as stream:
            incomplete = decode(path, stream)
            current = path.stat()
            if (revision.st_ino, revision.st_size, revision.st_mtime_ns) != (
                current.st_ino,
                current.st_size,
                current.st_mtime_ns,
            ):
                raise ValueError('DeepSeek history changed during decompression; retry shortly.')
            stream.seek(0)
            yield (
                stream,
                SimpleNamespace(
                    st_size=os.fstat(stream.fileno()).st_size,
                    st_mtime_ns=revision.st_mtime_ns,
                    incomplete=incomplete,
                    source_size=revision.st_size,
                ),
            )

    def history_paths(self, home):
        # Retained migration generations must not duplicate every message.
        for directory in (home / 'sessions').glob('*/*'):
            if not directory.is_dir() or directory.is_symlink():
                continue
            candidates = []
            for path in directory.glob('session*.jsonl*'):
                match = re.fullmatch(r'session(?:\.v([0-9]+))?\.jsonl(?:\.zstd)?', path.name)
                if match:
                    candidates.append((int(match[1] or 0), path.stat().st_mtime_ns, path))
            if candidates:
                yield max(candidates)[2]

    def metadata(self, path, scan):
        scan.check()
        scan.files += 1
        with tempfile.TemporaryFile() as stream:
            if path.suffix == '.zstd':
                decode(path, stream, head=128 * 1024)
                stream.seek(0)
                prefix = stream.read(256 * 1024)
                tail = b''
            else:
                with path.open('rb') as native:
                    prefix = native.read(128 * 1024)
                    native.seek(max(0, path.stat().st_size - 128 * 1024))
                    tail = native.read(128 * 1024)
        scan.bytes_left -= len(prefix) + len(tail)
        scan.check()
        rows = []
        for line in (prefix + b'\n' + tail).splitlines():
            try:
                row = json.loads(line)
                if isinstance(row, dict):
                    rows.append(row)
            except (ValueError, UnicodeError, RecursionError):
                pass
        if not rows or rows[0].get('type') != 'session':
            raise ValueError('Invalid DeepSeek session header')
        header = rows[0]
        version = header.get('version')
        if not self.adapter.valid_id(header.get('id')) or type(version) is not int or version not in range(5):
            raise ValueError('Unsupported DeepSeek session identity or history format')
        title = header['id']
        for row in rows[1:]:
            data = row.get('data')
            if not isinstance(data, dict):
                continue
            if row.get('type') == 'session/title' and isinstance(data.get('title'), str):
                title = data['title']
            elif title == header['id'] and row.get('type') == 'user/message':
                title = next(self.text(row), title)
        return header, clean(title, 160)

    def history_session(self, path, home, scan, cache):
        parts = path.relative_to(home).parts
        if (
            len(parts) != 4
            or parts[0] != 'sessions'
            or not re.fullmatch(r'session(?:\.v[0-9]+)?\.jsonl(?:\.zstd)?', parts[3])
        ):
            raise ValueError('Invalid DeepSeek history path')
        key = ('deepseek', str(path))
        if key not in cache:
            cache[key] = self.metadata(path, scan)
        header, title = cache[key]
        root = header.get('cwd', '')
        if not isinstance(root, str):
            raise ValueError('Invalid DeepSeek working directory')
        return CodingSession(
            header['id'],
            root,
            title,
            timestamp(header.get('createdAt')),
            timestamp(path.stat().st_mtime),
            [path],
            self.adapter.storage(home),
            str(header['version']),
        )

    def history_messages(self, record, history_format=''):
        from outpost_history import message

        kind, data = record.get('type'), record.get('data')
        if not isinstance(data, dict):
            return
        roles = {
            'user/message': 'user',
            'steering/message': 'user',
            'assistant/message': 'assistant',
            'tool/result': 'tool',
        }
        if kind not in roles:
            return
        entry = data.get('message', data)
        if not isinstance(entry, dict):
            return
        # Only canonical committed messages; raw deltas, attempts, request
        # headers, credentials, system prompts and plugin diagnostics are absent.
        yield message(
            roles[kind], entry.get('content', ''), record.get('time'), str(data['turn']) if 'turn' in data else None
        )

    def discover(self, environment, scan, cwd=None):
        home = self.adapter.home(environment, cwd)
        if not scan.enter_store(self.adapter.tool, home):
            return
        for path in self.history_paths(home):
            try:
                from outpost_history import safe_path

                safe_path(home, path)
                cache = {}
                session = self.history_session(path, home, scan, cache)
                # Subagents remain searchable through history MCP, but cannot
                # be resumed through DeepSeek's root-session ACP interface.
                header, _ = cache[('deepseek', str(path))]
                if header.get('origin') != 'subagent':
                    yield session
            except (OSError, ValueError):
                scan.skipped += 1

    def records(self, path, scan):
        scan.files += 1
        with self.history_stream(path) as (stream, _):
            while True:
                scan.check()
                line = stream.readline(8 * 1024 * 1024 + 1)
                if not line:
                    return
                scan.bytes_left -= len(line)
                scan.check()
                if not line.endswith(b'\n') or len(line) > 8 * 1024 * 1024:
                    scan.skipped += 1
                    while line and not line.endswith(b'\n'):
                        line = stream.readline(65536)
                        scan.bytes_left -= len(line)
                        scan.check()
                    continue
                try:
                    record = json.loads(line)
                    if isinstance(record, dict):
                        yield record
                except (ValueError, UnicodeError, RecursionError):
                    scan.skipped += 1

    def text(self, record):
        for entry in self.history_messages(record):
            yield entry['text']

    def create(self, root, environment, executable):
        storage = self.adapter.storage(self.adapter.home(environment, root))
        with JsonRpcProcess([executable, '--profile', 'acp'], {**environment, **storage}, root) as process:
            process.call(
                'initialize',
                {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'outpost', 'version': '1'}},
            )
            result = process.call('session/new', {'cwd': root, 'mcpServers': []})
            identifier = result.get('sessionId')
            if not self.adapter.valid_id(identifier):
                raise ValueError('DeepSeek returned an invalid session ID')
            process.call('session/close', {'sessionId': identifier})
            return identifier, storage

    def activity_event(self, record):
        data = record.get('data') or {}
        if not isinstance(data, dict):
            return None
        kind, created, turn = record.get('type'), record.get('time'), str(data.get('turn', '')) or None
        if kind == 'turn/start':
            return NativeActivity('working', created, turn)
        if kind == 'turn/end':
            reason = data.get('reason', {})
            reason = reason.get('kind') if isinstance(reason, dict) else reason
            return NativeActivity(
                {
                    'completed': 'finished',
                    'error': 'error',
                    'failed': 'error',
                    'cancelled': 'idle',
                    'aborted': 'idle',
                }.get(reason, 'idle'),
                created,
                turn,
            )
        if kind in ('approval/asked', 'approval/decided'):
            return NativeActivity('waiting' if kind == 'approval/asked' else 'working', created, turn)
        return None

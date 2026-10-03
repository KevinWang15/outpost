"""Codex native rollout metadata, textual Responses items, and exact-ID resume."""
import datetime
import json
import os
import uuid
from outpost_coding_rpc import JsonRpcProcess
from outpost_coding_sessions import CodingSession, CodingSessionStore, Scan, SearchLimit, timestamp, strings, clean, store_paths


class CodexSessionStore(CodingSessionStore):
    def discover(self, environment, scan, cwd=None):
        home = self.adapter.home(environment, cwd)
        if not scan.enter_store(self.adapter.tool, home):
            return
        titles = {}
        for record in scan.records(home / 'session_index.jsonl'):
            if self.adapter.valid_id(record.get('id')) and isinstance(record.get('thread_name'), str):
                titles[record['id']] = clean(record['thread_name'], 160)
        for folder in ('sessions', 'archived_sessions'):
            for path in store_paths(home, folder + '/**/rollout-*.jsonl', scan):
                scan.check()
                if path.is_symlink():
                    continue
                first = next(scan.records(path), {})
                meta = first.get('payload', {}) if first.get('type') == 'session_meta' else {}
                if not isinstance(meta, dict) or not self.adapter.valid_id(meta.get('id')):
                    continue
                root = meta.get('cwd', '')
                if not isinstance(root, str):
                    continue
                try:
                    updated = timestamp(path.stat().st_mtime)
                except OSError:
                    scan.skipped += 1
                    continue
                yield CodingSession(meta['id'], root, titles.get(meta['id']) or 'Codex conversation ' + meta['id'][:8], timestamp(meta.get('timestamp')),
                                    updated, [path], self.adapter.storage(home))

    def text(self, record):
        if record.get('type') == 'response_item':
            yield from strings(record.get('payload', {}))
        elif record.get('type') == 'event_msg' and isinstance(record.get('payload'), dict):
            payload = record['payload']
            if payload.get('type') in ('user_message', 'agent_message'):
                yield from strings(payload.get('message', ''))

    def create(self, root, environment, executable):
        # Codex exposes resume by ID but no new-session-ID flag. Its app-server
        # also defers empty-thread persistence until a turn. A metadata-only
        # native rollout reserves the exact ID without inventing a conversation
        # or submitting a model request. Format coupling belongs in this adapter.
        home = self.adapter.home(environment, root)
        native = self.native_metadata(root, environment, executable)
        session_id = native['id']
        now = datetime.datetime.now(datetime.timezone.utc)
        directory = home / 'sessions' / now.strftime('%Y/%m/%d')
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / ('rollout-' + now.strftime('%Y-%m-%dT%H-%M-%S-') + session_id + '.jsonl')
        record = self.template(home, native['model_provider']) or {'type': 'session_meta', 'payload': {}}
        # Rebind the copied record to the new conversation.
        record['timestamp'] = now.isoformat()
        meta = record['payload']
        meta.update(native)
        meta['id'] = meta['session_id'] = session_id
        meta['timestamp'] = now.isoformat()
        meta['cwd'] = root
        meta['originator'] = 'outpost'
        # A new conversation must not inherit another thread's ancestry,
        # instructions, tools, git checkout, or subagent identity.
        for key in ('git', 'forked_from_id', 'forked_from_ordinal_exclusive', 'parent_thread_id',
                    'history_base', 'subagent_history_start_ordinal', 'agent_nickname',
                    'agent_role', 'agent_path', 'thread_source', 'dynamic_tools'):
            meta.pop(key, None)
        meta['base_instructions'] = None
        meta['selected_capability_roots'] = []
        if isinstance(meta.get('runtime_workspace_roots'), list):
            meta['runtime_workspace_roots'] = [root]
        if isinstance(meta.get('context_window'), dict):
            meta['context_window']['window_id'] = str(uuid.uuid4())
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            stream.write(json.dumps(record) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        return session_id, self.adapter.storage(home)

    def template(self, home, provider):
        try:
            return self.read_template(home, provider, Scan(seconds=2, byte_limit=8 * 1024 * 1024))
        except SearchLimit as error:
            raise ValueError('Codex metadata discovery exceeded its limit. Use a narrower CODEX_HOME.') from error

    def read_template(self, home, provider, scan):
        # Resume replays the session_meta, and codex builds reject a minimal one
        # ("Model provider `` not found" when provider and turn fields are
        # absent). Copy the newest real conversation's metadata so the minted
        # rollout has the exact shape the local codex build writes.
        candidates = []
        for candidate in store_paths(home, 'sessions/**/rollout-*.jsonl', scan):
            try:
                scan.files += 1
                scan.check()
                if candidate.is_file():
                    candidates.append((candidate.stat().st_mtime_ns, candidate))
            except OSError:
                continue
        for _, candidate in sorted(candidates, key=lambda item: item[0], reverse=True):
            scan.check()
            try:
                with candidate.open('rb') as stream:
                    line = stream.readline(128 * 1024 + 1)
                scan.bytes_left -= len(line)
                scan.check()
                if not line.endswith(b'\n') or len(line) > 128 * 1024:
                    continue
                record = json.loads(line)
            except (OSError, ValueError, UnicodeError, RecursionError):
                continue
            if not isinstance(record, dict) or record.get('type') != 'session_meta':
                continue
            meta = record.get('payload')
            if isinstance(meta, dict) and meta.get('originator') != 'outpost' \
                    and self.adapter.valid_id(meta.get('id')) and meta.get('source') == 'cli' \
                    and meta.get('model_provider') == provider:
                return record
        return None

    def native_metadata(self, root, environment, executable):
        # Resolve the execution user's current configuration and project
        # settings without submitting a model turn.
        with JsonRpcProcess([executable, 'app-server'], environment, root) as process:
            process.call('initialize', {'clientInfo': {'name': 'outpost', 'version': '0.1.0'}})
            process.send({'method': 'initialized', 'params': {}})
            result = process.call('thread/start', {'cwd': root})
        thread = result.get('thread')
        provider = result.get('modelProvider')
        if not isinstance(thread, dict) or not self.adapter.valid_id(thread.get('id')) \
                or not isinstance(provider, str) or not provider.strip() \
                or not isinstance(thread.get('cliVersion'), str) or not thread['cliVersion']:
            raise ValueError('Codex returned invalid new-thread metadata.')
        return {'id': thread['id'], 'cli_version': thread['cliVersion'],
                'source': 'cli', 'model_provider': provider}

    def activity_event(self, record):
        payload = record.get('payload')
        if record.get('type') != 'event_msg' or not isinstance(payload, dict):
            return None
        kind = payload.get('type')
        if kind == 'task_started':
            return 'working', record.get('timestamp')
        if kind == 'task_complete':
            return ('idle' if payload.get('error') else 'finished'), record.get('timestamp')
        if kind == 'turn_aborted':
            return 'idle', record.get('timestamp')
        return None

"""Current Kimi Code session discovery and ACP allocation."""
from outpost_coding_sessions import CodingSession, CodingSessionStore, timestamp, strings, clean, store_paths
from outpost_coding_rpc import JsonRpcProcess


class KimiSessionStore(CodingSessionStore):
    def discover(self, environment, scan, cwd=None):
        home = self.adapter.home(environment, cwd)
        if not scan.enter_store(self.adapter.tool, home):
            return
        index = {}
        for record in scan.records(home / 'session_index.jsonl'):
            if self.adapter.valid_id(record.get('sessionId')):
                index[record['sessionId']] = record.get('workDir', '')
        for directory in store_paths(home, 'sessions/*/session_*', scan):
            scan.check()
            if not directory.is_dir() or directory.is_symlink() or not self.adapter.valid_id(directory.name):
                continue
            path = directory / 'state.json'
            state = scan.document(path)
            root = index.get(directory.name, '')
            history = list(store_paths(directory / 'agents', '*/wire.jsonl', scan, within=home))
            if not isinstance(root, str):
                continue
            yield CodingSession(directory.name, root, clean(state.get('title') or state.get('lastPrompt')) or directory.name,
                                timestamp(state.get('createdAt')), timestamp(state.get('updatedAt')),
                                history, self.adapter.storage(home))

    def text(self, record):
        if record.get('type') in ('context.append_message', 'turn.prompt', 'turn.steer', 'context.append_loop_event'):
            yield from strings(record)

    def create(self, root, environment, executable):
        storage = self.adapter.storage(self.adapter.home(environment, root))
        with JsonRpcProcess([executable, 'acp'], {**environment, **storage}, root) as process:
            process.call('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                                        'clientInfo': {'name': 'outpost', 'version': '0.1.0'}})
            result = process.call('session/new', {'cwd': root, 'mcpServers': []})
            session_id = result.get('sessionId')
            if not self.adapter.valid_id(session_id):
                raise ValueError('Kimi returned an invalid session ID')
            return session_id, storage

    def activity_event(self, record):
        if record.get('agentId') != 'main':
            return None
        kind = record.get('type')
        if kind in ('turn.prompt', 'turn.steer'):
            return 'working', record.get('time')
        if kind == 'turn.ended':
            return ('finished' if record.get('reason') in ('completed', 'blocked') else 'idle'), record.get('time')
        if kind == 'turn.cancel' and record.get('target') != 'queued':
            return 'idle', record.get('time')
        return None

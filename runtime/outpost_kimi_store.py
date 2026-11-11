"""Current Kimi Code session discovery and ACP allocation."""

from outpost_activity_events import turn_id
from outpost_conversations import CodingSession, CodingSessionStore, clean, store_paths, strings, timestamp
from outpost_harness import NativeActivity
from outpost_rpc import JsonRpcProcess


class KimiSessionStore(CodingSessionStore):
    def history_paths(self, home):
        yield from home.glob('sessions/*/session_*/agents/*/wire.jsonl')

    def history_session(self, path, home, scan, cache):
        parts = path.relative_to(home).parts
        if (
            len(parts) != 6
            or parts[0] != 'sessions'
            or not self.adapter.valid_id(parts[2])
            or parts[3] != 'agents'
            or parts[5] != 'wire.jsonl'
        ):
            raise ValueError('Invalid Kimi history path')
        key = str(home / 'session_index.jsonl')
        if key not in cache:
            cache[key] = {
                record.get('sessionId'): record.get('workDir', '')
                for record in scan.records(home / 'session_index.jsonl')
                if isinstance(record.get('sessionId'), str)
            }
        state = scan.document(home / parts[0] / parts[1] / parts[2] / 'state.json')
        root = cache[key].get(parts[2], '')
        first = next(scan.records(path), {})
        protocol = str(first.get('protocol_version', '')) if first.get('type') == 'metadata' else ''
        return CodingSession(
            parts[2],
            root if isinstance(root, str) else '',
            clean(state.get('title') or state.get('lastPrompt')) or parts[2],
            timestamp(state.get('createdAt')),
            timestamp(state.get('updatedAt')),
            [path],
            self.adapter.storage(home),
            'agent-messages' if protocol == '1.5' else 'context-messages',
        )

    def history_messages(self, record, history_format=''):
        from outpost_history import message

        kind = record.get('type')
        if history_format == 'agent-messages':
            if kind == 'agent.message.appended' and isinstance(record.get('message'), dict):
                outer = record['message']
                entry = outer.get('message')
                if isinstance(entry, dict) and entry.get('role') in ('user', 'assistant', 'tool'):
                    meta = outer.get('meta') or {}
                    if not isinstance(meta, dict):
                        meta = {}
                    yield message(
                        entry['role'],
                        entry.get('content', ''),
                        record.get('time') or meta.get('createdAt'),
                        meta.get('turnId'),
                    )
            return
        if kind == 'context.append_message' and isinstance(record.get('message'), dict):
            entry = record['message']
            role = entry.get('role')
            if role in ('user', 'assistant', 'tool'):
                yield message(role, entry.get('content', ''), record.get('time'), record.get('turnId'))
        elif kind == 'context.append_loop_event' and isinstance(record.get('event'), dict):
            event = record['event']
            if event.get('type') == 'tool.result':
                yield message(
                    'tool',
                    event.get('result', event.get('content', '')),
                    record.get('time'),
                    record.get('turnId'),
                    'tool_result',
                )

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
            yield CodingSession(
                directory.name,
                root,
                clean(state.get('title') or state.get('lastPrompt')) or directory.name,
                timestamp(state.get('createdAt')),
                timestamp(state.get('updatedAt')),
                history,
                self.adapter.storage(home),
            )

    def text(self, record):
        if record.get('type') in ('context.append_message', 'turn.prompt', 'turn.steer', 'context.append_loop_event'):
            yield from strings(record)

    def create(self, root, environment, executable):
        storage = self.adapter.storage(self.adapter.home(environment, root))
        with JsonRpcProcess([executable, 'acp'], {**environment, **storage}, root) as process:
            process.call(
                'initialize',
                {'protocolVersion': 1, 'clientCapabilities': {}, 'clientInfo': {'name': 'outpost', 'version': '0.1.0'}},
            )
            result = process.call('session/new', {'cwd': root, 'mcpServers': []})
            session_id = result.get('sessionId')
            if not self.adapter.valid_id(session_id):
                raise ValueError('Kimi returned an invalid session ID')
            return session_id, storage

    def activity_event(self, record):
        if record.get('agentId') != 'main':
            return None
        kind = record.get('type')
        turn = turn_id(record.get('turnId'))
        if kind in ('turn.prompt', 'turn.steer'):
            return NativeActivity('working', record.get('time'), turn)
        if kind == 'turn.ended':
            return NativeActivity(
                {'completed': 'finished', 'blocked': 'waiting', 'failed': 'error', 'cancelled': 'idle'}.get(
                    record.get('reason'), 'unknown'
                ),
                record.get('time'),
                turn,
            )
        if kind == 'interaction.request':
            return NativeActivity('waiting', record.get('time'), turn)
        if kind == 'interaction.resolved':
            return NativeActivity('working', record.get('time'), turn)
        if kind == 'turn.cancel' and record.get('target') != 'queued':
            return NativeActivity('idle', record.get('time'), turn)
        return None

    def activity_marker(self, records):
        resolved = set()
        for record, offset in records:
            if record.get('agentId') != 'main':
                continue
            if record.get('type') == 'interaction.resolved':
                resolved.add(record.get('id'))
                continue
            if record.get('type') == 'interaction.request' and record.get('id') in resolved:
                continue
            event = self.activity_event(record)
            if event is not None:
                return event, offset
        return None

    def activity_update(self, record, offset, previous, history):
        if record.get('agentId') == 'main' and record.get('type') == 'interaction.resolved':
            # Resolving one approval must not clear another outstanding request.
            return self.activity_marker(history())
        return super().activity_update(record, offset, previous, history)

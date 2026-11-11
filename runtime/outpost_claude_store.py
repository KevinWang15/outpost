"""Claude Code project transcripts and native session-id/resume flags."""

import uuid

from outpost_conversations import CodingSession, CodingSessionStore, clean, store_paths, strings, timestamp
from outpost_harness import NativeActivity


class ClaudeSessionStore(CodingSessionStore):
    def history_paths(self, home):
        yield from home.glob('projects/*/*.jsonl')
        yield from home.glob('projects/*/*/subagents/agent-*.jsonl')

    def history_session(self, path, home, scan, cache):
        parts = path.relative_to(home).parts
        if len(parts) == 3 and parts[0] == 'projects' and self.adapter.valid_id(path.stem):
            native, primary = path.stem, path
        elif (
            len(parts) == 5
            and parts[0] == 'projects'
            and self.adapter.valid_id(parts[2])
            and parts[3] == 'subagents'
            and path.name.startswith('agent-')
            and path.suffix == '.jsonl'
        ):
            native = parts[2]
            primary = home / parts[0] / parts[1] / (native + '.jsonl')
        else:
            raise ValueError('Invalid Claude history path')
        key = str(primary)
        if key not in cache:
            root, title, created = '', '', None
            for index, record in enumerate(scan.records(primary)):
                if isinstance(record.get('cwd'), str):
                    root = record['cwd']
                created = created or timestamp(record.get('timestamp'))
                if record.get('type') == 'custom-title':
                    title = clean(record.get('customTitle'), 200)
                elif not title and record.get('type') == 'user' and isinstance(record.get('message'), dict):
                    title = clean(' '.join(strings(record['message'].get('content', ''))), 200)
                if index >= 255 or (root and title):
                    break
            cache[key] = CodingSession(native, root, title or native, created, None, [path], self.adapter.storage(home))
        return cache[key]

    def history_messages(self, record, history_format=''):
        from outpost_history import message

        role = record.get('type')
        content = record.get('message')
        if role in ('user', 'assistant') and isinstance(content, dict):
            yield message(role, content.get('content', ''), record.get('timestamp'), record.get('turnId'))

    def discover(self, environment, scan, cwd=None):
        home = self.adapter.home(environment, cwd)
        if not scan.enter_store(self.adapter.tool, home):
            return
        for path in store_paths(home, 'projects/*/*.jsonl', scan):
            scan.check()
            if not self.adapter.valid_id(path.stem) or path.is_symlink():
                continue
            root, title, created = '', '', None
            for index, record in enumerate(scan.records(path)):
                if isinstance(record.get('cwd'), str):
                    root = record['cwd']
                created = created or timestamp(record.get('timestamp'))
                if record.get('type') == 'custom-title':
                    title = clean(record.get('customTitle'), 160)
                elif not title and record.get('type') == 'user':
                    message = record.get('message')
                    title = (
                        clean(' '.join(strings(message.get('content', ''))), 160) if isinstance(message, dict) else ''
                    )
                if index >= 255 or (root and title):
                    break
            try:
                updated = timestamp(path.stat().st_mtime)
            except OSError:
                scan.skipped += 1
                continue
            # Subagent conversations belong to this native session, so matches
            # in their transcripts should link back to its resumable identity.
            history = [path, *store_paths(path.with_suffix('') / 'subagents', 'agent-*.jsonl', scan, within=home)]
            yield CodingSession(
                path.stem, root, title or path.stem, created, updated, history, self.adapter.storage(home)
            )

    def text(self, record):
        if record.get('type') in ('user', 'assistant'):
            message = record.get('message')
            if isinstance(message, dict):
                yield from strings(message.get('content', ''))

    def create(self, root, environment, executable):
        home = self.adapter.home(environment, root)
        return str(uuid.uuid4()), self.adapter.storage(home)

    def activity_marker(self, records):
        # Claude can flush an older prompt after its assistant reply. Use native
        # timestamps within the bounded tail, keeping file order for ties.
        selected, newest = None, None
        first = None
        try:
            for record, offset in records:
                first = offset if first is None else first
                if selected is not None and first - offset > 4 * 1024 * 1024:
                    break
                event = self.activity_event(record)
                if event is None:
                    continue
                created = timestamp(event.timestamp)
                if selected is None:
                    selected, newest = (event, offset), created
                    if created is None:
                        return selected
                elif created is not None and created > newest:
                    selected, newest = (event, offset), created
        except ValueError:
            if selected is None:
                raise
        return selected

    def activity_update(self, record, offset, previous, history):
        candidate = super().activity_update(record, offset, previous, history)
        if previous is None or candidate is None:
            return candidate
        before, after = timestamp(previous[0].timestamp), timestamp(candidate[0].timestamp)
        return previous if before and after and after < before else candidate

    def activity_event(self, record):
        if record.get('isSidechain'):
            return None
        kind = record.get('type')
        message = record.get('message')
        if record.get('isApiErrorMessage') or (kind == 'system' and record.get('subtype') == 'api_error'):
            return NativeActivity('error', record.get('timestamp'))
        if not isinstance(message, dict):
            return None
        if kind == 'user':
            # These are native interrupt records, not a new human prompt.
            content = message.get('content')
            if isinstance(content, list) and any(
                isinstance(part, dict)
                and part.get('type') == 'text'
                and part.get('text') in ('[Request interrupted by user]', '[Request interrupted by user for tool use]')
                for part in content
            ):
                return NativeActivity('idle', record.get('timestamp'))
            return NativeActivity('working', record.get('timestamp'))
        if kind == 'assistant':
            reason = message.get('stop_reason')
            return NativeActivity(
                'finished' if reason in ('end_turn', 'stop_sequence', 'max_tokens', 'refusal') else 'working',
                record.get('timestamp'),
            )
        return None

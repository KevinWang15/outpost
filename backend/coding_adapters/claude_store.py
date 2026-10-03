"""Claude Code project transcripts and native session-id/resume flags."""
import uuid
from outpost_coding_sessions import CodingSession, CodingSessionStore, timestamp, strings, clean, store_paths


class ClaudeSessionStore(CodingSessionStore):
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
                    title = clean(' '.join(strings(message.get('content', ''))), 160) if isinstance(message, dict) else ''
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
            yield CodingSession(path.stem, root, title or path.stem, created, updated,
                                history, self.adapter.storage(home))

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
        try:
            for record, offset in records:
                event = self.activity_event(record)
                if event is None:
                    continue
                created = timestamp(event[1])
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

    def activity_event(self, record):
        if record.get('isSidechain'):
            return None
        kind = record.get('type')
        message = record.get('message')
        if record.get('isApiErrorMessage') or (kind == 'system' and record.get('subtype') == 'api_error'):
            return 'idle', record.get('timestamp')
        if not isinstance(message, dict):
            return None
        if kind == 'user':
            # These are native interrupt records, not a new human prompt.
            content = message.get('content')
            if isinstance(content, list) and any(isinstance(part, dict) and part.get('type') == 'text'
                and part.get('text') in ('[Request interrupted by user]', '[Request interrupted by user for tool use]')
                for part in content):
                return 'idle', record.get('timestamp')
            return 'working', record.get('timestamp')
        if kind == 'assistant':
            reason = message.get('stop_reason')
            return ('finished' if reason in ('end_turn', 'stop_sequence', 'max_tokens', 'refusal') else 'working'), record.get('timestamp')
        return None

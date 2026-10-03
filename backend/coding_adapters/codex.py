"""Codex coding-session adapter; history access is loaded only for management operations."""
from functools import cached_property
from outpost_coding_protocol import CodingSessionAdapter


class CodexAdapter(CodingSessionAdapter):
    tool = 'codex'
    storage_key = 'CODEX_HOME'
    storage_directory = '.codex'
    selection_options = ('--last',)

    @cached_property
    def sessions(self):
        from outpost_codex_store import CodexSessionStore
        return CodexSessionStore(self)

    def arguments(self, session):
        return ['resume', session['cliSessionId']]

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        for folder in ('sessions', 'archived_sessions'):
            yield from (home / folder).glob('**/rollout-*-' + session['cliSessionId'] + '.jsonl')

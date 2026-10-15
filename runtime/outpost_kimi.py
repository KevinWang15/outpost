"""Kimi coding-session adapter; its native store is loaded on demand."""

from functools import cached_property

from outpost_harness import CodingSessionAdapter


class KimiAdapter(CodingSessionAdapter):
    tool = 'kimi'
    id_pattern = r'session_[A-Za-z0-9_-]{1,120}'
    storage_key = 'KIMI_CODE_HOME'
    storage_directory = '.kimi-code'
    selection_options = ('--session', '-S', '--continue', '-c')

    @cached_property
    def sessions(self):
        from outpost_kimi_store import KimiSessionStore

        return KimiSessionStore(self)

    def arguments(self, session):
        return ['--session', session['cliSessionId']]

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        yield from (home / 'sessions').glob('*/' + session['cliSessionId'] + '/agents/main/wire.jsonl')

"""Codex coding-session adapter; its native store is loaded on demand."""

from functools import cached_property

from outpost_harness import CodingSessionAdapter


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
        from outpost_codex_state import selected_rollout

        home = self.home(session['cliSessionEnv'], session['rootDir'])
        path = selected_rollout(home, session['cliSessionId'])
        if path is not None:
            yield path

    def live_activity(self, session, running):
        from outpost_codex_state import observe

        home = self.home(session['cliSessionEnv'], session['rootDir'])
        return observe(home, session['cliSessionId'], running)

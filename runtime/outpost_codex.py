"""Codex coding-session adapter; history access is loaded only for management operations."""

from functools import cached_property

from outpost_harness import CodingSessionAdapter


class CodexAdapter(CodingSessionAdapter):
    tool = 'codex'
    storage_key = 'CODEX_HOME'
    storage_directory = '.codex'
    selection_options = ('--last',)
    history_navigation = {
        'label': 'Codex history',
        'help': 'Codex controls this full-screen history. Use the page and jump buttons now. '
        'Exit Codex cleanly and reconnect this session to enable the draggable scrollbar.',
        'keys': {
            'oldest': {'key': 'Home', 'ctrl': True},
            'pageUp': {'key': 'PageUp'},
            'pageDown': {'key': 'PageDown'},
            'latest': {'key': 'End', 'ctrl': True},
        },
    }

    @cached_property
    def sessions(self):
        from outpost_codex_store import CodexSessionStore

        return CodexSessionStore(self)

    def arguments(self, session):
        # Codex's full-screen transcript lives inside the application and is
        # invisible to tmux. Inline mode gives every terminal the same history.
        # A default config override also accepts an existing --no-alt-screen
        # argument, and lets an explicit later -c override choose full screen.
        return ['resume', session['cliSessionId'], '-c', 'tui.alternate_screen="never"']

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        for folder in ('sessions', 'archived_sessions'):
            yield from (home / folder).glob('**/rollout-*-' + session['cliSessionId'] + '.jsonl')

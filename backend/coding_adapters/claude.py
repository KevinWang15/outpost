"""Claude coding-session adapter; history access is loaded only for management operations."""
from functools import cached_property
from outpost_coding_protocol import CodingSessionAdapter


class ClaudeAdapter(CodingSessionAdapter):
    tool = 'claude'
    storage_key = 'CLAUDE_CONFIG_DIR'
    storage_directory = '.claude'
    selection_options = ('--session-id', '--resume', '-r', '--continue', '-c', '--fork-session', '--no-session-persistence')

    @cached_property
    def sessions(self):
        from outpost_claude_store import ClaudeSessionStore
        return ClaudeSessionStore(self)

    def arguments(self, session):
        environment = session['cliSessionEnv']
        home = self.home(environment, session['rootDir'])
        path = next((path for path in (home / 'projects').glob('*/' + session['cliSessionId'] + '.jsonl')
                     if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(home)), None)
        return ['--resume', str(path)] if path else ['--session-id', session['cliSessionId']]

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        yield from (home / 'projects').glob('*/' + session['cliSessionId'] + '.jsonl')

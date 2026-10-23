"""Claude coding-session adapter; its native store is loaded on demand."""

import json
from functools import cached_property

from outpost_activity_install import hook_command
from outpost_harness import CodingSessionAdapter
from outpost_mcp_install import stdio_server


class ClaudeAdapter(CodingSessionAdapter):
    tool = 'claude'
    storage_key = 'CLAUDE_CONFIG_DIR'
    storage_directory = '.claude'
    selection_options = (
        '--session-id',
        '--resume',
        '-r',
        '--continue',
        '-c',
        '--fork-session',
        '--no-session-persistence',
    )

    @cached_property
    def sessions(self):
        from outpost_claude_store import ClaudeSessionStore

        return ClaudeSessionStore(self)

    def arguments(self, session):
        environment = session['cliSessionEnv']
        home = self.home(environment, session['rootDir'])
        path = next(
            (
                path
                for path in (home / 'projects').glob('*/' + session['cliSessionId'] + '.jsonl')
                if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(home)
            ),
            None,
        )
        return ['--resume', str(path)] if path else ['--session-id', session['cliSessionId']]

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        yield from (home / 'projects').glob('*/' + session['cliSessionId'] + '.jsonl')

    def prepare_launch(self, directory, session):
        # The launch contract places arguments(session) after these options,
        # ending variadic --mcp-config before any user-supplied prompt.
        server = {
            'type': 'stdio',
            **stdio_server(directory / 'bin' / 'outpost-mcp'),
            'env': {'OUTPOST_SESSION_ID': session['id'], 'OUTPOST_STATE_DIRECTORY': str(directory)},
        }
        return ['--mcp-config', json.dumps({'mcpServers': {'outpost': server}}, separators=(',', ':'))]

    def prepare_activity(self, directory, session, generation, executable):
        command = hook_command(directory, session, generation)
        names = (
            'SessionStart',
            'UserPromptSubmit',
            'PreToolUse',
            'PostToolUse',
            'PermissionRequest',
            'Stop',
            'SessionEnd',
            'StopFailure',
            'PostToolUseFailure',
            'Notification',
            'Elicitation',
            'ElicitationResult',
        )
        settings = {
            'hooks': {name: [{'hooks': [{'type': 'command', 'command': command, 'timeout': 2}]}] for name in names}
        }
        return ['--settings', json.dumps(settings, separators=(',', ':'))]

"""Codex coding-session adapter; its native store is loaded on demand."""

import os
from functools import cached_property

from outpost_activity_install import hook_command
from outpost_config import toml
from outpost_harness import CodingSessionAdapter
from outpost_mcp_install import stdio_server
from outpost_rpc import JsonRpcProcess


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

    def prepare_launch(self, directory, session):
        server = stdio_server(directory / 'bin' / 'outpost-mcp')
        server['env_vars'] = ['OUTPOST_SESSION_ID', 'OUTPOST_STATE_DIRECTORY']
        return ['-c', 'mcp_servers.outpost=' + toml(server)]

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
            'Interrupt',
        )
        options = []
        for name in names:
            options.extend(
                [
                    '-c',
                    'hooks.'
                    + name
                    + '='
                    + toml(
                        [
                            {
                                'hooks': [
                                    {'type': 'command', 'command': command, 'timeout': 2},
                                ]
                            }
                        ]
                    ),
                ]
            )
        environment = {**os.environ, **session['env'], **session['cliSessionEnv']}
        # Ask Codex for its own hook identities and hashes. Trust exactly the
        # observer supplied by this launch, never bypass trust for user hooks.
        with JsonRpcProcess([executable, 'app-server', *options], environment, session['rootDir']) as process:
            process.call(
                'initialize',
                {
                    'clientInfo': {'name': 'outpost_activity', 'version': '1.0.0'},
                    'capabilities': {'experimentalApi': True},
                },
            )
            process.send({'method': 'initialized', 'params': {}})
            result = process.call('hooks/list', {'cwds': [session['rootDir']]})
        selected = []
        for entry in result.get('data', []):
            for hook in entry.get('hooks', []):
                if hook.get('source') == 'sessionFlags' and hook.get('command') == command:
                    key, fingerprint = hook.get('key'), hook.get('currentHash')
                    if (
                        not isinstance(key, str)
                        or not isinstance(fingerprint, str)
                        or not fingerprint.startswith('sha256:')
                    ):
                        raise ValueError('Codex returned invalid hook metadata')
                    selected.append((key, fingerprint))
        if len(selected) != len(names):
            raise ValueError('This Codex version does not expose the required lifecycle hooks')
        # CLI dotted keys are not a TOML key parser; hook IDs contain literal dots.
        options.extend(
            [
                '-c',
                'hooks.state='
                + toml({key: {'enabled': True, 'trusted_hash': fingerprint} for key, fingerprint in selected}),
            ]
        )
        return options

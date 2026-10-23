"""Kimi coding-session adapter; its native store is loaded on demand."""

import datetime
import shlex
import sys
from functools import cached_property

from outpost_activity_events import file_lock, read_json, write_json
from outpost_activity_install import install_helper
from outpost_harness import CodingSessionAdapter
from outpost_mcp_install import stdio_server

PLUGIN_ID = 'outpost-activity'


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

    def prepare_activity(self, directory, session, generation, executable):
        # prepare_launch installs the native plugin's hooks together with MCP.
        return []

    def prepare_launch(self, directory, session):
        """One native plugin owns Kimi's hooks and MCP, with process-local binding.

        Kimi Code has no invocation-only MCP/hook configuration. The shared
        plugin contains no session IDs; each Kimi process supplies its own
        Outpost environment. Outside Outpost, MCP exposes an empty tool list.
        """
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        helper = install_helper(directory / 'bin')
        server = stdio_server(directory / 'bin' / 'outpost-mcp')
        plugin = directory / 'integrations' / 'kimi-activity'
        command = shlex.join([sys.executable, '-I', str(helper), '--identity-only', '--environment', self.tool])
        manifest = {
            'name': PLUGIN_ID,
            'version': '1.1.0',
            'description': 'Session activity and file publishing for Outpost terminals.',
            'interface': {'displayName': 'Outpost'},
            'hooks': [
                {'event': event, 'command': command, 'timeout': 2} for event in ('SessionStart', 'UserPromptSubmit')
            ],
            'mcpServers': {
                'outpost': {
                    # Plugin commands must be PATH names or plugin-relative paths.
                    # env executes the exact Python used by target management.
                    'command': 'env',
                    'args': [server['command'], *server['args'], '--optional-session'],
                }
            },
        }
        registry = home / 'plugins' / 'installed.json'
        with file_lock(home / 'plugins' / '.outpost-activity.lock'):
            data = read_json(registry, limit=1024 * 1024)
            if data is None and not registry.exists():
                data = {'version': 1, 'plugins': []}
            if (
                not isinstance(data, dict)
                or data.get('version') != 1
                or not isinstance(data.get('plugins'), list)
                or any(not isinstance(entry, dict) for entry in data['plugins'])
            ):
                raise ValueError('Invalid Kimi plugin registry')
            entries = list(data['plugins'])
            index = next((index for index, entry in enumerate(entries) if entry.get('id') == PLUGIN_ID), len(entries))
            existing = entries[index] if index < len(entries) else {}
            entry = {
                **existing,
                'id': PLUGIN_ID,
                'root': str(plugin),
                'source': 'local-path',
                'enabled': True,
                'installedAt': existing.get('installedAt') or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
            if index == len(entries):
                entries.append(entry)
            else:
                entries[index] = entry
            # Preserve plugin order/preferences and avoid unnecessary native reloads.
            if read_json(plugin / 'kimi.plugin.json') != manifest:
                write_json(plugin / 'kimi.plugin.json', manifest)
            updated = {**data, 'plugins': entries}
            if updated != data:
                write_json(registry, updated)
        return []

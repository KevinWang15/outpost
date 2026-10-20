"""Install launch-scoped observers using each harness's native hook mechanism."""

import datetime
import json
import os
import shlex
import sys
import tempfile

import outpost_activity_events as events
from outpost_activity_events import file_lock, read_json, write_json
from outpost_rpc import JsonRpcProcess

COMMON_EVENTS = (
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
    'SessionEnd',
)


def install_helper(directory):
    path = directory / 'outpost-activity-hook.py'
    source = events.__loader__.get_source(events.__name__)
    if source is None:
        raise ValueError('Activity hook source is unavailable')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        if path.read_bytes() == source.encode():
            return path
    except FileNotFoundError:
        pass
    descriptor, temporary = tempfile.mkstemp(prefix='.activity-hook-', dir=directory)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(source)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return path


def hook_command(directory, session, generation):
    helper = install_helper(directory.parent / 'bin')
    return shlex.join([sys.executable, '-I', str(helper), str(directory), session['id'], generation])


def claude(directory, session, generation, executable):
    command = hook_command(directory, session, generation)
    names = (
        *COMMON_EVENTS,
        'StopFailure',
        'PostToolUseFailure',
        'Notification',
        'Elicitation',
        'ElicitationResult',
    )
    settings = {'hooks': {name: [{'hooks': [{'type': 'command', 'command': command, 'timeout': 2}]}] for name in names}}
    return ['--settings', json.dumps(settings, separators=(',', ':'))]


def toml(value):
    """Serialize the small JSON-shaped subset used by native CLI overrides."""
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if isinstance(value, list):
        return '[' + ','.join(map(toml, value)) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(toml(k) + '=' + toml(v) for k, v in value.items()) + '}'
    raise ValueError('Unsupported activity hook configuration value')


def codex(directory, session, generation, executable):
    command = hook_command(directory, session, generation)
    names = (*COMMON_EVENTS, 'Interrupt')
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
            {'clientInfo': {'name': 'outpost_activity', 'version': '1.0.0'}, 'capabilities': {'experimentalApi': True}},
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


def kimi(directory, session, generation, executable):
    # Kimi has no invocation-only hook option. Its native local plugin registry
    # provides an additive integration without rewriting config.toml. Only
    # identity events are used: subagent turn hooks lack reliable agent IDs.
    from outpost_kimi import KimiAdapter

    home = KimiAdapter().home(session['cliSessionEnv'], session['rootDir'])
    helper = install_helper(directory.parent / 'bin')
    plugin = directory.parent / 'integrations' / 'kimi-activity'
    command = shlex.join([sys.executable, '-I', str(helper), 'kimi'])
    write_json(
        plugin / 'kimi.plugin.json',
        {
            'name': 'outpost-activity',
            'version': '1.0.0',
            'description': 'Report the selected conversation inside Outpost terminals.',
            'hooks': [
                {'event': event, 'command': command, 'timeout': 2} for event in ('SessionStart', 'UserPromptSubmit')
            ],
        },
    )
    registry = home / 'plugins' / 'installed.json'
    with file_lock(home / 'plugins' / '.outpost-activity.lock'):
        data = read_json(registry, limit=1024 * 1024) or {'version': 1, 'plugins': []}
        if (
            not isinstance(data, dict)
            or data.get('version') != 1
            or not isinstance(data.get('plugins'), list)
            or any(not isinstance(entry, dict) for entry in data['plugins'])
        ):
            raise ValueError('Invalid Kimi plugin registry')
        entries = [entry for entry in data['plugins'] if entry.get('id') != 'outpost-activity']
        existing = next((entry for entry in data['plugins'] if entry.get('id') == 'outpost-activity'), {})
        entries.append(
            {
                'id': 'outpost-activity',
                'root': str(plugin),
                'source': 'local-path',
                'enabled': True,
                'installedAt': existing.get('installedAt') or datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
        )
        write_json(registry, {**data, 'plugins': entries})
    return []

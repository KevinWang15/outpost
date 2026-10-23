"""Outpost's stdio MCP attachment server (MCP 2025-06-18).

The small tools-only server uses Python's standard library, already required on
every target. Session identity is bound once at launch, never a tool parameter.
The same executable also supports `outpost-mcp publish FILE` for any harness.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import outpost_files as files

TOOL = {
    'name': 'publish_file',
    'description': 'Send a generated file or image to the user in this Outpost session. '
    'Publishes a persistent snapshot for preview/download, including while the user is disconnected. '
    'Use an absolute path. The original file is not modified.',
    'inputSchema': {
        'type': 'object',
        'properties': {
            'path': {'type': 'string', 'description': 'Absolute path of the file to publish.'},
            'name': {'type': 'string', 'description': 'Optional display/download filename.'},
        },
        'required': ['path'],
        'additionalProperties': False,
    },
    'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': False, 'openWorldHint': False},
}


def publish(session, arguments):
    if not isinstance(arguments, dict) or set(arguments) - {'path', 'name'}:
        raise ValueError('Expected path and optional name')
    metadata = files.publish(session, arguments.get('path'), arguments.get('name'))
    # Signals are only a refresh hint. Durable publication never depends on a viewer.
    try:
        subprocess.run(
            [str(files.STATE / 'bin' / 'outpost-signal'), 'files.changed', '{}'],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1,
            check=False,
            env={**os.environ, 'OUTPOST_SESSION_ID': session},
        )
    except (OSError, subprocess.TimeoutExpired):
        pass
    return {'stored': True, 'file': metadata}


def serve(session):
    # A user-level plugin can also be loaded by an ordinary, unmanaged CLI.
    # It can initialize normally, but has no capabilities to act on a session.
    available_tools = [TOOL] if session is not None else []
    initialized = False
    while True:
        line = sys.stdin.buffer.readline(65537)
        if not line:
            return
        if len(line) > 65536:
            return  # Never accumulate unbounded JSON from a caller.
        identifier = None
        try:
            request = json.loads(line)
            if (
                not isinstance(request, dict)
                or request.get('jsonrpc') != '2.0'
                or not isinstance(request.get('method'), str)
            ):
                raise ValueError('Invalid JSON-RPC request')
            if 'id' not in request:
                continue  # No server-initiated requests or subscriptions are used.
            identifier = request['id']
            if not isinstance(identifier, (str, int)) or isinstance(identifier, bool):
                raise ValueError('Invalid request ID')
            method = request['method']
            if method == 'initialize':
                params = request.get('params')
                if not isinstance(params, dict) or not isinstance(params.get('protocolVersion'), str):
                    raise ValueError('Expected MCP initialization parameters')
                initialized = True
                result = {
                    'protocolVersion': '2025-06-18',
                    'capabilities': {'tools': {}},
                    'serverInfo': {'name': 'outpost', 'version': '1.0.0'},
                    'instructions': (
                        'Use publish_file to deliver generated files and images to the user in this Outpost session.'
                        if session is not None
                        else 'No Outpost session is attached. No tools are available.'
                    ),
                }
            elif method == 'ping':
                result = {}
            elif not initialized:
                raise ValueError('Initialize the MCP connection first')
            elif method == 'tools/list':
                result = {'tools': available_tools}
            elif method == 'tools/call':
                params = request.get('params', {})
                try:
                    if session is None:
                        raise ValueError('This process is not attached to an Outpost session')
                    if not isinstance(params, dict) or params.get('name') != TOOL['name']:
                        raise ValueError('Unknown Outpost tool')
                    receipt = publish(session, params.get('arguments', {}))
                    result = {'content': [{'type': 'text', 'text': json.dumps(receipt)}], 'structuredContent': receipt}
                except (OSError, ValueError) as error:
                    result = {'isError': True, 'content': [{'type': 'text', 'text': str(error)}]}
            else:
                response = {
                    'jsonrpc': '2.0',
                    'id': identifier,
                    'error': {'code': -32601, 'message': 'Method not found'},
                }
                print(json.dumps(response), flush=True)
                continue
            response = {'jsonrpc': '2.0', 'id': identifier, 'result': result}
        except json.JSONDecodeError:
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'Invalid JSON'}}
        except (ValueError, TypeError, RecursionError) as error:
            response = {'jsonrpc': '2.0', 'id': identifier, 'error': {'code': -32600, 'message': str(error)}}
        print(json.dumps(response), flush=True)


def main():
    os.umask(0o077)
    arguments = sys.argv[1:]
    if arguments not in ([], ['--optional-session']) and not (len(arguments) == 2 and arguments[0] == 'publish'):
        raise ValueError('Usage: outpost-mcp [--optional-session | publish FILE]')
    directory = os.environ.get('OUTPOST_STATE_DIRECTORY')
    session = os.environ.get('OUTPOST_SESSION_ID')
    if arguments == ['--optional-session'] and directory is None and session is None:
        serve(None)
        return
    if directory is None or not os.path.isabs(directory):
        raise ValueError('Run this helper inside an Outpost session')
    files.STATE = Path(directory)
    files.require_session(session)
    if arguments and arguments[0] == 'publish':
        print(json.dumps(publish(session, {'path': arguments[1]})))
    else:
        serve(session)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        print('Outpost: ' + str(error), file=sys.stderr)
        sys.exit(1)

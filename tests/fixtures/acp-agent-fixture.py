#!/usr/bin/env python3
"""A scripted Agent Client Protocol server standing in for a coding tool's adapter.

It speaks ACP v1 on stdio, keeps conversations in the tool's native store (so
terminal and chat mode continue the same one), and drives Outpost's real MCP
server for session messaging. No model is involved.

Prompt scripts: text containing "permission" asks before its tool call, "wait"
runs until cancelled, "list sessions" and "message <name>: <text>" call the
Outpost MCP tools, "@name" in the text is repeated in the reply.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

variant = os.environ.get('FIXTURE_ACP_VARIANT') or ('kimi' if 'KIMI_CODE_HOME' in os.environ else 'claude')
lock = threading.Lock()
pending = {}
cancelled = threading.Event()
sessions = {}


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + '\n')
        sys.stdout.flush()


def notify(session_id, update):
    send({'jsonrpc': '2.0', 'method': 'session/update', 'params': {'sessionId': session_id, 'update': update}})


def request(method, params):
    identifier = 'agent-' + uuid.uuid4().hex
    event = threading.Event()
    pending[identifier] = [event, None]
    send({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})
    event.wait()
    return pending.pop(identifier)[1]


def store(session_id):
    if variant == 'kimi':
        home = Path(os.environ['KIMI_CODE_HOME'])
        return home / 'sessions' / 'fixture' / session_id / 'conversation.jsonl'
    return Path(os.environ['CLAUDE_CONFIG_DIR']) / 'projects' / 'fixture' / (session_id + '.jsonl')


def history(session_id):
    path = store(session_id)
    if not path.exists():
        return None
    records = []
    for line in path.read_text().splitlines():
        record = json.loads(line)
        message = record.get('message')
        if record.get('type') in ('user', 'assistant') and isinstance(message, dict):
            records.append((record['type'], message.get('content', '')))
    return records


def append(session_id, kind, text, cwd):
    path = store(session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a') as stream:
        record = {'type': kind, 'sessionId': session_id, 'cwd': cwd, 'message': {'role': kind, 'content': text}}
        stream.write(json.dumps(record) + '\n')


def create_kimi(session_id, cwd):
    home = Path(os.environ['KIMI_CODE_HOME'])
    directory = home / 'sessions' / 'fixture' / session_id
    (directory / 'agents' / 'main').mkdir(parents=True)
    (directory / 'agents' / 'main' / 'wire.jsonl').touch()
    state = {'id': session_id, 'cwd': cwd, 'createdAt': time.time() * 1000, 'updatedAt': time.time() * 1000}
    (directory / 'state.json').write_text(json.dumps(state))
    with (home / 'session_index.jsonl').open('a') as stream:
        stream.write(json.dumps({'sessionId': session_id, 'sessionDir': str(directory), 'workDir': cwd}) + '\n')


def config(session):
    return [
        {
            'id': 'mode',
            'name': 'Mode',
            'category': 'mode',
            'type': 'select',
            'currentValue': session['mode'],
            'options': [{'value': 'ask', 'name': 'Ask'}, {'value': 'auto', 'name': 'Auto'}],
        }
    ]


def open_session(params, session_id):
    server = next((item for item in params.get('mcpServers', []) if item.get('name') == 'outpost'), None)
    session = {'cwd': params['cwd'], 'mode': 'ask', 'mcp': server}
    sessions[session_id] = session
    system = params.get('systemPrompt')
    if system:
        text = '\n'.join(block.get('text', '') for block in system['content'])
        Path(params['cwd'], 'system-prompt.txt').write_text(system['mode'] + ':' + text)
    return session


def mcp_call(session, tool, arguments):
    """Run Outpost's stdio MCP server like a coding tool would, and call one tool."""
    server = session['mcp']
    environment = dict(os.environ)
    if server:
        command = [server['command'], *server['args']]
        environment.update({item['name']: item['value'] for item in server['env']})
    else:
        # Kimi receives Outpost MCP through its plugin, bound by its own environment.
        command = [sys.executable, '-I', str(Path(os.environ['OUTPOST_STATE_DIRECTORY']) / 'bin' / 'outpost-mcp')]
    process = subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=environment, cwd=session['cwd'], text=True
    )
    messages = [
        {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
        {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': tool, 'arguments': arguments}},
    ]
    output, _ = process.communicate('\n'.join(json.dumps(message) for message in messages) + '\n', timeout=60)
    result = [json.loads(line) for line in output.splitlines() if line.strip()][-1]['result']
    return ('Error: ' if result.get('isError') else '') + result['content'][0]['text']


def prompt(identifier, params):
    session_id = params['sessionId']
    session = sessions[session_id]
    text = ' '.join(block.get('text', '') for block in params['prompt'] if block.get('type') == 'text')
    images = sum(1 for block in params['prompt'] if block.get('type') == 'image')
    cancelled.clear()
    notify(session_id, {'sessionUpdate': 'agent_thought_chunk', 'content': {'type': 'text', 'text': 'Considering.'}})
    tool = 'tool-' + uuid.uuid4().hex[:8]
    notify(
        session_id,
        {
            'sessionUpdate': 'tool_call',
            'toolCallId': tool,
            'title': 'Run fixture check',
            'kind': 'execute',
            'status': 'pending',
            'rawInput': {'command': 'fixture-check'},
        },
    )
    stop = 'end_turn'
    reply = 'Fixture reply to: ' + re.sub(r'^\[Outpost: [^\]]*\]\n', '', text).strip()[:200]
    if images:
        reply += ' (' + str(images) + ' image)'
    if 'permission' in text:
        result = request(
            'session/request_permission',
            {
                'sessionId': session_id,
                'toolCall': {'toolCallId': tool, 'title': 'Run fixture check', 'kind': 'execute'},
                'options': [
                    {'optionId': 'allow', 'name': 'Allow', 'kind': 'allow_once'},
                    {'optionId': 'reject', 'name': 'Reject', 'kind': 'reject_once'},
                ],
            },
        )
        outcome = result['outcome']
        allowed = outcome.get('outcome') == 'selected' and outcome.get('optionId') == 'allow'
        if outcome.get('outcome') == 'cancelled':
            stop = 'cancelled'
        reply = 'Permission ' + ('granted' if allowed else 'denied') + '.'
    if 'wait' in text and stop == 'end_turn':
        notify(session_id, {'sessionUpdate': 'tool_call_update', 'toolCallId': tool, 'status': 'in_progress'})
        if cancelled.wait(60):
            stop = 'cancelled'
    if stop == 'end_turn':
        for chunk in ('running\n', 'checked\n'):
            notify(
                session_id,
                {
                    'sessionUpdate': 'tool_call_update',
                    'toolCallId': tool,
                    'status': 'in_progress',
                    '_meta': {'terminal_output_delta': {'terminal_id': tool, 'data': chunk}},
                },
            )
        notify(session_id, {'sessionUpdate': 'tool_call_update', 'toolCallId': tool, 'status': 'completed'})
        match = re.search(r'message ([^:]+): (.+)', text)
        if 'list sessions' in text:
            reply = mcp_call(session, 'list_sessions', {})
        elif match:
            reply = mcp_call(session, 'message_session', {'session': match.group(1), 'message': match.group(2)})
        mentions = re.findall(r'(?<![\w@])pass to (@[a-z0-9-]+)', text)
        if mentions:
            reply += ' ' + ' '.join(mentions)
        message = 'msg-' + uuid.uuid4().hex[:8]
        middle = len(reply) // 2
        for part in (reply[:middle], reply[middle:]):
            notify(
                session_id,
                {
                    'sessionUpdate': 'agent_message_chunk',
                    'messageId': message,
                    'content': {'type': 'text', 'text': part},
                },
            )
        notify(session_id, {'sessionUpdate': 'usage_update', 'used': 1000, 'size': 100000})
    else:
        notify(session_id, {'sessionUpdate': 'tool_call_update', 'toolCallId': tool, 'status': 'failed'})
    append(session_id, 'user', text, session['cwd'])
    if stop == 'end_turn':
        append(session_id, 'assistant', reply, session['cwd'])
    send({'jsonrpc': '2.0', 'id': identifier, 'result': {'stopReason': stop}})


def handle(message):
    method, params, identifier = message.get('method'), message.get('params', {}), message.get('id')
    if method is None:
        entry = pending.get(identifier)
        if entry:
            entry[1] = message.get('result')
            entry[0].set()
        return
    if method == 'session/cancel':
        cancelled.set()
        return
    if identifier is None:
        return
    result = None
    if method == 'initialize':
        capabilities = {'loadSession': True, 'promptCapabilities': {'image': True}, 'sessionCapabilities': {}}
        if variant == 'claude':
            capabilities['sessionCapabilities']['systemPrompt'] = {}
        result = {
            'protocolVersion': 1,
            'agentCapabilities': capabilities,
            'agentInfo': {'name': 'fixture-acp', 'title': 'Fixture ' + variant, 'version': '1.0.0'},
            'authMethods': [],
        }
    elif method == 'session/new':
        session_id = ('session_' + uuid.uuid4().hex) if variant == 'kimi' else str(uuid.uuid4())
        if variant == 'kimi':
            create_kimi(session_id, params['cwd'])
        session = open_session(params, session_id)
        result = {'sessionId': session_id, 'configOptions': config(session)}
    elif method == 'session/load':
        records = history(params['sessionId'])
        if records is None and variant == 'kimi':
            records = [] if store(params['sessionId']).parent.exists() else None
        if records is None:
            send({'jsonrpc': '2.0', 'id': identifier, 'error': {'code': -32002, 'message': 'Session not found'}})
            return
        session = open_session(params, params['sessionId'])
        for index, (kind, text) in enumerate(records):
            notify(
                params['sessionId'],
                {
                    'sessionUpdate': 'user_message_chunk' if kind == 'user' else 'agent_message_chunk',
                    'messageId': 'history-' + str(index),
                    'content': {'type': 'text', 'text': text},
                },
            )
        result = {'configOptions': config(session)}
    elif method == 'session/set_config_option':
        session = sessions[params['sessionId']]
        session['mode'] = params['value']
        result = {'configOptions': config(session)}
    elif method == 'session/prompt':
        threading.Thread(target=prompt, args=(identifier, params), daemon=True).start()
        return
    else:
        send({'jsonrpc': '2.0', 'id': identifier, 'error': {'code': -32601, 'message': 'Method not found'}})
        return
    send({'jsonrpc': '2.0', 'id': identifier, 'result': result})


if '--version' in sys.argv:
    print('0.102.0')
    sys.exit(0)
for line in sys.stdin:
    if line.strip():
        handle(json.loads(line))

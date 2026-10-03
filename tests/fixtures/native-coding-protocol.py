"""Exercise cold resume and isolated turns against the loopback model fixture."""
import os
from pathlib import Path
import sys
import time
import types

backend = Path(__file__).resolve().parents[2] / 'backend'
for name, path in [('outpost_coding_rpc', backend / 'coding_rpc.py')]:
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile(path.read_text(), str(path), 'exec'), module.__dict__)

from outpost_coding_rpc import JsonRpcProcess

tool, executable, session_id, cwd = sys.argv[1:5]
turn = sys.argv[5:] == ['turn']
process = JsonRpcProcess([executable, 'app-server' if tool == 'codex' else 'acp'], os.environ, cwd)
try:
    if tool == 'codex':
        process.call('initialize', {'clientInfo': {'name': 'outpost_native_test', 'version': '0.1.0'}})
        process.send({'method': 'initialized', 'params': {}})
        result = process.call('thread/resume', {'threadId': session_id, 'cwd': cwd})
        assert result['thread']['id'] == session_id
        if turn:
            process.call('turn/start', {'threadId': session_id, 'input': [{'type': 'text', 'text': 'NATIVE_USER_SEARCH_FIXTURE', 'text_elements': []}]})
            while time.monotonic() < process.deadline:
                thread = process.call('thread/read', {'threadId': session_id, 'includeTurns': True})['thread']
                if thread['turns'] and thread['turns'][-1]['status'] != 'inProgress':
                    assert thread['turns'][-1]['status'] == 'completed', thread['turns'][-1]['status']
                    break
                time.sleep(0.05)
            else:
                raise RuntimeError('Fixture turn did not complete')
    else:
        process.call('initialize', {'protocolVersion': 1, 'clientCapabilities': {},
                                    'clientInfo': {'name': 'outpost_native_test', 'version': '0.1.0'}})
        process.call('session/load', {'sessionId': session_id, 'cwd': cwd, 'mcpServers': []})
        if turn:
            result = process.call('session/prompt', {'sessionId': session_id, 'prompt': [{'type': 'text', 'text': 'NATIVE_USER_SEARCH_FIXTURE'}]})
            assert result['stopReason'] == 'end_turn', result['stopReason']
    print(('NATIVE_TURN_OK ' if turn else 'NATIVE_RESUME_OK ') + session_id)
finally:
    process.close()

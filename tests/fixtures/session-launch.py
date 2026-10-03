"""Exercise the actual attachment launch script with expanded Bash arguments."""
import json
from pathlib import Path
import subprocess
import sys
import types

backend = Path(__file__).resolve().parents[2] / 'backend'
for name, path in [
    ('outpost_coding_protocol', 'coding_protocol.py'),
    ('outpost_activity_state', 'activity_state.py'),
    ('outpost_codex_adapter', 'coding_adapters/codex.py'),
    ('outpost_claude_adapter', 'coding_adapters/claude.py'),
    ('outpost_kimi_adapter', 'coding_adapters/kimi.py'),
    ('outpost_session_runtime', 'session-runtime.py'),
]:
    module = types.ModuleType(name)
    sys.modules[name] = module
    exec(compile((backend / path).read_text(), path, 'exec'), module.__dict__)

from outpost_session_runtime import launch_script

results = []
for request in json.load(sys.stdin):
    result = subprocess.run(['bash', '-c', launch_script(request['session'], request['executable'])],
                            capture_output=True, text=True)
    results.append({'code': result.returncode, 'stdout': result.stdout, 'stderr': result.stderr})
print(json.dumps(results))

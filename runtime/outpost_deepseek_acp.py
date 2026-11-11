"""Adapt DeepSeek's ACP session/resume to ACP clients using session/load.

All prompts, approvals, updates and MCP server descriptors pass through. This
does not claim replay support: existing Outpost chat journals retain their own
history, and native history remains available through Outpost's history MCP.
"""

import json
import os
import subprocess
import sys
import threading


def main():
    process = subprocess.Popen([sys.argv[1], '--profile', 'acp'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    initialized = set()
    state = {'resume': False}

    def output():
        try:
            while True:
                line = process.stdout.readline(16 * 1024 * 1024 + 1)
                if not line:
                    break
                if len(line) > 16 * 1024 * 1024:
                    process.terminate()
                    break
                value = json.loads(line)
                if value.get('id') in initialized and isinstance(value.get('result'), dict):
                    capabilities = value['result'].get('agentCapabilities', {})
                    sessions = capabilities.get('sessionCapabilities', {})
                    state['resume'] = 'resume' in sessions and not capabilities.get('loadSession')
                    if state['resume']:
                        capabilities['loadSession'] = True
                    initialized.discard(value.get('id'))
                sys.stdout.buffer.write(json.dumps(value).encode() + b'\n')
                sys.stdout.buffer.flush()
        except (OSError, ValueError, TypeError):
            process.terminate()
        finally:
            process.stdout.close()
            # A dead native server must close the ACP transport even while the
            # controlling client's stdin is still open.
            try:
                code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                code = process.wait()
            os._exit(code if code >= 0 else 1)

    threading.Thread(target=output, daemon=True).start()
    try:
        while True:
            line = sys.stdin.buffer.readline(16 * 1024 * 1024 + 1)
            if not line or len(line) > 16 * 1024 * 1024:
                break
            value = json.loads(line)
            if value.get('method') == 'initialize' and 'id' in value:
                initialized.add(value['id'])
            if value.get('method') == 'session/load' and state['resume']:
                value['method'] = 'session/resume'
            process.stdin.write(json.dumps(value).encode() + b'\n')
            process.stdin.flush()
    finally:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


if __name__ == '__main__':
    main()

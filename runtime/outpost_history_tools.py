"""The same tool definitions are bundled by the server and target MCP helper."""

import json
from pathlib import Path


def definitions():
    path = str(Path(__file__).with_name('history-tools.json')) if '__file__' in globals() else 'history-tools.json'
    return json.loads(__loader__.get_data(path))

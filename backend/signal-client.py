#!/usr/bin/env python3
"""Target-side signal client. Installed as outpost-signal and outpost-browser."""
import json
from pathlib import Path
import sys
import urllib.error
import urllib.request
import uuid


def main():
    browser = Path(sys.argv[0]).name == 'outpost-browser'
    if (browser and len(sys.argv) != 2) or (not browser and len(sys.argv) != 3):
        raise ValueError('Usage: outpost-browser URL | outpost-signal TYPE JSON_PAYLOAD')
    # Reattachment refreshes this file, including for a surviving coding process.
    config = json.loads((Path(__file__).parent.parent / 'connection.json').read_text())
    message = {'version': 1, 'id': str(uuid.uuid4()),
               'type': 'browser.open' if browser else sys.argv[1],
               'payload': {'url': sys.argv[1]} if browser else json.loads(sys.argv[2])}
    body = json.dumps(message, allow_nan=False).encode()
    if len(body) > 32 * 1024:
        raise ValueError('Signals must fit within 32 KiB.')
    request = urllib.request.Request(config['url'], data=body, headers={
        'Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'})
    # The target endpoint is loopback; never send its bearer token through a proxy.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=15) as response:
        if response.status != 200:
            raise ValueError('Outpost did not accept the signal.')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(4096)).get('message', str(error))
        except (ValueError, OSError):
            message = str(error)
        print('Outpost: ' + message, file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, RecursionError) as error:
        print('Outpost: ' + str(error), file=sys.stderr)
        sys.exit(1)

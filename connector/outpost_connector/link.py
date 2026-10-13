"""outpost:// links and the servers this connector trusts.

A link is `outpost://connect/<base64url JSON>` with the server origin, a
single-use launch token, the terminal id and a window title. Links for
servers the user never installed from are refused before any network access.
"""
import base64
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from . import PROTOCOL, VERSION

HOME = Path(os.environ.get('OUTPOST_CONNECTOR_HOME') or Path.home() / '.outpost-connector')
CONFIG = HOME / 'config.json'


class LinkError(ValueError):
    pass


class Link:
    def __init__(self, server, token, terminal, title):
        self.server = server
        self.token = token
        self.terminal = terminal
        self.title = title

    def websocket_url(self, token, cols, rows):
        scheme = 'wss' if self.server.startswith('https:') else 'ws'
        query = ('token=' + token + '&cols=' + str(cols) + '&rows=' + str(rows)
                 + '&client=connector&protocol=' + str(PROTOCOL) + '&version=' + VERSION)
        return scheme + self.server[self.server.index(':'):] + '/api/terminal?' + query


def origin(value):
    """Normalize an http(s) origin, rejecting paths, credentials and queries."""
    parts = urlsplit(value)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password \
            or parts.path not in ('', '/') or parts.query or parts.fragment:
        raise LinkError('Expected an Outpost server origin such as https://outpost.example.com')
    return parts.scheme + '://' + parts.netloc.lower()


def parse(url):
    prefix = 'outpost://connect/'
    if not isinstance(url, str) or not url.startswith(prefix) or len(url) > 8192:
        raise LinkError('This is not an Outpost connect link.')
    try:
        encoded = url[len(prefix):].rstrip('/')
        data = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
    except ValueError:
        raise LinkError('This Outpost link is damaged. Click Connect in Outpost again.')
    if not isinstance(data, dict) or data.get('v') != 1:
        raise LinkError('This Outpost link needs a newer connector. Reinstall it from Outpost.')
    token, terminal, title = data.get('token'), data.get('terminal'), data.get('title', 'Outpost')
    if not isinstance(token, str) or not token.replace('.', '').replace('-', '').replace('_', '').isalnum() \
            or not isinstance(terminal, str) or not isinstance(title, str):
        raise LinkError('This Outpost link is damaged. Click Connect in Outpost again.')
    clean_title = ''.join(c for c in title if c.isprintable())[:120] or 'Outpost'
    return Link(origin(data.get('server', '')), token, terminal, clean_title)


def load():
    try:
        config = json.loads(CONFIG.read_text())
        if isinstance(config, dict) and isinstance(config.get('servers'), list):
            return config
    except (OSError, ValueError):
        pass
    return {'servers': []}


def save(config):
    HOME.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = CONFIG.with_name('.config.json.tmp')
    temporary.write_text(json.dumps(config, indent=2) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, CONFIG)


def trust(server):
    config = load()
    server = origin(server)
    if server not in config['servers']:
        config['servers'].append(server)
        save(config)
    return server


def trusted(link):
    if link.server not in load()['servers']:
        raise LinkError('This connector does not trust ' + link.server + '. To use it, run:\n  curl -fsSL '
                        + link.server + '/connector/install.sh | bash')
    return link

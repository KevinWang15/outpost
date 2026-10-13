"""Input shims: find local paste gestures in the bytes a terminal app sends.

Only key presses are interpreted. Bracketed pastes and terminal replies (OSC,
DCS and other strings) are opaque, so pasted text can never trigger a paste.
"""

import re
import time

# Sent by the Outpost terminal profiles (iTerm2 ⌘V) to request a full paste.
PASTE_KEY = b'\x1b[9001~'
# Paste an image when the clipboard holds one; otherwise these keys pass through.
IMAGE_KEYS = (b'\x16', b'\x1bv')  # Ctrl+V, Alt+V
CSI = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
ESCAPE_TIMEOUT = 0.04


class InputRouter:
    """feed() returns a list of actions: ('data', bytes) or ('paste', kind, original)."""

    def __init__(self):
        self.pending = b''
        self.mode = 'normal'
        self.since = 0.0

    def feed(self, data):
        self.pending += data
        actions = []
        while self.pending:
            if self.mode != 'normal':
                end = (
                    re.compile(rb'\x1b\[201~')
                    if self.mode == 'paste'
                    else re.compile(rb'\x07|\x1b\\|[\x18\x1a]')
                    if self.mode == 'osc'
                    else re.compile(rb'\x1b\\|[\x18\x1a]')
                )
                found = end.search(self.pending)
                if not found:
                    # Keep only a possible split terminator, even for large pastes.
                    keep = 5 if self.mode == 'paste' else 1
                    if len(self.pending) > keep:
                        actions.append(('data', self.pending[:-keep]))
                        self.pending = self.pending[-keep:]
                    break
                actions.append(('data', self.pending[: found.end()]))
                self.pending = self.pending[found.end() :]
                self.mode = 'normal'
                continue
            special = re.search(rb'[\x16\x1b]', self.pending)
            if not special:
                actions.append(('data', self.pending))
                self.pending = b''
                break
            if special.start():
                actions.append(('data', self.pending[: special.start()]))
                self.pending = self.pending[special.start() :]
            if self.pending.startswith(b'\x16'):
                actions.append(('paste', 'image', b'\x16'))
                self.pending = self.pending[1:]
                continue
            if len(self.pending) < 2:
                break  # A lone Escape: wait briefly for the rest of a sequence.
            second = self.pending[1:2]
            if second in (b']', b'P', b'_', b'^', b'X'):
                self.mode = 'osc' if second == b']' else 'string'
                actions.append(('data', self.pending[:2]))
                self.pending = self.pending[2:]
            elif second == b'[':
                match = CSI.match(self.pending)
                if not match:
                    if len(self.pending) < 64:
                        break
                    actions.append(('data', self.pending))
                    self.pending = b''
                    break
                sequence = match.group()
                self.pending = self.pending[len(sequence) :]
                if sequence == PASTE_KEY:
                    actions.append(('paste', 'any', b''))
                else:
                    if sequence == b'\x1b[200~':
                        self.mode = 'paste'
                    actions.append(('data', sequence))
            elif self.pending[:2] == b'\x1bv':
                actions.append(('paste', 'image', b'\x1bv'))
                self.pending = self.pending[2:]
            else:
                actions.append(('data', self.pending[:2]))
                self.pending = self.pending[2:]
        self.since = time.monotonic()
        return merge(actions)

    def flush(self, force=False):
        """Release a lone Escape once no continuation arrived in time."""
        if self.pending and self.mode == 'normal' and (force or time.monotonic() - self.since >= ESCAPE_TIMEOUT):
            data, self.pending = self.pending, b''
            return [('data', data)]
        return []

    @property
    def waiting(self):
        return bool(self.pending) and self.mode == 'normal'

    def reset(self):
        self.pending = b''
        self.mode = 'normal'


def merge(actions):
    merged = []
    for action in actions:
        if action[0] == 'data' and merged and merged[-1][0] == 'data':
            merged[-1] = ('data', merged[-1][1] + action[1])
        elif action[0] != 'data' or action[1]:
            merged.append(action)
    return merged


def bracketed(text, enabled):
    """Text as the terminal would paste it: CR line endings, bracketed if the app asked."""
    normalized = text.replace('\r\n', '\r').replace('\n', '\r')
    # Never let pasted text end a bracketed paste early.
    normalized = normalized.replace('\x1b[201~', '')
    return ('\x1b[200~' + normalized + '\x1b[201~') if enabled and normalized else normalized

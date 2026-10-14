"""Navigate tmux's history without copying terminal output into another store."""

import subprocess


class Scrollback:
    # Copy mode owns a frozen screen. Newer tmux exposes its exact size; older
    # versions need the length remembered when entering, until returning live.
    template = (
        '#{pane_id}|#{pane_width}|#{pane_height}|#{history_size}|'
        '#{pane_in_mode}|#{pane_mode}|#{scroll_position}|#{copy_position_limit}'
    )

    def __init__(self, command, environment):
        self.command = command
        self.environment = environment
        self.copy_key = None
        self.copy_lines = 0

    def run(self, *arguments):
        try:
            result = subprocess.run(
                [*self.command, *arguments],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                env=self.environment,
                timeout=1,
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError('The terminal history is not responding.') from error
        if result.returncode:
            raise ValueError('The terminal history is unavailable.')
        return result.stdout.strip()

    def inspect(self, target='=outpost:'):
        pane, cols, rows, lines, in_mode, mode, offset, copy_limit = self.run(
            'display-message', '-p', '-t', target, self.template
        ).split('|')
        lines, rows, offset = int(lines), int(rows), int(offset or '0')
        active = mode == 'copy-mode'
        available = in_mode == '0' or active
        key = (pane, cols, rows) if active else None
        if active:
            if key != self.copy_key:
                self.copy_lines = lines
            if copy_limit:
                self.copy_lines = int(copy_limit)
            lines = max(self.copy_lines, offset)
        self.copy_key = key
        return pane, {
            'available': available,
            'lines': lines,
            'offset': offset if active else 0,
            'rows': rows,
            'active': active,
        }

    def read(self, offset=None):
        pane, state = self.inspect()
        if offset is None or not state['available']:
            return state
        if offset == 0:
            if state['active']:
                self.run('send-keys', '-X', '-t', pane, 'cancel')
        elif state['lines']:
            # A fixed tmux command takes the numeric offset directly, so even
            # a 50,000-line jump is one operation rather than thousands of keys.
            commands = [] if state['active'] else ['copy-mode', '-e', '-t', pane, ';']
            self.run(*commands, 'send-keys', '-X', '-t', pane, 'goto-line', str(offset))
        _, result = self.inspect(pane)
        if result['active'] and offset == -1:
            self.copy_lines = result['lines'] = result['offset']
        return result

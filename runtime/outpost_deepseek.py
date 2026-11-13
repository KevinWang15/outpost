"""Official DeepSeek Harness (dsh): persistent ACP Chat and native history."""

import sys
from functools import cached_property

import outpost_deepseek_acp
from outpost_harness import CodingSessionAdapter
from outpost_storage import replace_file


class DeepSeekAdapter(CodingSessionAdapter):
    tool = 'deepseek'
    command = 'dsh'
    terminal_supported = False
    id_pattern = r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
    storage_key = 'DSH_HOME'
    storage_directory = '.dsh'
    selection_options = ('--resume', '--session', '--session-id', '--profile', '--from-default-profile', '--patch')

    @cached_property
    def sessions(self):
        from outpost_deepseek_store import DeepSeekSessionStore

        return DeepSeekSessionStore(self)

    def arguments(self, session):
        raise ValueError('DeepSeek Harness has no bundled terminal UI. Open this session in Outpost Chat.')

    def prepare_launch(self, directory, session):
        return []

    def prepare_activity(self, directory, session, generation, executable):
        return []

    def activity_files(self, session):
        home = self.home(session['cliSessionEnv'], session['rootDir'])
        for path in self.sessions.history_paths(home):
            if path.parent.name == session['cliSessionId'] and path.suffix == '.jsonl':
                yield path

    def chat_command(self, directory, executable):
        path = directory / 'bin' / 'outpost-deepseek-acp.py'
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        source = outpost_deepseek_acp.__loader__.get_source(outpost_deepseek_acp.__name__)
        if source is None:
            raise ValueError('DeepSeek ACP adapter source is unavailable')
        if not path.exists() or path.read_text() != source:
            replace_file(path, source)
        return [sys.executable, '-I', str(path), executable], {}

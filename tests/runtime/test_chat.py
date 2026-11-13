"""Chat mode through the target runtime: the chat host, its relay and identity handshake."""

import json
import os
import select
import subprocess
import time
import unittest

# test_runtime puts runtime/ on the import path and provides its frame codec.
# Import the module, not its TestCase, so its tests are not collected twice.
import test_runtime

BINARY, MAGIC, FrameDecoder, control = (
    test_runtime.BINARY,
    test_runtime.MAGIC,
    test_runtime.FrameDecoder,
    test_runtime.control,
)


@unittest.skipUnless(BINARY.is_file(), 'npm run build:terminal is required')
class ChatTest(unittest.TestCase):
    setUp = test_runtime.RuntimeTest.setUp
    tearDown = test_runtime.RuntimeTest.tearDown
    command = test_runtime.RuntimeTest.command
    call = test_runtime.RuntimeTest.call
    create = test_runtime.RuntimeTest.create

    def test_deepseek_chat_resumes_exact_session_with_default_mcp_and_no_terminal_driver(self):
        session = self.create(name='DeepSeek named session', tool='deepseek')
        self.assertEqual(session['tool'], 'deepseek')
        native = session['cliSessionId']
        chat = self.open(session)
        ready = self.ready(chat)
        self.assertEqual(ready['info']['nativeId'], native)
        chat.send(
            {
                'type': 'prompt',
                'id': 'd1',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'publish deepseek-result.txt'}],
                'files': [],
            }
        )
        ended = chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'ended')
        self.assertEqual(ended['entry']['stopReason'], 'end_turn')
        self.assertTrue((self.project / 'deepseek-result.txt').is_file())
        self.call({'action': 'terminate', 'id': session['id']})
        reopened = self.open(session)
        self.assertEqual(self.ready(reopened)['info']['nativeId'], native)
        self.call({'action': 'terminate', 'id': session['id']})
        blocked = self.call(
            {'action': 'attach', 'id': session['id'], 'cols': 80, 'rows': 24, 'start': True}, expect_ok=False
        )
        self.assertEqual(blocked['status'], 409)
        self.assertIn('Outpost Chat', blocked['message'])

    def test_files_sent_to_the_agent_are_stored_and_linked_where_its_tools_can_read_them(self):
        session = self.create(name='Attachments')
        data = b'Ship on Friday\n'
        request = {'action': 'files-receive', 'id': session['id'], 'name': 'notes v2.txt', 'size': len(data)}
        stored = self.call(request, data)
        self.assertEqual((stored['name'], stored['size'], stored['source']), ('notes v2.txt', len(data), 'received'))
        self.assertEqual(
            [item['id'] for item in self.call({'action': 'files-list', 'id': session['id']})], [stored['id']]
        )
        short = self.call({**request, 'size': 10}, b'abc', expect_ok=False)
        self.assertIn('Incomplete', short['message'])
        nested = self.call({**request, 'name': 'a/b.txt'}, data, expect_ok=False)
        self.assertIn('filename', nested['message'])

        chat = self.open(session)
        self.ready(chat)
        chat.send(
            {
                'type': 'prompt',
                'id': 'f1',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'Summarize'}],
                'files': [stored['id']],
            }
        )
        queued = chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'queued')
        link = queued['entry']['prompt'][-1]
        self.assertEqual((link['type'], link['name']), ('resource_link', 'notes v2.txt'))
        self.assertEqual(link['_meta']['outpost']['file']['id'], stored['id'])
        chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'ended')
        reply = ''.join(
            m['entry']['update']['content']['text']
            for m in chat.messages
            if m['type'] == 'entry'
            and m['entry']['kind'] == 'update'
            and m['entry']['update']['sessionUpdate'] == 'agent_message_chunk'
        )
        self.assertIn('(read notes v2.txt: Ship on Friday)', reply)
        chat.send(
            {
                'type': 'prompt',
                'id': 'f2',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [],
                'files': ['0' * 32],
            }
        )
        missing = chat.expect(lambda m: m['type'] == 'result' and m['id'] == 'f2')
        self.assertFalse(missing['ok'])
        self.assertIn('no longer in this session', missing['message'])

    def ready(self, chat):
        return chat.expect(
            lambda m: (
                (m['type'] == 'info' and m['info']['state'] == 'ready')
                or (m['type'] == 'welcome' and m['info']['state'] == 'ready')
            )
        )

    def open(self, session, start=True, role='viewer'):
        process = subprocess.Popen(
            self.command({'action': 'chat-attach', 'id': session['id'], 'start': start}),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            env=self.env,
        )

        def cleanup():
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout):
                stream.close()

        self.addCleanup(cleanup)
        connection = ChatConnection(process)
        connection.send({'type': 'hello', 'protocol': 2, 'role': role})
        return connection

    def test_chat_starts_a_conversation_records_it_and_continues_it_after_a_restart(self):
        session = self.create()
        self.call({'action': 'chat-settings', 'id': session['id'], 'instructions': 'Be brief.'})
        chat = self.open(session)
        chat.expect(lambda m: m['type'] == 'welcome')
        identity = chat.expect(lambda m: m['type'] == 'identity')
        # The relay records the agent's new conversation before any prompt runs.
        ready = chat.expect(lambda m: m['type'] == 'info' and m['info']['state'] == 'ready')
        self.assertEqual(ready['info']['instructions'], 'applied')
        self.assertEqual((self.project / 'system-prompt.txt').read_text(), 'append:Be brief.')
        listed = self.call({'action': 'get', 'id': session['id']})
        self.assertEqual(listed['cliSessionId'], identity['nativeId'])
        self.assertEqual(
            (listed['driver'], listed['status'], listed['instructions']), ('chat', 'attached', 'Be brief.')
        )

        chat.send(
            {
                'type': 'prompt',
                'id': 'p1',
                'key': 'k1',
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'Check with permission'}],
                'files': [],
            }
        )
        queued = chat.expect(lambda m: m['type'] == 'result' and m['id'] == 'p1')
        self.assertTrue(queued['ok'], queued)
        turn = queued['data']['turn']
        asked = chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'permission')
        self.assertEqual(self.call({'action': 'get', 'id': session['id']})['activity']['state'], 'waiting')
        chat.send({'type': 'permission', 'id': 'a1', 'request': asked['entry']['id'], 'optionId': 'allow'})
        ended = chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'ended')
        self.assertEqual((ended['entry']['turn'], ended['entry']['stopReason']), (turn, 'end_turn'))
        # A retried prompt with the same key is the same turn.
        chat.send(
            {
                'type': 'prompt',
                'id': 'p2',
                'key': 'k1',
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'Check with permission'}],
                'files': [],
            }
        )
        duplicate = chat.expect(lambda m: m['type'] == 'result' and m['id'] == 'p2')
        self.assertEqual(duplicate['data'], {'turn': turn, 'duplicate': True})

        finished = self.call({'action': 'get', 'id': session['id']})['activity']
        self.assertEqual(finished['state'], 'finished')
        # One driver at a time: the terminal refuses while chat runs, and deletion waits.
        blocked = self.call(
            {'action': 'attach', 'id': session['id'], 'cols': 80, 'rows': 24, 'start': True}, expect_ok=False
        )
        self.assertEqual(blocked['status'], 409)
        self.assertIn('open in chat', blocked['message'])
        self.assertEqual(self.call({'action': 'delete', 'id': session['id']}, expect_ok=False)['status'], 409)
        seen = self.call({'action': 'acknowledge', 'id': session['id'], 'completionId': finished['completionId']})
        self.assertEqual(seen['activity']['state'], 'idle')

        stopped = self.call({'action': 'terminate', 'id': session['id']})
        self.assertIsNone(stopped['driver'])
        chat.expect_closed()
        gone = self.call({'action': 'chat-attach', 'id': session['id'], 'start': False}, expect_ok=False)
        self.assertEqual(gone['status'], 410)

        # A restart loads the same native conversation and replays it as history.
        again = self.open(session)
        welcome = again.expect(lambda m: m['type'] == 'welcome')
        if welcome['info']['state'] != 'ready':
            self.ready(again)
        self.assertEqual(welcome['info']['nativeId'], identity['nativeId'])
        entries = welcome['journal']['entries'] + [m['entry'] for m in again.messages if m['type'] == 'entry']
        texts = [
            entry['update']['content']['text']
            for entry in entries
            if entry['kind'] == 'update' and entry['turn'] is None
        ]
        self.assertEqual(texts, ['Check with permission', 'Permission granted.'])

    def test_outpost_tools_reach_the_hub_and_queued_prompts_can_be_cancelled(self):
        session = self.create()
        viewer = self.open(session)
        self.ready(viewer)
        hub = self.open(session, role='hub')
        hub.expect(lambda m: m['type'] == 'welcome')
        viewer.send(
            {
                'type': 'prompt',
                'id': 'p1',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'list sessions please'}],
                'files': [],
            }
        )
        call = hub.expect(lambda m: m['type'] == 'call')
        self.assertEqual((call['tool'], call['origin']), ('list_sessions', {'kind': 'user'}))
        hub.send({'type': 'answer', 'id': call['id'], 'ok': True, 'data': {'sessions': [{'name': 'Other'}]}})
        ended = viewer.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'ended')
        replies = [
            m['entry']['update']['content']['text']
            for m in viewer.messages
            if m['type'] == 'entry'
            and m['entry']['kind'] == 'update'
            and m['entry']['turn'] == ended['entry']['turn']
            and m['entry']['update']['sessionUpdate'] == 'agent_message_chunk'
        ]
        self.assertIn('"Other"', ''.join(replies))

        # A long turn runs; a second prompt waits in the queue and can be withdrawn.
        viewer.send(
            {
                'type': 'prompt',
                'id': 'p2',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'wait here'}],
                'files': [],
            }
        )
        viewer.expect(lambda m: m['type'] == 'result' and m['id'] == 'p2')
        viewer.send(
            {
                'type': 'prompt',
                'id': 'p3',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'later'}],
                'files': [],
            }
        )
        queued = viewer.expect(lambda m: m['type'] == 'result' and m['id'] == 'p3')['data']['turn']
        viewer.send({'type': 'unqueue', 'id': 'u1', 'turn': queued})
        self.assertTrue(viewer.expect(lambda m: m['type'] == 'result' and m['id'] == 'u1')['ok'])
        viewer.send({'type': 'cancel', 'id': 'c1'})
        cancelled = viewer.expect(
            lambda m: (
                m['type'] == 'entry'
                and m['entry']['kind'] == 'ended'
                and m['entry']['turn'] != queued
                and m['entry']['stopReason'] == 'cancelled'
            )
        )
        self.assertNotEqual(cancelled['entry']['turn'], ended['entry']['turn'])

    def test_kimi_chat_uses_its_plugin_and_reports_unsupported_instructions(self):
        session = self.create(tool='kimi')
        self.call({'action': 'chat-settings', 'id': session['id'], 'instructions': 'Be brief.'})
        chat = self.open(session)
        ready = self.ready(chat)
        self.assertEqual(ready['info']['instructions'], 'unsupported')
        self.assertEqual(ready['info']['nativeId'], session['cliSessionId'])
        entries = ready['journal']['entries'] if ready['type'] == 'welcome' else []
        entries += [m['entry'] for m in chat.messages if m['type'] == 'entry']
        self.assertTrue(any(e['kind'] == 'notice' and 'instructions' in e['text'] for e in entries))
        chat.send(
            {
                'type': 'prompt',
                'id': 'p1',
                'key': None,
                'origin': {'kind': 'user'},
                'prompt': [{'type': 'text', 'text': 'list sessions'}],
                'files': [],
            }
        )
        # The plugin's MCP server reaches the chat host, which holds the call until
        # the server (the hub) connects.
        chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'started')
        hub = self.open(session, start=False, role='hub')
        call = hub.expect(lambda m: m['type'] == 'call')
        self.assertEqual(call['tool'], 'list_sessions')
        hub.send({'type': 'answer', 'id': call['id'], 'ok': True, 'data': {'sessions': [{'name': 'Other'}]}})
        ended = chat.expect(lambda m: m['type'] == 'entry' and m['entry']['kind'] == 'ended')
        self.assertEqual(ended['entry']['stopReason'], 'end_turn')
        text = ''.join(
            m['entry']['update']['content']['text']
            for m in chat.messages
            if m['type'] == 'entry'
            and m['entry']['kind'] == 'update'
            and m['entry']['update']['sessionUpdate'] == 'agent_message_chunk'
        )
        self.assertIn('Other', text)


class ChatConnection:
    def __init__(self, process):
        self.process = process
        self.decoder = FrameDecoder()
        self.prefix = b''
        self.started = False
        self.messages = []
        self.seen = 0
        self.closed = False

    def send(self, message):
        self.process.stdin.write(control(message))
        self.process.stdin.flush()

    def pump(self, timeout=0.2):
        if self.closed or not select.select([self.process.stdout], [], [], timeout)[0]:
            return
        data = os.read(self.process.stdout.fileno(), 262144)
        if not data:
            self.closed = True
            return
        if not self.started:
            self.prefix += data
            if MAGIC not in self.prefix:
                return
            self.started = True
            data = self.prefix.split(MAGIC, 1)[1]
        for _kind, payload in self.decoder.feed(data):
            self.messages.append(json.loads(payload))

    def expect(self, predicate, timeout=20):
        deadline = time.monotonic() + timeout
        while True:
            for index in range(self.seen, len(self.messages)):
                if predicate(self.messages[index]):
                    self.seen = index + 1
                    return self.messages[index]
            if self.closed:
                raise AssertionError('Chat relay ended: ' + repr(self.prefix[-2000:]) + repr(self.messages[-5:]))
            if time.monotonic() > deadline:
                raise AssertionError('Timed out; last messages: ' + json.dumps(self.messages[-5:])[-3000:])
            self.pump()

    def expect_closed(self, timeout=15):
        deadline = time.monotonic() + timeout
        while not self.closed:
            if time.monotonic() > deadline:
                raise AssertionError('The chat relay is still open')
            self.pump()

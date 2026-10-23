"""Activity wakeups are optional hints; lifecycle state stays in durable files."""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'runtime'))

from outpost_activity_events import file_lock, write_json
from outpost_activity_watch import EVENT, IN_Q_OVERFLOW, ActivityWatch


class WatchTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='outpost-activity-watch-')
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name) / 'activity'
        self.directory.mkdir()
        self.path = self.directory / 'session.json'

    def watch(self):
        watch = ActivityWatch(self.path)
        self.addCleanup(watch.close)
        self.assertIsNotNone(watch.descriptor, 'The Linux target must support inotify')
        return watch

    def test_atomic_updates_wake_every_client_and_derived_files_do_not(self):
        first, second = self.watch(), self.watch()
        for name in ('session.events.json', 'session.seen.json', 'session.json'):
            write_json(self.directory / name, {})
            self.assertTrue(first.changed(), name)
            self.assertTrue(second.changed(), name)
            self.assertFalse(first.changed())
        for name in ('session.observation.json', 'session.transcript.json', 'another.events.json'):
            write_json(self.directory / name, {})
        with file_lock(self.directory / 'session.events.lock'):
            pass
        self.assertFalse(first.changed())
        self.assertFalse(second.changed())

    def test_unavailable_watch_falls_back_without_raising(self):
        with patch('outpost_activity_watch.ctypes.CDLL', side_effect=OSError('watch unavailable')):
            watch = ActivityWatch(self.path)
        self.assertIsNone(watch.descriptor)
        self.assertFalse(watch.changed())
        watch.close()

    def test_overflow_requests_a_reread_and_close_releases_the_descriptor(self):
        watch = self.watch()
        with patch('outpost_activity_watch.os.read', return_value=EVENT.pack(-1, IN_Q_OVERFLOW, 0, 0)):
            self.assertTrue(watch.changed())
        descriptor = watch.descriptor
        watch.close()
        with self.assertRaises(OSError):
            os.fstat(descriptor)
        self.assertFalse(watch.changed())
        watch.close()

    def test_moved_directory_invalidates_the_watch(self):
        watch = self.watch()
        self.directory.rename(self.directory.with_name('moved'))
        self.assertTrue(watch.changed())
        self.assertIsNone(watch.descriptor)


if __name__ == '__main__':
    unittest.main()

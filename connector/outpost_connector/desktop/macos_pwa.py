"""Find browser-owned Outpost apps without reading or changing browser profiles."""

import plistlib
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from xml.parsers.expat import ExpatError

PROTOCOL = 'web+outpost'
BROWSERS = ('com.google.Chrome', 'com.microsoft.edgemac')


def installed_app(url, home):
    # Match the exact credential-free start URL, not a display name or just an
    # origin: several Outpost servers and unrelated PWAs can coexist.
    start = urlsplit(url)._replace(query='', fragment='').geturl()
    matches = []
    for directory in (home / 'Applications', Path('/Applications')):
        # Chrome/Edge normally use a *.localized subdirectory. Also allow apps
        # moved directly into Applications. Do not traverse app bundles.
        for pattern in ('*.app/Contents/Info.plist', '*.localized/*.app/Contents/Info.plist'):
            for info in sorted(directory.glob(pattern)):
                try:
                    with info.open('rb') as stream:
                        plist = plistlib.load(stream)
                except (OSError, ValueError, EOFError, ExpatError, plistlib.InvalidFileException):
                    continue
                if not isinstance(plist, dict) or plist.get('CrAppModeShortcutURL') != start:
                    continue
                browser = plist.get('CrBundleIdentifier')
                if browser not in BROWSERS:
                    continue
                handlers = plist.get('CFBundleURLTypes', [])
                if not isinstance(handlers, list) or not any(
                    isinstance(handler, dict)
                    and isinstance(handler.get('CFBundleURLSchemes'), list)
                    and PROTOCOL in handler['CFBundleURLSchemes']
                    for handler in handlers
                ):
                    continue
                matches.append((BROWSERS.index(browser), info.parents[1]))
    return min(matches, key=lambda match: match[0])[1] if matches else None


def launch_url(url):
    # The manifest maps this envelope to /terminal/app#launch=%s. The ticket
    # stays in the fragment, is consumed by appTicket, and never enters a file.
    token = parse_qs(urlsplit(url).fragment)['token'][0]
    return PROTOCOL + '://connect/' + token

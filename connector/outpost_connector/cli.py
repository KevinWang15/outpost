"""outpost-connector install | uninstall | open URL | attach URL | version"""

import argparse
import os
import sys

from . import VERSION, install, link
from .platforms import detect
from .session import Session


def attach(url):
    try:
        target = link.trusted(link.parse(url))
    except link.LinkError as error:
        # Keep the message on screen; the terminal tab may close when we exit.
        print('Outpost: ' + str(error), file=sys.stderr)
        if os.isatty(0):
            input('\nPress Enter to close.')
        return 1
    return Session(target, detect()).run()


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog='outpost-connector', description='Outpost desktop terminal connector ' + VERSION
    )
    commands = parser.add_subparsers(dest='command', required=True)
    setup = commands.add_parser('install', help='install or update, and trust an Outpost server')
    setup.add_argument('--server', required=True, help='Outpost server origin, e.g. https://outpost.example.com')
    setup.add_argument('--archive', default=sys.argv[0], help=argparse.SUPPRESS)
    commands.add_parser('uninstall', help='remove the connector and its terminal integration')
    commands.add_parser('open', help='open an outpost:// link in its terminal').add_argument('url')
    commands.add_parser('attach', help='connect this terminal to an outpost:// link').add_argument('url')
    commands.add_parser('version', help='print the connector version')
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == 'install':
            install.install(arguments.server, arguments.archive)
        elif arguments.command == 'uninstall':
            install.uninstall()
        elif arguments.command == 'open':
            install.open_link(arguments.url)
        elif arguments.command == 'attach':
            sys.exit(attach(arguments.url))
        else:
            print(VERSION)
    except (OSError, ValueError) as error:
        print('Outpost: ' + str(error), file=sys.stderr)
        sys.exit(1)

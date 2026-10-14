"""Git worktree creation on the session's target, before allocating a session."""

import os
import shutil
import subprocess


def create_worktree(source, destination, branch):
    executable = shutil.which('git')
    if not executable:
        raise ValueError('Git is missing on this target. Install Git before forking a session.')
    if os.path.lexists(destination):
        raise ValueError('The worktree directory already exists. Choose a new directory.')

    def git(*arguments):
        result = subprocess.run(
            [executable, '-C', source, *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if result.returncode:
            raise ValueError(
                'Could not create Git worktree: ' + (result.stderr.strip() or result.stdout.strip())[-4096:]
            )
        return result.stdout.strip()

    # --branch accepts checkout shorthand such as @{-1}; require a literal name.
    if git('check-ref-format', '--branch', branch) != branch:
        raise ValueError('Enter a literal new Git branch name.')
    # -b refuses existing branches; argv and -- keep user input out of the shell.
    git('worktree', 'add', '-b', branch, '--', str(destination), 'HEAD')

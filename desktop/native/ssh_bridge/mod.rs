//! Experimental interactive SSH bridge for local Outpost Desktop terminals.
//!
//! When `ENABLED` is `true` (and `OUTPOST_DISABLE_SSH_BRIDGE` is unset), local terminals
//! override `ssh` so interactive logins transparently bootstrap `~/.outpost/bin/ssh-shell`
//! on remote machines that have Outpost machine service installed (and fall back cleanly to
//! `$SHELL -l` on all other hosts).
//!
//! Flip `ENABLED = false` to disable the entire Desktop side of the experiment cleanly.

mod paste;
mod protocol;

pub use paste::{SshBridgeActions, SshBridgePane};
pub use protocol::{MAX_SSH_BRIDGE_OSC_BYTES, SshRemoteMessage, parse_ssh_bridge_osc_data};

use portable_pty::CommandBuilder;
use std::{fs, path::Path};

/// Master feature switch for the Desktop-side experimental SSH bridge.
pub const ENABLED: bool = true;

pub fn is_enabled() -> bool {
    ENABLED && std::env::var_os("OUTPOST_DISABLE_SSH_BRIDGE").is_none()
}

/// Remote POSIX bootstrap command passed on interactive `ssh` logins.
/// Checks for the dedicated `ssh-shell` helper so hosts without Outpost (or older versions)
/// execute the user's normal login shell with zero error or delay.
const REMOTE_BOOTSTRAP: &str = r#"if [ -x "$HOME/.outpost/bin/ssh-shell" ]; then exec "$HOME/.outpost/bin/ssh-shell"; else exec "${SHELL:-/bin/sh}" -l; fi"#;

const POSIX_SSH_HOOK: &str = r#"# Outpost Desktop interactive SSH bridge (override `ssh` for interactive logins only).
__outpost_ssh_bootstrap='__OUTPOST_REMOTE_BOOTSTRAP__'
function ssh {
  if [ "${OUTPOST_DISABLE_SSH_BRIDGE:-}" = "1" ] || [ ! -t 0 ] || [ ! -t 1 ]; then
    command ssh "$@"
    return $?
  fi
  local __dest="" __skip=0 __opt_o=0 __passthrough=0 __arg __ch __rest
  for __arg in "$@"; do
    if [ "$__skip" -eq 1 ]; then
      if [ "$__opt_o" -eq 1 ]; then
        case "$__arg" in
          [Rr][Ee][Mm][Oo][Tt][Ee][Cc][Oo][Mm][Mm][Aa][Nn][Dd]*|[Rr][Ee][Qq][Uu][Ee][Ss][Tt][Tt][Tt][Yy]=[Nn][Oo])
            __passthrough=1
            break
            ;;
        esac
        __opt_o=0
      fi
      __skip=0
      continue
    fi
    if [ -n "$__dest" ]; then
      __passthrough=1
      break
    fi
    case "$__arg" in
      --)
        __passthrough=1
        break
        ;;
      -*)
        __rest="${__arg#-}"
        while [ -n "$__rest" ]; do
          __ch="${__rest%"${__rest#?}"}"
          __rest="${__rest#?}"
          case "$__ch" in
            G|N|O|T|V|W|f|M|s)
              __passthrough=1
              break 2
              ;;
            o)
              if [ -z "$__rest" ]; then
                __skip=1
                __opt_o=1
              else
                case "$__rest" in
                  [Rr][Ee][Mm][Oo][Tt][Ee][Cc][Oo][Mm][Mm][Aa][Nn][Dd]*|[Rr][Ee][Qq][Uu][Ee][Ss][Tt][Tt][Tt][Yy]=[Nn][Oo])
                    __passthrough=1
                    break 2
                    ;;
                esac
              fi
              break
              ;;
            B|b|c|D|E|e|F|I|i|J|L|l|m|p|Q|R|S|w)
              if [ -z "$__rest" ]; then
                __skip=1
              fi
              break
              ;;
          esac
        done
        ;;
      *)
        __dest="$__arg"
        ;;
    esac
  done
  if [ "$__passthrough" -eq 1 ] || [ -z "$__dest" ]; then
    command ssh "$@"
    return $?
  fi
  case "$__dest" in
    git@*|hg@*|svn@*)
      command ssh "$@"
      return $?
      ;;
  esac
  command ssh -t "$@" "$__outpost_ssh_bootstrap"
}
"#;

const BASH_RC: &str = r#"[ -r /etc/profile ] && . /etc/profile
if [ -r "$HOME/.bash_profile" ]; then
  . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then
  . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then
  . "$HOME/.profile"
elif [ -r "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi
[ -r "${OUTPOST_SSH_BRIDGE_DIR}/ssh-hook.sh" ] && . "${OUTPOST_SSH_BRIDGE_DIR}/ssh-hook.sh"
"#;

const WSL_SHELL: &str = r#"s="${SHELL:-}"
[ -z "$s" ] && s="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)"
[ -x "$s" ] || s="/bin/sh"
export SHELL="$s"
case "${s##*/}" in
  bash) exec "$s" --rcfile "$OUTPOST_SSH_BRIDGE_DIR/bash.rc" -i ;;
  zsh)
    [ -n "${ZDOTDIR:-}" ] && export OUTPOST_ORIG_ZDOTDIR="$ZDOTDIR"
    export ZDOTDIR="$OUTPOST_SSH_BRIDGE_DIR/zsh"
    exec "$s" -l
    ;;
  fish)
    export XDG_DATA_DIRS="$OUTPOST_SSH_BRIDGE_DIR:${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    exec "$s" -l
    ;;
  *) exec "$s" -l ;;
esac
"#;

const ZSH_ZSHENV: &str = r#"__outpost_orig_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"
if [ -r "$__outpost_orig_zdotdir/.zshenv" ]; then
  ZDOTDIR="$__outpost_orig_zdotdir" . "$__outpost_orig_zdotdir/.zshenv"
fi
"#;

const ZSH_ZPROFILE: &str = r#"__outpost_orig_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"
if [ -r "$__outpost_orig_zdotdir/.zprofile" ]; then
  ZDOTDIR="$__outpost_orig_zdotdir" . "$__outpost_orig_zdotdir/.zprofile"
fi
"#;

const ZSH_ZSHRC: &str = r#"__outpost_orig_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"
if [ -r "$__outpost_orig_zdotdir/.zshrc" ]; then
  ZDOTDIR="$__outpost_orig_zdotdir" . "$__outpost_orig_zdotdir/.zshrc"
fi
[ -r "${OUTPOST_SSH_BRIDGE_DIR}/ssh-hook.sh" ] && . "${OUTPOST_SSH_BRIDGE_DIR}/ssh-hook.sh"
"#;

const ZSH_ZLOGIN: &str = r#"__outpost_orig_zdotdir="${OUTPOST_ORIG_ZDOTDIR:-$HOME}"
if [ -n "${OUTPOST_ORIG_ZDOTDIR:-}" ]; then
  export ZDOTDIR="$OUTPOST_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset OUTPOST_ORIG_ZDOTDIR
if [ -r "$__outpost_orig_zdotdir/.zlogin" ]; then
  . "$__outpost_orig_zdotdir/.zlogin"
fi
unset __outpost_orig_zdotdir
"#;

const FISH_HOOK: &str = r#"function ssh --wraps ssh
  if test "$OUTPOST_DISABLE_SSH_BRIDGE" = "1"; or not isatty stdin; or not isatty stdout
    command ssh $argv
    return $status
  end
  set -l dest ""
  set -l skip 0
  set -l opt_o 0
  set -l passthrough 0
  for arg in $argv
    if test $skip -eq 1
      if test $opt_o -eq 1
        if string match -qir '^(remotecommand|requesttty=no)' -- $arg
          set passthrough 1
          break
        end
        set opt_o 0
      end
      set skip 0
      continue
    end
    if test -n "$dest"
      set passthrough 1
      break
    end
    if test "$arg" = "--"
      set passthrough 1
      break
    else if string match -q -- '-*' $arg
      set -l rest (string sub -s 2 -- $arg)
      while test -n "$rest"
        set -l ch (string sub -l 1 -- $rest)
        set rest (string sub -s 2 -- $rest)
        if contains -- $ch G N O T V W f M s
          set passthrough 1
          break
        else if test "$ch" = "o"
          if test -z "$rest"
            set skip 1
            set opt_o 1
          else if string match -qir '^(remotecommand|requesttty=no)' -- $rest
            set passthrough 1
          end
          break
        else if contains -- $ch B b c D E e F I i J L l m p Q R S w
          if test -z "$rest"
            set skip 1
          end
          break
        end
      end
      if test $passthrough -eq 1
        break
      end
    else
      set dest $arg
    end
  end
  if test $passthrough -eq 1; or test -z "$dest"; or string match -qr '^(git|hg|svn)@' -- $dest
    command ssh $argv
    return $status
  end
  command ssh -t $argv '__OUTPOST_REMOTE_BOOTSTRAP__'
end
"#;

const PWSH_INIT: &str = r#"function global:__OutpostResolveRealSsh {
  $cmd = Get-Command ssh -CommandType Application -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike '*\ssh-bridge\*' } |
    Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  return 'ssh.exe'
}

function global:__OutpostInvokeSsh {
  param([string[]]$SshArgs)
  $realSsh = __OutpostResolveRealSsh
  if ($env:OUTPOST_DISABLE_SSH_BRIDGE -eq '1' -or [Console]::IsInputRedirected -or [Console]::IsOutputRedirected) {
    & $realSsh @SshArgs
    return
  }
  $dest = $null
  $skip = $false
  $optO = $false
  $passthrough = $false
  foreach ($arg in $SshArgs) {
    if ($skip) {
      if ($optO) {
        if ($arg -match '^(?i)(RemoteCommand|RequestTTY=no)') { $passthrough = $true; break }
        $optO = $false
      }
      $skip = $false
      continue
    }
    if ($null -ne $dest) { $passthrough = $true; break }
    if ($arg -eq '--') { $passthrough = $true; break }
    if ($arg.StartsWith('-') -and $arg.Length -gt 1) {
      $rest = $arg.Substring(1)
      for ($i = 0; $i -lt $rest.Length; $i++) {
        $ch = $rest[$i]
        if ('GNOTVWfMs'.IndexOf($ch) -ge 0) { $passthrough = $true; break }
        if ($ch -eq 'o') {
          if ($i + 1 -ge $rest.Length) { $skip = $true; $optO = $true }
          elseif ($rest.Substring($i + 1) -match '^(?i)(RemoteCommand|RequestTTY=no)') { $passthrough = $true }
          break
        }
        if ('BbcDEeFIiJLlmopQRSw'.IndexOf($ch) -ge 0) {
          if ($i + 1 -ge $rest.Length) { $skip = $true }
          break
        }
      }
      if ($passthrough) { break }
    } else {
      $dest = $arg
    }
  }
  if ($passthrough -or -not $dest -or $dest -match '^(?i)(git|hg|svn)@') {
    & $realSsh @SshArgs
    return
  }
  $bootstrap = '__OUTPOST_REMOTE_BOOTSTRAP__'
  & $realSsh -t @SshArgs $bootstrap
}

function global:ssh {
  __OutpostInvokeSsh -SshArgs $args
}
"#;

const PWSH_CMD_RUNNER: &str = r#". "$PSScriptRoot\pwsh-init.ps1"
__OutpostInvokeSsh -SshArgs $args
exit $LASTEXITCODE
"#;

const CMD_SSH_SHIM: &str = "@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File \"%~dp0..\\ssh-cmd.ps1\" %*\r\n";

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::read_to_string(path).ok().as_deref() == Some(content) {
        return Ok(());
    }
    fs::write(path, content)
}

fn render_hook(template: &str) -> String {
    template.replace("__OUTPOST_REMOTE_BOOTSTRAP__", REMOTE_BOOTSTRAP)
}

fn ensure_bridge_files(dir: &Path) -> std::io::Result<()> {
    write_if_changed(&dir.join("ssh-hook.sh"), &render_hook(POSIX_SSH_HOOK))?;
    write_if_changed(&dir.join("bash.rc"), BASH_RC)?;
    write_if_changed(&dir.join("wsl-shell.sh"), WSL_SHELL)?;
    write_if_changed(&dir.join("zsh/.zshenv"), ZSH_ZSHENV)?;
    write_if_changed(&dir.join("zsh/.zprofile"), ZSH_ZPROFILE)?;
    write_if_changed(&dir.join("zsh/.zshrc"), ZSH_ZSHRC)?;
    write_if_changed(&dir.join("zsh/.zlogin"), ZSH_ZLOGIN)?;
    write_if_changed(
        &dir.join("fish/vendor_conf.d/outpost-ssh.fish"),
        &render_hook(FISH_HOOK),
    )?;
    if cfg!(windows) {
        write_if_changed(&dir.join("pwsh-init.ps1"), &render_hook(PWSH_INIT))?;
        write_if_changed(&dir.join("ssh-cmd.ps1"), PWSH_CMD_RUNNER)?;
        write_if_changed(&dir.join("win-bin/ssh.cmd"), CMD_SSH_SHIM)?;
    }
    Ok(())
}

/// Build a configured `CommandBuilder` for a local shell PTY.
/// When the SSH bridge is enabled, injects the shell-appropriate `ssh` hook while
/// preserving normal user shell initialization.
pub fn build_local_command(shell: &str, args: &[String], dir: &Path) -> CommandBuilder {
    let default_cmd = || {
        let mut command = CommandBuilder::new(shell);
        command.args(args);
        command.cwd(dir);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command
    };
    if !is_enabled() {
        return default_cmd();
    }
    let bridge_dir = crate::bridge::data_dir().join("ssh-bridge");
    if ensure_bridge_files(&bridge_dir).is_err() {
        return default_cmd();
    }

    let name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut command = CommandBuilder::new(shell);
    command.cwd(dir);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    match name.as_str() {
        "bash" if args == ["-l"] => {
            command.env("OUTPOST_SSH_BRIDGE_DIR", &bridge_dir);
            command.args([
                "--rcfile",
                &bridge_dir.join("bash.rc").to_string_lossy(),
                "-i",
            ]);
        }
        "zsh" => {
            command.env("OUTPOST_SSH_BRIDGE_DIR", &bridge_dir);
            if let Ok(orig) = std::env::var("ZDOTDIR") {
                command.env("OUTPOST_ORIG_ZDOTDIR", orig);
            }
            command.env("ZDOTDIR", bridge_dir.join("zsh"));
            command.args(args);
        }
        "fish" => {
            command.env("OUTPOST_SSH_BRIDGE_DIR", &bridge_dir);
            let existing = std::env::var("XDG_DATA_DIRS")
                .unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
            command.env(
                "XDG_DATA_DIRS",
                format!("{}:{existing}", bridge_dir.to_string_lossy()),
            );
            command.args(args);
        }
        "pwsh.exe" | "powershell.exe" | "pwsh" | "powershell" => {
            let init_script = bridge_dir.join("pwsh-init.ps1");
            let escaped = init_script.to_string_lossy().replace('\'', "''");
            command.args(args);
            command.args([
                "-NoExit",
                "-Command",
                &format!("Invoke-Expression ([System.IO.File]::ReadAllText('{escaped}'))"),
            ]);
        }
        "cmd.exe" | "cmd" => {
            let win_bin = bridge_dir.join("win-bin");
            let path = std::env::var_os("PATH").unwrap_or_default();
            let mut next_path = win_bin.into_os_string();
            if !path.is_empty() {
                next_path.push(";");
                next_path.push(path);
            }
            command.env("PATH", next_path);
            command.args(args);
        }
        "wsl.exe" | "wsl" if args == ["--cd", "~"] => {
            // Translate the Windows bridge directory into WSL via WSLENV `/p` so WSL reuses
            // the exact same POSIX shell init files as macOS/Linux.
            // Use `-e /bin/sh` (not `--`) so wsl.exe execs directly without an outer shell
            // stripping quotes or expanding variables prematurely.
            command.env("OUTPOST_SSH_BRIDGE_DIR", &bridge_dir);
            let wslenv = match std::env::var("WSLENV") {
                Ok(existing) if !existing.is_empty() => {
                    format!("{existing}:OUTPOST_SSH_BRIDGE_DIR/p:OUTPOST_DISABLE_SSH_BRIDGE")
                }
                _ => "OUTPOST_SSH_BRIDGE_DIR/p:OUTPOST_DISABLE_SSH_BRIDGE".into(),
            };
            command.env("WSLENV", wslenv);
            command.args(args);
            command.args([
                "-e",
                "/bin/sh",
                "-c",
                r#"exec /bin/sh "$OUTPOST_SSH_BRIDGE_DIR/wsl-shell.sh""#,
            ]);
        }
        _ => {
            command.args(args);
        }
    }

    command
}

/// Expose remote bootstrap string for unit tests so all shells stay in sync.
#[cfg(test)]
pub(crate) fn remote_bootstrap() -> &'static str {
    REMOTE_BOOTSTRAP
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_shell_hooks_embed_the_same_remote_bootstrap() {
        let bootstrap = remote_bootstrap();
        assert!(render_hook(POSIX_SSH_HOOK).contains(bootstrap));
        assert!(render_hook(FISH_HOOK).contains(bootstrap));
        assert!(render_hook(PWSH_INIT).contains(bootstrap));
    }

    #[test]
    fn bridge_files_are_lf_and_written_idempotently() {
        let dir = tempfile::tempdir().unwrap();
        ensure_bridge_files(dir.path()).unwrap();
        ensure_bridge_files(dir.path()).unwrap();
        for rel in [
            "ssh-hook.sh",
            "bash.rc",
            "wsl-shell.sh",
            "zsh/.zshenv",
            "zsh/.zprofile",
            "zsh/.zshrc",
            "zsh/.zlogin",
            "fish/vendor_conf.d/outpost-ssh.fish",
        ] {
            let text = fs::read_to_string(dir.path().join(rel)).unwrap();
            assert!(!text.contains('\r'), "{rel} must use LF line endings");
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore]
    fn live_windows_shells_start_cleanly_with_ssh_hook() {
        use crate::pty::{Local, Output};
        use std::time::{Duration, Instant};

        fn run_pty(shell: &str, args: &[&str], probe: &[u8], expected: &str) {
            let owned: Vec<String> = args.iter().map(|s| (*s).into()).collect();
            let (pty, rx) =
                Local::open(shell, &owned, &std::env::temp_dir(), 120, 30).expect("open local pty");
            std::thread::sleep(Duration::from_millis(800));
            pty.send(probe.to_vec()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(6);
            let mut buf = Vec::new();
            while Instant::now() < deadline {
                if let Ok(out) = rx.try_recv() {
                    match out {
                        Output::Bytes(b) => {
                            if b.windows(4).any(|w| w == b"\x1b[6n") {
                                let _ = pty.send(b"\x1b[1;1R".to_vec());
                            }
                            buf.extend_from_slice(&b);
                            let text = String::from_utf8_lossy(&buf);
                            if text.contains(expected) {
                                return;
                            }
                        }
                        Output::Closed(reason) => {
                            panic!(
                                "PTY for {shell} exited early ({reason}); output:\n{:?}",
                                String::from_utf8_lossy(&buf)
                            );
                        }
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            panic!(
                "Did not find {expected:?} in {shell} output (len={}):\n{:?}",
                buf.len(),
                String::from_utf8_lossy(&buf)
            );
        }

        run_pty(
            "C:\\Windows\\System32\\wsl.exe",
            &["--cd", "~"],
            b"type ssh; exit\r",
            "ssh is a function",
        );
        run_pty(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
            &["-NoLogo"],
            b"(Get-Command ssh).CommandType; exit\r",
            "Function",
        );

        // Verify large multi-chunk PUA UTF-8 input frames (matching a full 4-chunk image window)
        // pass byte-for-byte through Windows ConPTY -> WSL without truncation or corruption.
        {
            let chunk_body = "A".repeat(29_000);
            let frame = format!("\u{E077}outpost;ssh;{chunk_body}\u{E078}");
            let total_frames = 4usize;
            let total_bytes = frame.len() * total_frames;
            let script = format!(
                "import sys,tty,termios; fd=0; old=termios.tcgetattr(fd); tty.setraw(fd); print('READY', flush=True); buf=bytearray();\nwhile len(buf)<{total_bytes}:\n d=sys.stdin.buffer.read({total_bytes}-len(buf))\n if not d: break\n buf.extend(d)\ntermios.tcsetattr(fd, termios.TCSADRAIN, old); exp=('\\ue077outpost;ssh;' + 'A'*29000 + '\\ue078').encode('utf-8')*{total_frames}; print('EXACT:' + str(bytes(buf)==exp) + ':' + str(len(buf)), flush=True)"
            );
            let (pty, rx) = Local::open(
                "C:\\Windows\\System32\\wsl.exe",
                &["-e".into(), "python3".into(), "-c".into(), script],
                &std::env::temp_dir(),
                120,
                30,
            )
            .expect("open wsl probe");
            let deadline = Instant::now() + Duration::from_secs(10);
            let mut buf = Vec::new();
            let mut sent = false;
            while Instant::now() < deadline {
                if let Ok(out) = rx.try_recv() {
                    match out {
                        Output::Bytes(b) => {
                            if b.windows(4).any(|w| w == b"\x1b[6n") {
                                let _ = pty.send(b"\x1b[1;1R".to_vec());
                            }
                            buf.extend_from_slice(&b);
                            let s = String::from_utf8_lossy(&buf);
                            if !sent && s.contains("READY") {
                                sent = true;
                                for _ in 0..total_frames {
                                    pty.send(frame.as_bytes().to_vec()).unwrap();
                                }
                            }
                            if s.contains(&format!("EXACT:True:{total_bytes}")) {
                                return;
                            }
                        }
                        Output::Closed(_) => break,
                    }
                } else {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            panic!(
                "ConPTY did not forward {total_bytes} bytes of PUA frames verbatim: {:?}",
                String::from_utf8_lossy(&buf)
            );
        }
    }
}

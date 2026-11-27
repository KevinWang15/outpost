use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
};

pub fn data_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("OUTPOST_DESKTOP_DATA_DIR") {
        return p.into();
    }
    directories::BaseDirs::new()
        .expect("user data directory")
        .config_dir()
        .join("Outpost")
}
#[derive(Clone)]
pub struct Bridge {
    send: async_channel::Sender<Value>,
}
pub struct HelperProcess {
    child: Child,
    commands: async_channel::Sender<Value>,
    events: async_channel::Sender<Value>,
}
impl HelperProcess {
    pub fn shutdown(&mut self) -> Result<()> {
        // Drain queued commands and close stdin. Stop forwarding UI events while
        // the main thread waits, but keep reading stdout so the helper can finish.
        self.commands.close();
        self.events.close();
        let status = self.child.wait()?;
        anyhow::ensure!(
            status.success(),
            "Outpost session helper exited with {status}"
        );
        Ok(())
    }
}
impl Bridge {
    pub fn start() -> Result<(Self, async_channel::Receiver<Value>, HelperProcess)> {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().context("Executable directory")?;
        let resource = if cfg!(target_os = "macos") {
            dir.join("../Resources")
        } else {
            dir.join("resources")
        };
        let packaged = resource.join("outpost-helper.cjs");
        let (node, helper) = if packaged.is_file() {
            (
                resource.join(if cfg!(windows) { "node.exe" } else { "node" }),
                packaged,
            )
        } else {
            let helper = Path::new(env!("CARGO_MANIFEST_DIR")).join("dist/outpost-helper.cjs");
            anyhow::ensure!(
                helper.is_file(),
                "Build the session helper with npm --prefix desktop run helper"
            );
            (PathBuf::from("node"), helper)
        };
        let mut cmd = Command::new(node);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        cmd.arg(helper).arg(data_dir());
        Self::spawn(cmd)
    }
    fn spawn(mut cmd: Command) -> Result<(Self, async_channel::Receiver<Value>, HelperProcess)> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let mut stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (send, requests) = async_channel::unbounded::<Value>();
        let (tx, rx) = async_channel::bounded(128);
        thread::spawn(move || {
            while let Ok(request) = requests.recv_blocking() {
                if serde_json::to_writer(&mut stdin, &request).is_err()
                    || stdin.write_all(b"\n").and_then(|_| stdin.flush()).is_err()
                {
                    break;
                }
            }
        });
        let process = HelperProcess {
            child,
            commands: send.clone(),
            events: tx.clone(),
        };
        thread::spawn(move || {
            let mut last_was_error = false;
            for line in stdout.lines().map_while(Result::ok) {
                if !tx.is_closed()
                    && let Ok(event) = serde_json::from_str::<Value>(&line)
                {
                    last_was_error = event["event"] == "error";
                    let _ = tx.send_blocking(event);
                }
            }
            if !last_was_error {
                let _ = tx.send_blocking(
                    serde_json::json!({"event":"error","message":"The Outpost session helper stopped."}),
                );
            }
        });
        Ok((Self { send }, rx, process))
    }
    #[cfg(feature = "ui-tests")]
    pub fn recording() -> (Self, async_channel::Receiver<Value>) {
        let (send, commands) = async_channel::unbounded();
        (Self { send }, commands)
    }
    pub fn call(&self, value: Value) {
        let _ = self.send.try_send(value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quit_drains_commands_even_with_a_full_ui_event_queue() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let result = dir.path().join("result");
        let mut cmd = Command::new("node");
        cmd.arg("-e").arg(r#"
            const lines = require('node:readline').createInterface({input: process.stdin})
            const received = []
            for (let i = 0; i < 512; i++) console.log(JSON.stringify({event: 'output'}))
            lines.on('line', line => received.push(JSON.parse(line)))
            lines.on('close', () => require('node:fs').writeFileSync(process.argv[1], JSON.stringify(received)))
        "#).arg(&result);
        let (bridge, _events, mut process) = Bridge::spawn(cmd)?;
        let commands: Vec<_> = (0..512).map(Value::from).collect();
        for command in &commands {
            bridge.call(command.clone());
        }
        process.shutdown()?;
        let written: Vec<Value> = serde_json::from_slice(&std::fs::read(result)?)?;
        assert_eq!(written, commands);
        Ok(())
    }
}

use anyhow::{Context, Result};
use serde_json::Value;
use std::{
    io::{BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, mpsc},
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
    send: mpsc::Sender<Value>,
    _child: Arc<ChildGuard>,
}
struct ChildGuard(Mutex<Child>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Ok(child) = self.0.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Bridge {
    pub fn start() -> Result<(Self, async_channel::Receiver<Value>)> {
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
        let mut child = cmd
            .arg(helper)
            .arg(data_dir())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let mut stdin = BufWriter::new(child.stdin.take().unwrap());
        let stdout = BufReader::new(child.stdout.take().unwrap());
        let (send, requests) = mpsc::channel::<Value>();
        let (tx, rx) = async_channel::bounded(128);
        thread::spawn(move || {
            for request in requests {
                if serde_json::to_writer(&mut stdin, &request).is_err()
                    || stdin.write_all(b"\n").and_then(|_| stdin.flush()).is_err()
                {
                    break;
                }
            }
        });
        thread::spawn(move || {
            for line in stdout.lines().map_while(Result::ok) {
                if let Ok(event) = serde_json::from_str(&line)
                    && tx.send_blocking(event).is_err()
                {
                    return;
                }
            }
            let _=tx.send_blocking(serde_json::json!({"event":"error","message":"The Outpost session helper stopped."}));
        });
        Ok((
            Self {
                send,
                _child: Arc::new(ChildGuard(Mutex::new(child))),
            },
            rx,
        ))
    }
    pub fn call(&self, value: Value) {
        let _ = self.send.send(value);
    }
}

use anyhow::{Context, Result};
use portable_pty::{ChildKiller, MasterPty, PtySize, native_pty_system};
use std::{
    io::{Read, Write},
    path::Path,
    sync::mpsc,
    thread,
};

pub enum Output {
    Bytes(Vec<u8>),
    Closed(String),
}

pub struct Local {
    master: Box<dyn MasterPty + Send>,
    input: Option<mpsc::SyncSender<Vec<u8>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}
impl Local {
    pub fn open(
        shell: &str,
        args: &[String],
        dir: &Path,
        cols: u16,
        rows: u16,
    ) -> Result<(Self, async_channel::Receiver<Output>)> {
        let pair = native_pty_system().openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let command = crate::ssh_bridge::build_local_command(shell, args, dir);
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let mut child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("Could not start {shell}"))?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let (output, rx) = async_channel::bounded(32);
        let (input, commands) = mpsc::sync_channel::<Vec<u8>>(128);
        thread::spawn(move || {
            for bytes in commands {
                if writer
                    .write_all(&bytes)
                    .and_then(|_| writer.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        thread::spawn(move || {
            let mut buf = [0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if output
                            .send_blocking(Output::Bytes(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let reason = match child.wait() {
                Ok(s) => format!("Shell exited ({s})"),
                Err(e) => e.to_string(),
            };
            let _ = output.send_blocking(Output::Closed(reason));
        });
        Ok((
            Self {
                master: pair.master,
                input: Some(input),
                killer,
            },
            rx,
        ))
    }
    pub fn send(&self, bytes: Vec<u8>) -> Result<()> {
        if let Some(tx) = &self.input {
            tx.try_send(bytes)
                .map_err(|_| anyhow::anyhow!("Shell input queue unavailable"))?;
        }
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }
}
impl Drop for Local {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.killer.kill();
    }
}

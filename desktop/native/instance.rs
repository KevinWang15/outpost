// Protocol handlers on Windows are launched as a second process. Forward the
// link to the process which owns the account's in-memory sign-in verifier.
use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream},
    path::Path,
    thread,
    time::Duration,
};

#[derive(Deserialize, Serialize)]
struct Address {
    port: u16,
    cookie: String,
}
#[derive(Deserialize, Serialize)]
struct Request {
    cookie: String,
    links: Vec<String>,
}
pub fn claim(
    dir: &Path,
    links: Vec<String>,
    tx: async_channel::Sender<String>,
) -> Result<Option<File>> {
    fs::create_dir_all(dir)?;
    let owner = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .read(true)
        .open(dir.join("desktop.lock"))?;
    let descriptor = dir.join("desktop-instance.json");
    match owner.try_lock() {
        Err(TryLockError::WouldBlock) => {
            for _ in 0..40 {
                let send = || -> Result<()> {
                    let peer: Address = serde_json::from_slice(&fs::read(&descriptor)?)?;
                    let mut stream = TcpStream::connect_timeout(
                        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, peer.port).into(),
                        Duration::from_millis(300),
                    )?;
                    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                    serde_json::to_writer(
                        &mut stream,
                        &Request {
                            cookie: peer.cookie,
                            links: links.clone(),
                        },
                    )?;
                    stream.write_all(b"\n")?;
                    let mut ack = [0];
                    stream.read_exact(&mut ack)?;
                    anyhow::ensure!(ack == [1], "Rejected desktop handoff");
                    Ok(())
                };
                if send().is_ok() {
                    return Ok(None);
                }
                thread::sleep(Duration::from_millis(50))
            }
            bail!("The running Outpost window did not accept the link.")
        }
        Err(TryLockError::Error(e)) => return Err(e.into()),
        Ok(()) => {}
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|e| anyhow::anyhow!("{e}"))?;
    let addr = Address {
        port: listener.local_addr()?.port(),
        cookie: URL_SAFE_NO_PAD.encode(random),
    };
    let mut temp = tempfile::NamedTempFile::new_in(dir)?;
    serde_json::to_writer(&mut temp, &addr)?;
    temp.persist(&descriptor)
        .context("Publish desktop instance")?;
    for link in links {
        let _ = tx.try_send(link);
    }
    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut line = String::new();
            if BufReader::new((&stream).take(32769))
                .read_line(&mut line)
                .is_ok()
                && line.len() <= 32768
                && let Ok(req) = serde_json::from_str::<Request>(&line)
                && req.cookie == addr.cookie
                && req.links.len() <= 8
                && req
                    .links
                    .iter()
                    .all(|s| s.starts_with("outpost://") && s.len() <= 8192)
            {
                if req.links.is_empty() {
                    let _ = tx.try_send(String::new());
                }
                for link in req.links {
                    let _ = tx.try_send(link);
                }
                let _ = stream.write_all(&[1]);
            }
        }
    });
    Ok(Some(owner))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn second_instance_forwards_to_profile_owner() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let (tx, rx) = async_channel::unbounded();
        let owner = claim(dir.path(), vec![], tx.clone())?;
        assert!(owner.is_some());
        let link = "outpost://server?origin=https%3A%2F%2Fexample.com&account=test".to_owned();
        assert!(claim(dir.path(), vec![link.clone()], tx)?.is_none());
        assert_eq!(rx.recv_blocking()?, link);
        Ok(())
    }
}

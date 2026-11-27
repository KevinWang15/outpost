//! Per-pane SSH bridge session + flow-controlled image paste state machine.

use super::protocol::{
    DEFAULT_IMAGE_CHUNK_BYTES, IMAGE_WINDOW_CHUNKS, SshDesktopMessage, SshRemoteMessage,
    encode_ssh_bridge_input,
};
use base64::{Engine, engine::general_purpose::STANDARD};

#[derive(Clone, Debug)]
struct ActiveSession {
    nonce: String,
    #[allow(dead_code)]
    tool: String,
    #[allow(dead_code)]
    clipboard: bool,
}

struct ActiveTransfer {
    id: String,
    bytes: Vec<u8>,
    chunk_size: usize,
    acked: usize,
    sent: usize,
    generation: u64,
}

/// Actions produced by the pure state machine for `Pane` to apply to the PTY / UI.
#[derive(Default)]
pub struct SshBridgeActions {
    pub send_frames: Vec<Vec<u8>>,
    pub notice: Option<String>,
    pub error: Option<String>,
    pub clear_activity: bool,
    pub schedule_timeout: Option<(u64, std::time::Duration)>,
}

#[derive(Default)]
pub struct SshBridgePane {
    session: Option<ActiveSession>,
    transfer: Option<ActiveTransfer>,
    serial: u64,
}

impl SshBridgePane {
    pub fn is_active(&self) -> bool {
        self.session.is_some()
    }

    pub fn clear(&mut self) {
        self.session = None;
        self.transfer = None;
    }

    pub fn begin_paste(
        &mut self,
        mime: &str,
        bytes: Vec<u8>,
        as_path: bool,
    ) -> Result<(u64, Vec<u8>), String> {
        let Some(session) = &self.session else {
            return Err("No SSH coding session is active in this terminal.".into());
        };
        if self.transfer.is_some() {
            return Err("Wait for the previous image to finish.".into());
        }
        self.serial = self.serial.wrapping_add(1);
        let generation = self.serial;
        let id = format!("img-{generation}");
        let size = bytes.len();
        let frame = encode_ssh_bridge_input(&SshDesktopMessage::ImgBegin {
            v: 1,
            session: &session.nonce,
            id: &id,
            mime,
            size,
            mode: if as_path { "path" } else { "attachment" },
        });
        self.transfer = Some(ActiveTransfer {
            id,
            bytes,
            chunk_size: DEFAULT_IMAGE_CHUNK_BYTES,
            acked: 0,
            sent: 0,
            generation,
        });
        Ok((generation, frame))
    }

    pub fn on_timeout(&mut self, generation: u64) -> Option<(Option<Vec<u8>>, String)> {
        let transfer = self.transfer.as_ref()?;
        if transfer.generation != generation {
            return None;
        }
        let transfer = self.transfer.take().unwrap();
        let waiting_for_handshake = transfer.sent == 0 && transfer.acked == 0;
        if waiting_for_handshake {
            // The wrapper did not acknowledge the handshake in time; clear stale session state
            // so future pastes do not send control frames into an exited shell.
            self.session = None;
            return Some((
                None,
                "The remote SSH session did not answer the image paste request.".into(),
            ));
        }
        let cancel = encode_ssh_bridge_input(&SshDesktopMessage::ImgCancel {
            v: 1,
            id: &transfer.id,
        });
        Some((
            Some(cancel),
            "Image upload timed out. Try pasting again.".into(),
        ))
    }

    pub fn handle_remote(&mut self, msg: SshRemoteMessage) -> SshBridgeActions {
        let mut actions = SshBridgeActions::default();
        match msg {
            SshRemoteMessage::Ready {
                session,
                tool,
                clipboard,
            } => {
                self.transfer = None;
                self.session = Some(ActiveSession {
                    nonce: session,
                    tool,
                    clipboard,
                });
            }
            SshRemoteMessage::Bye { session } => {
                if self.session.as_ref().is_some_and(|s| s.nonce == session) {
                    self.session = None;
                    if self.transfer.take().is_some() {
                        actions.error =
                            Some("The coding tool exited before the image paste finished.".into());
                    }
                    actions.clear_activity = true;
                }
            }
            SshRemoteMessage::Shell => {
                // The remote shell prompt regained control (e.g. after SIGKILL on the wrapper).
                if self.session.take().is_some() {
                    if self.transfer.take().is_some() {
                        actions.error =
                            Some("The coding tool exited before the image paste finished.".into());
                    }
                    actions.clear_activity = true;
                }
            }
            SshRemoteMessage::ImgAck {
                id,
                next,
                chunk_size,
            } => {
                let Some(transfer) = self.transfer.as_mut() else {
                    return actions;
                };
                if transfer.id != id {
                    return actions;
                }
                if let Some(sz) = chunk_size {
                    transfer.chunk_size = sz.clamp(512, DEFAULT_IMAGE_CHUNK_BYTES);
                }
                transfer.acked = transfer.acked.max(next.min(transfer.bytes.len()));
                let window = transfer.chunk_size * IMAGE_WINDOW_CHUNKS;
                while transfer.sent < transfer.bytes.len()
                    && transfer.sent.saturating_sub(transfer.acked) < window
                {
                    let end = (transfer.sent + transfer.chunk_size).min(transfer.bytes.len());
                    let data = STANDARD.encode(&transfer.bytes[transfer.sent..end]);
                    actions.send_frames.push(encode_ssh_bridge_input(
                        &SshDesktopMessage::ImgData {
                            v: 1,
                            id: &transfer.id,
                            offset: transfer.sent,
                            data: &data,
                        },
                    ));
                    transfer.sent = end;
                }
                // Refresh timeout for the next ack or final paste completion.
                let timeout = if transfer.sent >= transfer.bytes.len() {
                    std::time::Duration::from_secs(15)
                } else {
                    std::time::Duration::from_secs(10)
                };
                actions.schedule_timeout = Some((transfer.generation, timeout));
            }
            SshRemoteMessage::ImgDone {
                id,
                ok,
                mode,
                message,
            } => {
                let matches = self.transfer.as_ref().is_some_and(|t| t.id == id);
                if !matches {
                    return actions;
                }
                self.transfer = None;
                if ok {
                    actions.notice = Some(if mode.as_deref() == Some("path") {
                        "Image path pasted".into()
                    } else {
                        "Image attached".into()
                    });
                } else {
                    actions.error = Some(message.unwrap_or_else(|| "Image paste failed.".into()));
                }
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_sliding_window_paste_succeeds_and_shell_clears_session() {
        let mut pane = SshBridgePane::default();
        assert!(!pane.is_active());

        pane.handle_remote(SshRemoteMessage::Ready {
            session: "nonce1".into(),
            tool: "claude".into(),
            clipboard: true,
        });
        assert!(pane.is_active());

        let payload = vec![0x89u8; 50_000];
        let (gen_id, begin_frame) = pane
            .begin_paste("image/png", payload.clone(), false)
            .unwrap();
        assert!(begin_frame.starts_with("\u{E077}outpost;ssh;".as_bytes()));

        // Initial ack with 16 KiB chunks fills a 4-chunk window (all 4 chunks for 50 KiB).
        let actions = pane.handle_remote(SshRemoteMessage::ImgAck {
            id: format!("img-{gen_id}"),
            next: 0,
            chunk_size: Some(16_384),
        });
        assert_eq!(actions.send_frames.len(), 4);

        let done = pane.handle_remote(SshRemoteMessage::ImgDone {
            id: format!("img-{gen_id}"),
            ok: true,
            mode: Some("attachment".into()),
            message: None,
        });
        assert_eq!(done.notice.as_deref(), Some("Image attached"));

        // Shell prompt clears active wrapper state (SIGKILL recovery).
        let shell = pane.handle_remote(SshRemoteMessage::Shell);
        assert!(shell.clear_activity);
        assert!(!pane.is_active());
    }
}

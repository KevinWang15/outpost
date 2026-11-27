//! Wire protocol for the experimental interactive SSH bridge.
//! Mirrors `shared/sshBridgeProtocol.ts`:
//!   - Remote -> Desktop (PTY output): `ESC ] 7770 ; outpost ; ssh ; <base64url-json> (BEL | ST)`
//!   - Desktop -> Remote (PTY input):  `\u{E077}outpost;ssh;<base64url-json>\u{E078}`

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};

pub const SSH_BRIDGE_PREFIX: &str = "outpost;ssh;";
/// UTF-8 Private Use Area delimiters for Desktop -> Remote PTY input frames.
/// Windows ConPTY swallows `ESC ] ...` OSC sequences on input, whereas PUA UTF-8 passes
/// byte-for-byte through Windows ConPTY, WSL, macOS, and Linux PTYs with 0ms Escape latency.
const SSH_BRIDGE_INPUT_START: char = '\u{E077}';
const SSH_BRIDGE_INPUT_END: char = '\u{E078}';
pub const MAX_SSH_BRIDGE_PAYLOAD_BYTES: usize = 32 * 1024;
pub const DEFAULT_IMAGE_CHUNK_BYTES: usize = 16 * 1024;
pub const IMAGE_WINDOW_CHUNKS: usize = 4;
const MAX_IMAGE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SshRemoteMessage {
    Ready {
        session: String,
        tool: String,
        clipboard: bool,
    },
    Bye {
        session: String,
    },
    Shell,
    ImgAck {
        id: String,
        next: usize,
        chunk_size: Option<usize>,
    },
    ImgDone {
        id: String,
        ok: bool,
        mode: Option<String>,
        message: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "t")]
pub enum SshDesktopMessage<'a> {
    #[serde(rename = "img.begin")]
    ImgBegin {
        v: u32,
        session: &'a str,
        id: &'a str,
        mime: &'a str,
        size: usize,
        mode: &'a str,
    },
    #[serde(rename = "img.data")]
    ImgData {
        v: u32,
        id: &'a str,
        offset: usize,
        data: &'a str,
    },
    #[serde(rename = "img.cancel")]
    ImgCancel { v: u32, id: &'a str },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRemote {
    v: u32,
    t: String,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    clipboard: Option<bool>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    next: Option<usize>,
    #[serde(default)]
    chunk_size: Option<usize>,
    #[serde(default)]
    ok: Option<bool>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_tool(value: &str) -> bool {
    matches!(
        value,
        "claude" | "codex" | "kimi" | "deepseek" | "antigravity"
    )
}

pub fn parse_ssh_bridge_payload(data: &str) -> Option<SshRemoteMessage> {
    if data.len() > MAX_SSH_BRIDGE_PAYLOAD_BYTES {
        return None;
    }
    let encoded = data.strip_prefix(SSH_BRIDGE_PREFIX)?.trim_end_matches('=');
    if encoded.is_empty() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let wire: WireRemote = serde_json::from_slice(&decoded).ok()?;
    if wire.v != 1 {
        return None;
    }
    match wire.t.as_str() {
        "ready" => {
            let session = wire.session.filter(|s| valid_id(s))?;
            let tool = wire.tool.filter(|t| valid_tool(t))?;
            let clipboard = wire.clipboard?;
            Some(SshRemoteMessage::Ready {
                session,
                tool,
                clipboard,
            })
        }
        "bye" => {
            let session = wire.session.filter(|s| valid_id(s))?;
            Some(SshRemoteMessage::Bye { session })
        }
        "shell" => Some(SshRemoteMessage::Shell),
        "img.ack" => {
            let id = wire.id.filter(|s| valid_id(s))?;
            let next = wire.next.filter(|&n| n <= MAX_IMAGE_BYTES)?;
            let chunk_size = match wire.chunk_size {
                Some(sz) if (512..=DEFAULT_IMAGE_CHUNK_BYTES).contains(&sz) => Some(sz),
                Some(_) => return None,
                None => None,
            };
            Some(SshRemoteMessage::ImgAck {
                id,
                next,
                chunk_size,
            })
        }
        "img.done" => {
            let id = wire.id.filter(|s| valid_id(s))?;
            let ok = wire.ok?;
            if ok {
                let mode = wire.mode.filter(|m| m == "attachment" || m == "path")?;
                Some(SshRemoteMessage::ImgDone {
                    id,
                    ok: true,
                    mode: Some(mode),
                    message: None,
                })
            } else {
                let message = wire
                    .message
                    .filter(|m| m.len() <= 512)
                    .unwrap_or_else(|| "Image paste failed.".into());
                Some(SshRemoteMessage::ImgDone {
                    id,
                    ok: false,
                    mode: None,
                    message: Some(message),
                })
            }
        }
        _ => None,
    }
}

pub fn encode_ssh_bridge_input(message: &SshDesktopMessage<'_>) -> Vec<u8> {
    let json = serde_json::to_vec(message).expect("serialize ssh bridge message");
    let encoded = URL_SAFE_NO_PAD.encode(&json);
    format!("{SSH_BRIDGE_INPUT_START}{SSH_BRIDGE_PREFIX}{encoded}{SSH_BRIDGE_INPUT_END}")
        .into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_remote(value: &serde_json::Value) -> String {
        format!(
            "{SSH_BRIDGE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(value.to_string().as_bytes())
        )
    }

    #[test]
    fn parses_all_remote_messages_and_rejects_malformed() {
        assert_eq!(
            parse_ssh_bridge_payload(&encode_remote(&serde_json::json!({
                "v": 1, "t": "ready", "session": "abc123", "tool": "claude", "clipboard": true
            }))),
            Some(SshRemoteMessage::Ready {
                session: "abc123".into(),
                tool: "claude".into(),
                clipboard: true,
            })
        );
        assert_eq!(
            parse_ssh_bridge_payload(&encode_remote(&serde_json::json!({
                "v": 1, "t": "shell"
            }))),
            Some(SshRemoteMessage::Shell)
        );
        assert_eq!(
            parse_ssh_bridge_payload(&encode_remote(&serde_json::json!({
                "v": 1, "t": "img.ack", "id": "tx-1", "next": 4096, "chunkSize": 16384
            }))),
            Some(SshRemoteMessage::ImgAck {
                id: "tx-1".into(),
                next: 4096,
                chunk_size: Some(16384),
            })
        );
        assert!(
            parse_ssh_bridge_payload(&encode_remote(&serde_json::json!({
                "v": 2, "t": "shell"
            })))
            .is_none()
        );
        assert!(
            parse_ssh_bridge_payload(&encode_remote(&serde_json::json!({
                "v": 1, "t": "ready", "session": "bad space", "tool": "claude", "clipboard": true
            })))
            .is_none()
        );
    }

    #[test]
    fn encodes_desktop_input_frames_with_conpty_safe_pua_delimiters() {
        let frame = encode_ssh_bridge_input(&SshDesktopMessage::ImgBegin {
            v: 1,
            session: "sess1",
            id: "img1",
            mime: "image/png",
            size: 128,
            mode: "attachment",
        });
        assert!(frame.starts_with("\u{E077}outpost;ssh;".as_bytes()));
        assert!(frame.ends_with("\u{E078}".as_bytes()));
    }
}

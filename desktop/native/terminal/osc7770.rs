use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;

const MAX_OPEN_SESSION_OSC_BYTES: usize = 4096;
const MAX_OPEN_SESSION_SKIP_BYTES: usize = 65_536;
const OSC_7770_HEADER: &[u8] = b"7770;";
const OPEN_SESSION_PREFIX: &str = "outpost;open-session;";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneOpenSession {
    pub session_id: String,
    pub name: Option<String>,
    pub origin: Option<String>,
    pub target_id: Option<String>,
    pub hostname: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireOpenSession {
    v: u32,
    session_id: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    target_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    hostname: Option<String>,
}

fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, b)| match i {
        8 | 13 | 18 | 23 => *b == b'-',
        _ => b.is_ascii_hexdigit(),
    })
}

fn clean_opt(value: Option<String>, max_len: usize) -> Option<String> {
    let trimmed = value?.trim().to_string();
    if trimmed.is_empty()
        || trimmed.len() > max_len
        || trimmed.bytes().any(|b| b < 0x20 || b == 0x7f)
    {
        return None;
    }
    Some(trimmed)
}

fn clean_origin(value: Option<String>) -> Option<String> {
    let origin = clean_opt(value, 512)?;
    let lower = origin.to_ascii_lowercase();
    if (!lower.starts_with("http://") && !lower.starts_with("https://"))
        || origin.bytes().any(|b| b.is_ascii_whitespace())
    {
        return None;
    }
    Some(origin)
}

pub(crate) fn parse_open_session_osc_data(data: &str) -> Option<PaneOpenSession> {
    if data.len() > MAX_OPEN_SESSION_OSC_BYTES {
        return None;
    }
    let encoded = data.strip_prefix(OPEN_SESSION_PREFIX)?.trim_end_matches('=');
    if encoded.is_empty() {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let wire: WireOpenSession = serde_json::from_slice(&decoded).ok()?;
    if wire.v != 1 || !is_uuid(&wire.session_id) {
        return None;
    }
    let origin = match wire.origin {
        Some(raw) => Some(clean_origin(Some(raw))?),
        None => None,
    };
    Some(PaneOpenSession {
        session_id: wire.session_id,
        name: clean_opt(wire.name, 256),
        origin,
        target_id: clean_opt(wire.target_id, 256),
        hostname: clean_opt(wire.hostname, 256),
    })
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum Osc7770State {
    #[default]
    Ground,
    Esc,
    Header(usize),
    Payload,
    PayloadEsc,
}

#[derive(Default)]
pub(super) struct Osc7770Scanner {
    state: Osc7770State,
    pending: Vec<u8>,
    payload: Vec<u8>,
    oversized: bool,
    skipped: usize,
}

impl Osc7770Scanner {
    fn clear_payload(&mut self) {
        self.payload.clear();
        self.oversized = false;
        self.skipped = 0;
    }

    pub(super) fn reset(&mut self) {
        self.state = Osc7770State::Ground;
        self.pending.clear();
        self.clear_payload();
    }

    fn finish_payload(&mut self, found: &mut Vec<PaneOpenSession>) {
        if !self.oversized
            && let Ok(text) = std::str::from_utf8(&self.payload)
            && let Some(req) = parse_open_session_osc_data(text)
        {
            found.push(req);
        }
        self.clear_payload();
    }

    /// Filters OSC 7770 open-session requests out of a live PTY byte stream while
    /// preserving every other byte (including all standard OSC sequences) verbatim.
    /// Returns `None` for the filtered buffer on the fast path when `bytes` can be
    /// passed directly to the VT parser with zero copying.
    pub(super) fn scan(&mut self, bytes: &[u8]) -> (Option<Vec<u8>>, Vec<PaneOpenSession>) {
        if self.state == Osc7770State::Ground && !bytes.contains(&0x1b) {
            return (None, Vec::new());
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut found = Vec::new();
        for &b in bytes {
            match self.state {
                Osc7770State::Ground => {
                    if b == 0x1b {
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = Osc7770State::Esc;
                    } else {
                        out.push(b);
                    }
                }
                Osc7770State::Esc => {
                    if b == b']' {
                        self.pending.push(b']');
                        self.state = Osc7770State::Header(0);
                    } else if b == 0x1b {
                        out.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.pending.push(0x1b);
                    } else {
                        out.extend_from_slice(&self.pending);
                        out.push(b);
                        self.pending.clear();
                        self.state = Osc7770State::Ground;
                    }
                }
                Osc7770State::Header(idx) => {
                    if b == OSC_7770_HEADER[idx] {
                        self.pending.push(b);
                        if idx + 1 == OSC_7770_HEADER.len() {
                            self.pending.clear();
                            self.clear_payload();
                            self.state = Osc7770State::Payload;
                        } else {
                            self.state = Osc7770State::Header(idx + 1);
                        }
                    } else if b == 0x1b {
                        out.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = Osc7770State::Esc;
                    } else {
                        out.extend_from_slice(&self.pending);
                        out.push(b);
                        self.pending.clear();
                        self.state = Osc7770State::Ground;
                    }
                }
                Osc7770State::Payload => {
                    if b == 0x07 {
                        self.finish_payload(&mut found);
                        self.state = Osc7770State::Ground;
                    } else if b == 0x1b {
                        self.state = Osc7770State::PayloadEsc;
                    } else if b == 0x18 || b == 0x1a {
                        self.clear_payload();
                        self.state = Osc7770State::Ground;
                    } else if !self.oversized && self.payload.len() < MAX_OPEN_SESSION_OSC_BYTES {
                        self.payload.push(b);
                    } else {
                        self.oversized = true;
                        self.skipped += 1;
                        if self.skipped >= MAX_OPEN_SESSION_SKIP_BYTES {
                            self.clear_payload();
                            self.state = Osc7770State::Ground;
                        }
                    }
                }
                Osc7770State::PayloadEsc => {
                    if b == b'\\' {
                        self.finish_payload(&mut found);
                        self.state = Osc7770State::Ground;
                    } else if b == 0x1b {
                        self.clear_payload();
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = Osc7770State::Esc;
                    } else if b == b']' {
                        self.clear_payload();
                        self.pending.clear();
                        self.pending.extend_from_slice(b"\x1b]");
                        self.state = Osc7770State::Header(0);
                    } else {
                        self.clear_payload();
                        out.push(0x1b);
                        out.push(b);
                        self.state = Osc7770State::Ground;
                    }
                }
            }
        }
        (Some(out), found)
    }
}

#[cfg(test)]
mod tests {
    use super::{Osc7770Scanner, PaneOpenSession, parse_open_session_osc_data};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

    #[test]
    fn osc_7770_scanner_extracts_open_session_across_chunks_and_preserves_other_escapes() {
        let make_seq = |payload: &serde_json::Value, st: bool| -> Vec<u8> {
            let encoded = URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
            let mut bytes = format!("\x1b]7770;outpost;open-session;{encoded}").into_bytes();
            if st {
                bytes.extend_from_slice(b"\x1b\\");
            } else {
                bytes.push(0x07);
            }
            bytes
        };

        let mut scanner = Osc7770Scanner::default();

        // Fast path: plain text with no ESC avoids allocation.
        let (filtered, found) = scanner.scan(b"hello world\r\n");
        assert!(filtered.is_none());
        assert!(found.is_empty());

        // Standard OSC sequences (title, clipboard, hyperlink) pass through verbatim.
        let standard =
            b"pre\x1b]0;Window Title\x07mid\x1b]52;c;aGk=\x07\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\post";
        let (filtered, found) = scanner.scan(standard);
        assert_eq!(filtered.as_deref(), Some(standard.as_slice()));
        assert!(found.is_empty());

        // Full outbound payload terminated by BEL, plus surrounding text.
        let sid1 = "11111111-2222-4333-8444-555555555555";
        let mut stream = b"before".to_vec();
        stream.extend_from_slice(&make_seq(
            &serde_json::json!({
                "v": 1,
                "sessionId": sid1,
                "origin": "https://outpost.example",
                "targetId": "tgt-1",
                "name": "my-app",
                "hostname": "devbox"
            }),
            false,
        ));
        stream.extend_from_slice(b"after");
        let (filtered, found) = scanner.scan(&stream);
        assert_eq!(filtered.as_deref(), Some(b"beforeafter".as_slice()));
        assert_eq!(
            found,
            vec![PaneOpenSession {
                session_id: sid1.into(),
                name: Some("my-app".into()),
                origin: Some("https://outpost.example".into()),
                target_id: Some("tgt-1".into()),
                hostname: Some("devbox".into()),
            }]
        );

        // Byte-by-byte chunking with ST terminator and minimal SSH payload.
        let sid2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let mut chunked = b"X\x1b".to_vec(); // Preceded by stray ESC to test double-ESC transition.
        chunked.extend_from_slice(&make_seq(
            &serde_json::json!({ "v": 1, "sessionId": sid2, "hostname": "ssh-host" }),
            true,
        ));
        chunked.extend_from_slice(b"Y");
        let mut out = Vec::new();
        let mut all_found = Vec::new();
        for b in &chunked {
            let (f, reqs) = scanner.scan(&[*b]);
            if let Some(bytes) = f {
                out.extend_from_slice(&bytes);
            } else {
                out.push(*b);
            }
            all_found.extend(reqs);
        }
        assert_eq!(out, b"X\x1bY");
        assert_eq!(
            all_found,
            vec![PaneOpenSession {
                session_id: sid2.into(),
                name: None,
                origin: None,
                target_id: None,
                hostname: Some("ssh-host".into()),
            }]
        );

        // Invalid UUID, bad origin, wrong version, and oversized payloads are rejected & stripped cleanly.
        assert!(parse_open_session_osc_data("wrong;prefix").is_none());
        let bad_uuid = make_seq(&serde_json::json!({ "v": 1, "sessionId": "not-a-uuid" }), false);
        let (filtered, found) = scanner.scan(&bad_uuid);
        assert_eq!(filtered.as_deref(), Some(b"".as_slice()));
        assert!(found.is_empty());

        let bad_origin = make_seq(
            &serde_json::json!({ "v": 1, "sessionId": sid1, "origin": "javascript:alert(1)" }),
            false,
        );
        let (_, found) = scanner.scan(&bad_origin);
        assert!(found.is_empty());

        let mut huge = b"\x1b]7770;outpost;open-session;".to_vec();
        huge.extend(std::iter::repeat_n(b'A', 6000));
        huge.push(0x07);
        huge.extend_from_slice(b"clean");
        let (filtered, found) = scanner.scan(&huge);
        assert_eq!(filtered.as_deref(), Some(b"clean".as_slice()));
        assert!(found.is_empty());
    }
}

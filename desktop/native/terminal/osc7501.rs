//! OSC 7501: Program Status Protocol scanner and parser for local terminals.
//! Mirrors `shared/programStatus.ts` (Ghostty's canonical parser and limits):
//!   query:  `ESC ] 7501 ; ? (BEL | ST)`
//!   reply:  `ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth (BEL | ST)`
//!   report: `ESC ] 7501 ; state=working:app=claude:progress=40 (BEL | ST)`

use base64::{Engine, engine::general_purpose::STANDARD_NO_PAD};
use std::collections::HashMap;

const MAX_BODY_BYTES: usize = 4096 - "\x1b]7501;".len() - "\x1b\\".len();
const MAX_SKIP_BYTES: usize = 65_536;
const MAX_KEY_BYTES: usize = 16;
const MAX_APP_BYTES: usize = 32;
const MAX_ID_BYTES: usize = 128;
const MAX_ID_SEGMENT_BYTES: usize = 32;
const MAX_ID_DEPTH: usize = 8;
const MAX_TITLE_ENCODED_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 192;
const MAX_MSG_ENCODED_BYTES: usize = 2732;
const MAX_MSG_BYTES: usize = 2048;

const OSC_7501_HEADER: &[u8] = b"7501;";
const QUERY_REPLY_BODY: &str =
    "?:states=idle,working,done,blocked,error:kinds=permission,question,auth";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProgramStatusState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
    Clear,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramStatusReport {
    pub state: ProgramStatusState,
    pub id: Option<String>,
    pub app: Option<String>,
    pub kind: Option<String>,
    pub progress: Option<u8>,
    pub title: Option<String>,
    pub msg: Option<String>,
}

impl ProgramStatusReport {
    pub fn format_detail(&self) -> Option<String> {
        match (self.title.as_deref(), self.msg.as_deref()) {
            (Some(t), Some(m)) if t != m => Some(format!("{t}: {m}")),
            (_, Some(m)) => Some(m.to_owned()),
            (Some(t), None) => Some(t.to_owned()),
            (None, None) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Osc7501Event {
    Query { bel: bool },
    Report(ProgramStatusReport),
}

pub fn format_query_reply(bel: bool) -> Vec<u8> {
    let mut out = format!("\x1b]7501;{QUERY_REPLY_BODY}").into_bytes();
    if bel {
        out.push(0x07);
    } else {
        out.extend_from_slice(b"\x1b\\");
    }
    out
}

fn is_ascii_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r')
}

fn trim_ascii(s: &str) -> &str {
    let bytes = s.as_bytes();
    let start = bytes
        .iter()
        .position(|&b| !is_ascii_ws(b))
        .unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&b| !is_ascii_ws(b))
        .map(|i| i + 1)
        .unwrap_or(start);
    &s[start..end]
}

fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b'-'))
}

fn is_valid_value(s: &str) -> bool {
    s.bytes().all(|b| {
        b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'+' | b',' | b'/' | b'=' | b'-')
    })
}

fn valid_id(value: &str) -> bool {
    if value.len() > MAX_ID_BYTES {
        return false;
    }
    let mut count = 0;
    for segment in value.split('/') {
        count += 1;
        if count > MAX_ID_DEPTH || segment.len() > MAX_ID_SEGMENT_BYTES || !is_name(segment) {
            return false;
        }
    }
    true
}

fn parse_progress(value: &str) -> Option<u8> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let parsed: u32 = value.parse().ok()?;
    (parsed <= 100).then_some(parsed as u8)
}

fn decode_base64_text(encoded: &str, max_bytes: usize) -> Option<String> {
    if encoded.is_empty() {
        return Some(String::new());
    }
    let body = if encoded.ends_with('=') {
        if !encoded.len().is_multiple_of(4) {
            return None;
        }
        let pad = if encoded.ends_with("==") { 2 } else { 1 };
        let stripped = &encoded[..encoded.len() - pad];
        if stripped.is_empty() || stripped.contains('=') {
            return None;
        }
        stripped
    } else {
        if encoded.len() % 4 == 1 {
            return None;
        }
        encoded
    };
    // Reject non-canonical trailing bits and non-standard base64 characters.
    if !body
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    {
        return None;
    }
    let bytes = STANDARD_NO_PAD.decode(body).ok()?;
    if bytes.len() > max_bytes {
        return None;
    }
    let text = String::from_utf8(bytes).ok()?;
    if text
        .chars()
        .any(|c| (c as u32) <= 0x1f || ((c as u32) >= 0x7f && (c as u32) <= 0x9f))
    {
        return None;
    }
    Some(text)
}

pub fn parse_program_status(body: &str, bel: bool) -> Option<Osc7501Event> {
    if body.len() > MAX_BODY_BYTES {
        return None;
    }
    if body == "?" {
        return Some(Osc7501Event::Query { bel });
    }
    let mut last_values: HashMap<&str, &str> = HashMap::new();
    for pair in body.split(':') {
        let Some((raw_key, raw_value)) = pair.split_once('=') else {
            continue;
        };
        let key = trim_ascii(raw_key);
        let value = trim_ascii(raw_value);
        if key.len() > MAX_KEY_BYTES {
            return None;
        }
        match key {
            "id" if !valid_id(value) => return None,
            "app" if value.len() > MAX_APP_BYTES => return None,
            "title" if value.len() > MAX_TITLE_ENCODED_BYTES => return None,
            "msg" if value.len() > MAX_MSG_ENCODED_BYTES => return None,
            _ => {}
        }
        if is_valid_value(value) {
            last_values.insert(key, value);
        }
    }

    let state = match last_values.get("state").copied()? {
        "idle" => ProgramStatusState::Idle,
        "working" => ProgramStatusState::Working,
        "done" => ProgramStatusState::Done,
        "blocked" => ProgramStatusState::Blocked,
        "error" => ProgramStatusState::Error,
        "clear" => ProgramStatusState::Clear,
        _ => return None,
    };

    let title = match last_values.get("title").copied() {
        Some(raw) => {
            let decoded = decode_base64_text(raw, MAX_TITLE_BYTES)?;
            (!decoded.is_empty()).then_some(decoded)
        }
        None => None,
    };
    let msg = match last_values.get("msg").copied() {
        Some(raw) => {
            let decoded = decode_base64_text(raw, MAX_MSG_BYTES)?;
            (!decoded.is_empty()).then_some(decoded)
        }
        None => None,
    };
    let app = last_values
        .get("app")
        .copied()
        .filter(|v| is_name(v))
        .map(str::to_owned);
    let kind = if state == ProgramStatusState::Blocked {
        last_values
            .get("kind")
            .copied()
            .filter(|v| matches!(*v, "permission" | "question" | "auth"))
            .map(str::to_owned)
    } else {
        None
    };
    let progress = if matches!(
        state,
        ProgramStatusState::Working | ProgramStatusState::Blocked
    ) {
        last_values.get("progress").copied().and_then(parse_progress)
    } else {
        None
    };
    let id = last_values.get("id").copied().map(str::to_owned);

    Some(Osc7501Event::Report(ProgramStatusReport {
        state,
        id,
        app,
        kind,
        progress,
        title,
        msg,
    }))
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum ScanState {
    #[default]
    Ground,
    Esc,
    Header(usize),
    Payload {
        allow_bel: bool,
    },
    PayloadEsc {
        allow_bel: bool,
    },
    /// Pass-through for DCS/SOS/PM/APC control strings so embedded `7501;` text is untouched.
    OtherString,
    OtherStringEsc,
}

#[derive(Default)]
pub(super) struct Osc7501Scanner {
    state: ScanState,
    pending: Vec<u8>,
    payload: Vec<u8>,
    oversized: bool,
    skipped: usize,
}

impl Osc7501Scanner {
    fn clear_payload(&mut self) {
        self.payload.clear();
        self.oversized = false;
        self.skipped = 0;
    }

    pub(super) fn reset(&mut self) {
        self.state = ScanState::Ground;
        self.pending.clear();
        self.clear_payload();
    }

    fn finish_payload(&mut self, bel: bool, events: &mut Vec<Osc7501Event>) {
        if !self.oversized
            && let Ok(body) = std::str::from_utf8(&self.payload)
            && let Some(event) = parse_program_status(body, bel)
        {
            events.push(event);
        }
        self.clear_payload();
    }

    /// Strips OSC 7501 sequences from a PTY byte stream while preserving every other byte
    /// verbatim. Returns `None` for the filtered buffer on the fast path when no ESC/C1 OSC
    /// byte is present.
    pub(super) fn scan(&mut self, bytes: &[u8]) -> (Option<Vec<u8>>, Vec<Osc7501Event>) {
        if self.state == ScanState::Ground && !bytes.contains(&0x1b) && !bytes.contains(&0x9d) {
            return (None, Vec::new());
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut events = Vec::new();
        for &b in bytes {
            match self.state {
                ScanState::Ground => match b {
                    0x1b => {
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = ScanState::Esc;
                    }
                    0x9d => {
                        self.pending.clear();
                        self.pending.push(0x9d);
                        self.state = ScanState::Header(0);
                    }
                    0x90 | 0x98 | 0x9e | 0x9f => {
                        out.push(b);
                        self.state = ScanState::OtherString;
                    }
                    _ => out.push(b),
                },
                ScanState::Esc => match b {
                    b']' => {
                        self.pending.push(b']');
                        self.state = ScanState::Header(0);
                    }
                    b'P' | b'X' | b'^' | b'_' => {
                        out.extend_from_slice(&self.pending);
                        out.push(b);
                        self.pending.clear();
                        self.state = ScanState::OtherString;
                    }
                    0x1b => {
                        out.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.pending.push(0x1b);
                    }
                    _ => {
                        out.extend_from_slice(&self.pending);
                        out.push(b);
                        self.pending.clear();
                        self.state = ScanState::Ground;
                    }
                },
                ScanState::Header(idx) => {
                    if b == OSC_7501_HEADER[idx] {
                        self.pending.push(b);
                        if idx + 1 == OSC_7501_HEADER.len() {
                            let allow_bel = self.pending.first() == Some(&0x1b);
                            self.pending.clear();
                            self.clear_payload();
                            self.state = ScanState::Payload { allow_bel };
                        } else {
                            self.state = ScanState::Header(idx + 1);
                        }
                    } else if b == 0x1b {
                        out.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = ScanState::Esc;
                    } else if b == 0x9d {
                        out.extend_from_slice(&self.pending);
                        self.pending.clear();
                        self.pending.push(0x9d);
                        self.state = ScanState::Header(0);
                    } else {
                        out.extend_from_slice(&self.pending);
                        out.push(b);
                        self.pending.clear();
                        self.state = ScanState::Ground;
                    }
                }
                ScanState::Payload { allow_bel } => {
                    if b == 0x07 && allow_bel {
                        self.finish_payload(true, &mut events);
                        self.state = ScanState::Ground;
                    } else if b == 0x9c {
                        self.finish_payload(false, &mut events);
                        self.state = ScanState::Ground;
                    } else if b == 0x1b {
                        self.state = ScanState::PayloadEsc { allow_bel };
                    } else if b == 0x18 || b == 0x1a {
                        self.clear_payload();
                        self.state = ScanState::Ground;
                    } else if !self.oversized && self.payload.len() < MAX_BODY_BYTES {
                        self.payload.push(b);
                    } else {
                        self.oversized = true;
                        self.skipped += 1;
                        if self.skipped >= MAX_SKIP_BYTES {
                            self.clear_payload();
                            self.state = ScanState::Ground;
                        }
                    }
                }
                ScanState::PayloadEsc { .. } => {
                    if b == b'\\' {
                        self.finish_payload(false, &mut events);
                        self.state = ScanState::Ground;
                    } else if b == 0x1b {
                        self.clear_payload();
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = ScanState::Esc;
                    } else if b == b']' {
                        self.clear_payload();
                        self.pending.clear();
                        self.pending.extend_from_slice(b"\x1b]");
                        self.state = ScanState::Header(0);
                    } else {
                        // Aborted OSC 7501 followed by another ESC sequence (e.g. CSI): preserve it.
                        self.clear_payload();
                        out.push(0x1b);
                        out.push(b);
                        self.state = ScanState::Ground;
                    }
                }
                ScanState::OtherString => {
                    out.push(b);
                    if b == 0x9c || b == 0x18 || b == 0x1a {
                        self.state = ScanState::Ground;
                    } else if b == 0x1b {
                        self.state = ScanState::OtherStringEsc;
                    }
                }
                ScanState::OtherStringEsc => {
                    out.push(b);
                    if b == b'\\' {
                        self.state = ScanState::Ground;
                    } else if b != 0x1b {
                        self.state = ScanState::OtherString;
                    }
                }
            }
        }
        (Some(out), events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn osc_7501_handles_queries_reports_chunking_and_preserves_other_escapes() {
        let mut scanner = Osc7501Scanner::default();

        // Fast path: plain text avoids allocation.
        let (filtered, events) = scanner.scan(b"plain output\r\n");
        assert!(filtered.is_none());
        assert!(events.is_empty());

        // Query + report + unrelated escapes + C1 + aborted sequence.
        let stream = concat!(
            "\x1b]0;7501;state=working\x07",
            "\x1b]75010;state=working\x1b\\",
            "\x1bP7501;state=error\x1b\\",
            "\x1b]7501;?\x07",
            "\x1b]7501;?\x1b\\",
            "\x1b]7501;state=blocked:kind=permission:progress=42:app=claude:title=QXBwcm92ZQ:msg=UnVuIGJhc2g=\x1b\\",
            "\x1b]7501;state=working\x1b[32mvisible"
        )
        .as_bytes();

        let mut out = Vec::new();
        let mut all = Vec::new();
        for b in stream {
            let (f, ev) = scanner.scan(&[*b]);
            if let Some(buf) = f {
                out.extend_from_slice(&buf);
            } else {
                out.push(*b);
            }
            all.extend(ev);
        }

        assert_eq!(
            out,
            concat!(
                "\x1b]0;7501;state=working\x07",
                "\x1b]75010;state=working\x1b\\",
                "\x1bP7501;state=error\x1b\\",
                "\x1b[32mvisible"
            )
            .as_bytes()
        );
        assert_eq!(
            all,
            vec![
                Osc7501Event::Query { bel: true },
                Osc7501Event::Query { bel: false },
                Osc7501Event::Report(ProgramStatusReport {
                    state: ProgramStatusState::Blocked,
                    id: None,
                    app: Some("claude".into()),
                    kind: Some("permission".into()),
                    progress: Some(42),
                    title: Some("Approve".into()),
                    msg: Some("Run bash".into()),
                }),
            ]
        );
        assert_eq!(
            format_query_reply(false),
            b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\"
        );
        assert_eq!(
            format_query_reply(true),
            b"\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x07"
        );
    }

    #[test]
    fn osc_7501_rejects_invalid_ids_and_control_chars_in_base64() {
        assert!(parse_program_status("state=working:id=bad id", false).is_none());
        // Base64 of "hi\x07" = "aGkH" -> contains BEL control char -> rejected.
        assert!(parse_program_status("state=done:msg=aGkH", false).is_none());
        // Sub-task id passes parsing so caller can ignore non-root updates.
        let sub = parse_program_status("state=working:id=task/1", false).unwrap();
        assert!(matches!(
            sub,
            Osc7501Event::Report(ProgramStatusReport { id: Some(ref id), .. }) if id == "task/1"
        ));
    }
}

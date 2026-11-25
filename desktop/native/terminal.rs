use crate::{
    box_glyphs,
    bridge::Bridge,
    colors, keys,
    pty::{Local, Output},
};
use alacritty_terminal::{
    event::{Event as AnsiEvent, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point as CellPoint, Side},
    selection::{Selection, SelectionType},
    term::{Config, Term, TermMode, cell::Flags},
    vte::ansi::{CursorShape, Processor, Rgb},
};
use anyhow::Result;
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use gpui::{prelude::*, *};
use serde::Deserialize;
use serde_json::json;
use std::{
    cell::RefCell,
    ops::{Range, RangeInclusive},
    path::Path,
    rc::Rc,
    time::{Duration, Instant},
};

pub(super) const DEFAULT_HISTORY: usize = 10_000;
// Alacritty indexes lines with i32 and adds the viewport height when reflowing.
pub(super) const MAX_HISTORY: usize = i32::MAX as usize - 200;
pub const MAX_SEARCH_MATCHES: usize = 10_000;
const SEARCH_CHUNK_LINES: i32 = 4_096;
const SEARCH_MATCH_BG: u32 = 0x5c4616;
const SEARCH_ACTIVE_BG: u32 = 0xe09f1f;
const SEARCH_ACTIVE_FG: u32 = 0x0c0c0c;

const PANE_RIGHT_MARGIN: f32 = 5.0;
const SCROLLBAR_HIT_REST_W: f32 = 12.0;
const SCROLLBAR_HIT_HOVER_W: f32 = 14.0;
const SCROLLBAR_TRACK_W: f32 = 14.0;
const SCROLLBAR_THUMB_IDLE_W: f32 = 4.0;
const SCROLLBAR_THUMB_ACTIVE_W: f32 = 6.0;
const SCROLLBAR_THUMB_HOVER_W: f32 = 8.0;
const SCROLLBAR_THUMB_RIGHT_PAD: f32 = 3.0;
const SCROLLBAR_PAD_Y: f32 = 2.0;
const SCROLLBAR_MIN_THUMB_H: f32 = 28.0;
const SCROLLBAR_HOLD_MS: u64 = 1_000;
const SCROLLBAR_FADE_MS: f32 = 260.0;
const SCROLLBAR_HOVER_MS: f32 = 110.0;

#[derive(Clone, Copy, Debug, PartialEq)]
struct ScrollbarGeometry {
    track_top: f32,
    track_h: f32,
    thumb_top: f32,
    thumb_h: f32,
    max_travel: f32,
    history: usize,
    screen_lines: usize,
    display_offset: usize,
}

impl ScrollbarGeometry {
    fn compute(
        bounds_top: f32,
        bounds_h: f32,
        history: usize,
        screen_lines: usize,
        display_offset: usize,
    ) -> Option<Self> {
        if history == 0 || screen_lines == 0 || bounds_h < 16.0 {
            return None;
        }
        let track_top = bounds_top + SCROLLBAR_PAD_Y;
        let track_h = (bounds_h - 2.0 * SCROLLBAR_PAD_Y).max(1.0);
        let total_lines = (history + screen_lines) as f32;
        let raw_thumb_h = (screen_lines as f32 / total_lines) * track_h;
        let thumb_h = raw_thumb_h.clamp(SCROLLBAR_MIN_THUMB_H.min(track_h), track_h);
        let max_travel = (track_h - thumb_h).max(0.0);
        let clamped_offset = display_offset.min(history);
        let top_frac = 1.0 - (clamped_offset as f32 / history as f32);
        let thumb_top = track_top + top_frac * max_travel;
        Some(Self {
            track_top,
            track_h,
            thumb_top,
            thumb_h,
            max_travel,
            history,
            screen_lines,
            display_offset: clamped_offset,
        })
    }

    fn offset_for_thumb_top(&self, thumb_top: f32) -> usize {
        if self.max_travel <= 0.0 || self.history == 0 {
            return 0;
        }
        let frac = ((thumb_top - self.track_top) / self.max_travel).clamp(0.0, 1.0);
        ((1.0 - frac) * self.history as f32).round() as usize
    }

    fn contains_thumb_y(&self, y: f32) -> bool {
        y >= self.thumb_top && y <= self.thumb_top + self.thumb_h
    }
}

#[derive(Clone, Copy, Debug)]
struct ScrollbarDrag {
    grab_offset: f32,
}

#[derive(Default)]
struct ScrollbarState {
    hovered: bool,
    hover_t: f32,
    hover_anim_from: f32,
    hover_anim_at: Option<Instant>,
    drag: Option<ScrollbarDrag>,
    activity_at: Option<Instant>,
    fade_token: u64,
}

fn ease_out_cubic(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn white_alpha(alpha: f32) -> Rgba {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgba(0xffffff00 | a)
}

fn black_alpha(alpha: f32) -> Rgba {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgba(a)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchStatus {
    pub total: usize,
    pub active: Option<usize>,
    pub truncated: bool,
    pub invalid_regex: bool,
}

#[derive(Default)]
struct SearchState {
    active: bool,
    query: String,
    options: SearchOptions,
    matches: Vec<RangeInclusive<CellPoint>>,
    current: Option<usize>,
    truncated: bool,
    invalid_regex: bool,
    dirty: bool,
    anchor: Option<CellPoint>,
}

pub const FAMILY: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(windows) {
    "Consolas"
} else {
    "monospace"
};
#[derive(Clone, Copy, Debug)]
struct SizeHint {
    cols: u16,
    rows: u16,
}
impl Dimensions for SizeHint {
    fn total_lines(&self) -> usize {
        self.rows as usize
    }
    fn screen_lines(&self) -> usize {
        self.rows as usize
    }
    fn columns(&self) -> usize {
        self.cols as usize
    }
}
#[derive(Clone, Default)]
struct Events(Rc<RefCell<Vec<AnsiEvent>>>);
impl EventListener for Events {
    fn send_event(&self, e: AnsiEvent) {
        self.0.borrow_mut().push(e)
    }
}

enum Transport {
    Local {
        profile: LocalProfile,
        process: LocalProcess,
    },
    Remote(Bridge, u64),
}
enum LocalProcess {
    WaitingForLayout(Vec<u8>),
    Running(Local),
    Failed,
}
struct LocalProfile {
    shell: String,
    args: Vec<String>,
    home: std::path::PathBuf,
}
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub enum ConnectionState {
    Connecting,
    #[default]
    Connected,
    Reconnecting,
    Closed,
}
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
struct Osc7770Scanner {
    state: Osc7770State,
    pending: Vec<u8>,
    payload: Vec<u8>,
    oversized: bool,
    skipped: usize,
}

impl Osc7770Scanner {
    fn reset(&mut self) {
        self.state = Osc7770State::Ground;
        self.pending.clear();
        self.payload.clear();
        self.oversized = false;
        self.skipped = 0;
    }

    fn finish_payload(&mut self, found: &mut Vec<PaneOpenSession>) {
        if !self.oversized
            && let Ok(text) = std::str::from_utf8(&self.payload)
            && let Some(req) = parse_open_session_osc_data(text)
        {
            found.push(req);
        }
        self.payload.clear();
        self.oversized = false;
        self.skipped = 0;
    }

    /// Filters OSC 7770 open-session requests out of a live PTY byte stream while
    /// preserving every other byte (including all standard OSC sequences) verbatim.
    /// Returns `None` for the filtered buffer on the fast path when `bytes` can be
    /// passed directly to the VT parser with zero copying.
    fn scan(&mut self, bytes: &[u8]) -> (Option<Vec<u8>>, Vec<PaneOpenSession>) {
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
                            self.payload.clear();
                            self.oversized = false;
                            self.skipped = 0;
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
                        self.payload.clear();
                        self.oversized = false;
                        self.skipped = 0;
                        self.state = Osc7770State::Ground;
                    } else if !self.oversized && self.payload.len() < MAX_OPEN_SESSION_OSC_BYTES {
                        self.payload.push(b);
                    } else {
                        self.oversized = true;
                        self.skipped += 1;
                        if self.skipped >= MAX_OPEN_SESSION_SKIP_BYTES {
                            self.payload.clear();
                            self.oversized = false;
                            self.skipped = 0;
                            self.state = Osc7770State::Ground;
                        }
                    }
                }
                Osc7770State::PayloadEsc => {
                    if b == b'\\' {
                        self.finish_payload(&mut found);
                        self.state = Osc7770State::Ground;
                    } else if b == 0x1b {
                        self.payload.clear();
                        self.oversized = false;
                        self.skipped = 0;
                        self.pending.clear();
                        self.pending.push(0x1b);
                        self.state = Osc7770State::Esc;
                    } else if b == b']' {
                        self.payload.clear();
                        self.oversized = false;
                        self.skipped = 0;
                        self.pending.clear();
                        self.pending.extend_from_slice(b"\x1b]");
                        self.state = Osc7770State::Header(0);
                    } else {
                        self.payload.clear();
                        self.oversized = false;
                        self.skipped = 0;
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

pub struct Pane {
    term: Term<Events>,
    parser: Processor,
    events: Events,
    transport: Transport,
    pub focus: FocusHandle,
    pub title: String,
    pub mark: Option<&'static crate::agent_mark::AgentMark>,
    pub connection: ConnectionState,
    pub status: String,
    pub font_size: f32,
    scrollback: usize,
    pub bell: bool,
    pub activity: String,
    pub activity_detail: Option<String>,
    pub waiting: u64,
    pub draft: String,
    pub sending: bool,
    pub restoring: bool,
    pub sound: bool,
    pub server: Option<String>,
    pub session_key: Option<String>,
    pub files: serde_json::Value,
    pub file_previews: crate::workspace::files::FilePreviews,
    focus_subs: Vec<Subscription>,
    active: bool,
    bounds: Bounds<Pixels>,
    cell: Size<Pixels>,
    desired: Option<(u16, u16)>,
    pub(super) grid_visible: bool,
    dragging: bool,
    selection_changed: bool,
    mouse_reported_button: Option<MouseButton>,
    last_mouse_motion: Option<(u8, usize, usize, u8)>,
    scroll_remainder: f32,
    pending_copy: Option<String>,
    marked: String,
    search: SearchState,
    scrollbar: ScrollbarState,
    osc_scanner: Osc7770Scanner,
    last_open_session: Option<(String, Instant)>,
}
impl EventEmitter<PaneOpenSession> for Pane {}
pub struct PasteError(pub String);
impl EventEmitter<PasteError> for Pane {}
pub struct PaneNotice {
    pub message: String,
    pub sticky: bool,
}
impl PaneNotice {
    pub fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            sticky: false,
        }
    }
    pub fn sticky(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            sticky: true,
        }
    }
}
impl EventEmitter<PaneNotice> for Pane {}
pub struct PaneMenu {
    pub position: Point<Pixels>,
}
impl EventEmitter<PaneMenu> for Pane {}
pub struct PaneChanged;
impl EventEmitter<PaneChanged> for Pane {}
impl Pane {
    pub fn local(
        shell: &str,
        args: &[String],
        home: &Path,
        font_size: f32,
        w: &mut Window,
        cx: &mut App,
    ) -> Entity<Self> {
        let title = Path::new(shell)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let transport = Transport::Local {
            profile: LocalProfile {
                shell: shell.into(),
                args: args.to_vec(),
                home: home.into(),
            },
            process: LocalProcess::WaitingForLayout(Vec::new()),
        };
        cx.new(|cx| Self::new(transport, title, font_size, w, cx))
    }
    pub(super) fn restarted_local(&self, w: &mut Window, cx: &mut App) -> Result<Entity<Self>> {
        let Transport::Local { profile, .. } = &self.transport else {
            anyhow::bail!("The local shell profile is unavailable.");
        };
        let pane = Self::local(
            &profile.shell,
            &profile.args,
            &profile.home,
            self.font_size,
            w,
            cx,
        );
        pane.update(cx, |next, _| {
            next.sound = self.sound;
            next.set_scrollback(self.scrollback);
        });
        Ok(pane)
    }
    pub fn remote(
        b: Bridge,
        id: u64,
        title: String,
        server: String,
        fs: f32,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut pane = Self::new(Transport::Remote(b, id), title, fs, w, cx);
        pane.server = Some(server);
        pane.connection = ConnectionState::Connecting;
        pane.restoring = true;
        pane.status = "Connecting…".into();
        pane
    }
    fn new(
        transport: Transport,
        title: String,
        font_size: f32,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let events = Events::default();
        let config = Config {
            scrolling_history: DEFAULT_HISTORY,
            ..Default::default()
        };
        let focus = cx.focus_handle();
        Self {
            term: Term::new(config, &SizeHint { cols: 2, rows: 2 }, events.clone()),
            parser: Default::default(),
            events,
            transport,
            focus,
            title,
            mark: None,
            connection: ConnectionState::Connected,
            status: String::new(),
            font_size,
            scrollback: DEFAULT_HISTORY,
            bell: false,
            activity: String::new(),
            activity_detail: None,
            waiting: 0,
            draft: String::new(),
            sending: false,
            restoring: false,
            sound: true,
            server: None,
            session_key: None,
            files: serde_json::Value::Null,
            file_previews: Default::default(),
            focus_subs: Vec::new(),
            active: false,
            bounds: Bounds::default(),
            cell: size(px(8.), px(17.)),
            desired: None,
            grid_visible: false,
            dragging: false,
            selection_changed: false,
            mouse_reported_button: None,
            last_mouse_motion: None,
            scroll_remainder: 0.0,
            pending_copy: None,
            marked: String::new(),
            search: SearchState::default(),
            scrollbar: ScrollbarState::default(),
            osc_scanner: Osc7770Scanner::default(),
            last_open_session: None,
        }
    }
    pub fn bind_focus(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.sync_focus(w, cx);
        self.focus_subs = vec![
            cx.on_focus(&self.focus, w, |s, w, cx| {
                s.sync_focus(w, cx);
                cx.emit(PaneChanged)
            }),
            cx.on_blur(&self.focus, w, |s, w, cx| s.sync_focus(w, cx)),
            cx.observe_window_activation(w, |s, w, cx| s.sync_focus(w, cx)),
        ];
    }
    pub fn command(&self, op: &str, mut args: serde_json::Value) {
        if let Transport::Remote(b, id) = &self.transport {
            args["op"] = op.into();
            args["pane"] = (*id).into();
            b.call(args)
        }
    }
    pub fn feed(&mut self, bytes: &[u8], cx: &mut Context<Self>) {
        let (filtered, open_requests) = self.osc_scanner.scan(bytes);
        let feed_bytes = filtered.as_deref().unwrap_or(bytes);
        if !feed_bytes.is_empty() {
            self.parser.advance(&mut self.term, feed_bytes);
        }
        if self.search.active {
            self.search.dirty = true;
        }
        if !self.restoring {
            let now = Instant::now();
            for req in open_requests {
                let duplicate = self.last_open_session.as_ref().is_some_and(|(id, at)| {
                    *id == req.session_id && now.duration_since(*at) < Duration::from_secs(2)
                });
                if !duplicate {
                    self.last_open_session = Some((req.session_id.clone(), now));
                    cx.emit(req);
                }
            }
        }
        let events = std::mem::take(&mut *self.events.0.borrow_mut());
        let local = matches!(self.transport, Transport::Local { .. });
        for e in events {
            match e {
                AnsiEvent::Title(s) if local => {
                    self.title = s.chars().take(256).collect();
                    cx.emit(PaneChanged)
                }
                AnsiEvent::PtyWrite(data) if local => self.write(data.into_bytes(), cx),
                AnsiEvent::ClipboardStore(_, text)
                    if !self.restoring && text.len() <= 1024 * 1024 =>
                {
                    if self.active {
                        self.pending_copy = None;
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        cx.emit(PaneNotice::transient("Copied to clipboard"));
                    } else if !text.is_empty() {
                        // Background panes never overwrite the system clipboard unprompted;
                        // keep the text available for an explicit Copy action.
                        self.pending_copy = Some(text);
                    }
                }
                AnsiEvent::ColorRequest(i, reply) if local && i < 269 => {
                    let v = self.term.colors()[i]
                        .map(|c| u32::from_be_bytes([0, c.r, c.g, c.b]))
                        .unwrap_or_else(|| colors::indexed(i));
                    self.write(
                        reply(Rgb {
                            r: (v >> 16) as u8,
                            g: (v >> 8) as u8,
                            b: v as u8,
                        })
                        .into_bytes(),
                        cx,
                    )
                }
                AnsiEvent::TextAreaSizeRequest(reply) if local => self.write(
                    reply(WindowSize {
                        num_cols: self.term.columns() as u16,
                        num_lines: self.term.screen_lines() as u16,
                        cell_width: f32::from(self.cell.width) as u16,
                        cell_height: f32::from(self.cell.height) as u16,
                    })
                    .into_bytes(),
                    cx,
                ),
                AnsiEvent::Bell if !self.restoring => {
                    self.bell = true;
                    if self.sound {
                        ring_bell();
                    }
                    cx.emit(PaneChanged);
                }
                _ => {}
            }
        }
        cx.notify()
    }
    pub fn geometry(&mut self, cols: u16, rows: u16) {
        self.term.resize(SizeHint {
            cols: cols.clamp(2, 400),
            rows: rows.clamp(2, 200),
        });
        if self.search.active {
            self.search.dirty = true;
        }
    }
    pub fn set_scrollback(&mut self, lines: usize) {
        if self.scrollback == lines {
            return;
        }
        if lines < self.term.history_size() {
            self.term.selection = None;
        }
        self.scrollback = lines;
        self.term.set_options(Config {
            scrolling_history: lines,
            ..Config::default()
        });
        if self.search.active {
            self.search.dirty = true;
        }
    }
    pub fn reset(&mut self, cols: u16, rows: u16) {
        self.grid_visible = false;
        self.pending_copy = None;
        self.last_mouse_motion = None;
        self.scroll_remainder = 0.0;
        self.scrollbar = ScrollbarState::default();
        self.osc_scanner.reset();
        self.term = Term::new(
            Config {
                scrolling_history: self.scrollback,
                ..Default::default()
            },
            &SizeHint { cols, rows },
            self.events.clone(),
        );
        self.parser = Default::default();
        if self.search.active {
            self.search.matches.clear();
            self.search.current = None;
            self.search.truncated = false;
            self.search.dirty = true;
        }
    }
    pub fn clear_screen(&mut self, remote: bool, cx: &mut Context<Self>) {
        if remote && matches!(self.transport, Transport::Remote(..)) {
            self.command("clear", json!({}));
            return;
        }
        // Preserve the current input line, including its attributes and cursor column.
        let saved = self.term.grid().cursor.clone();
        let line = self.term.grid()[saved.point.line].clone();
        self.feed(b"\x1b[2J\x1b[3J\x1b[H", cx);
        self.term.grid_mut()[Line(0)] = line;
        self.term.grid_mut().cursor.point.column = saved.point.column;
        self.term.selection = None;
        if self.search.active {
            self.search.dirty = true;
        }
    }
    pub fn focus_terminal(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(w, cx);
        // A newly inserted pane can receive focus before its subscription is installed.
        self.sync_focus(w, cx);
    }
    fn sync_focus(&mut self, w: &Window, cx: &mut Context<Self>) {
        let active = w.is_window_active() && self.focus.is_focused(w);
        if active == self.active {
            return;
        }
        self.active = active;
        if active {
            self.bell = false;
        }
        self.command("focus", json!({"active":active}));
        if matches!(self.transport, Transport::Local { .. })
            && self.term.mode().contains(TermMode::FOCUS_IN_OUT)
        {
            self.write(
                if active {
                    b"\x1b[I".to_vec()
                } else {
                    b"\x1b[O".to_vec()
                },
                cx,
            );
        }
        cx.notify()
    }
    pub fn write(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        if bytes.is_empty() {
            return;
        }
        match &mut self.transport {
            Transport::Local { process, .. } => {
                let result = match process {
                    LocalProcess::WaitingForLayout(input)
                        if input.len() + bytes.len() <= 1024 * 1024 =>
                    {
                        input.extend(bytes);
                        Ok(())
                    }
                    LocalProcess::WaitingForLayout(_) => {
                        Err(anyhow::anyhow!("Shell input queue unavailable"))
                    }
                    LocalProcess::Running(pty) => pty.send(bytes),
                    LocalProcess::Failed => return,
                };
                if let Err(e) = result {
                    self.status = e.to_string();
                    cx.emit(PaneChanged)
                }
            }
            Transport::Remote(..) => self.command("input", json!({"data":STANDARD.encode(bytes)})),
        }
    }
    fn user_write(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let was_scrolled = self.term.grid().display_offset() > 0;
        self.term.scroll_display(Scroll::Bottom);
        if was_scrolled {
            self.note_scroll_activity(cx);
        }
        self.term.selection = None;
        self.write(bytes, cx);
        cx.notify()
    }
    pub fn paste(&mut self, text: String, cx: &mut Context<Self>) {
        if text.is_empty() {
            return;
        }
        let text = text
            .replace('\x1b', "")
            .replace("\r\n", "\r")
            .replace('\n', "\r");
        let input = if self.term.mode().contains(TermMode::BRACKETED_PASTE) {
            format!("\x1b[200~{text}\x1b[201~")
        } else {
            text
        };
        let bytes = input.into_bytes();
        if bytes.len() > 1024 * 1024 {
            cx.emit(PasteError(
                "Clipboard text is larger than 1 MiB. Paste a smaller section.".into(),
            ));
            return;
        }
        self.user_write(bytes, cx);
    }
    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        let mut sel = Selection::new(
            SelectionType::Simple,
            CellPoint::new(Line(-(self.term.history_size() as i32)), Column(0)),
            Side::Left,
        );
        sel.update(
            CellPoint::new(
                Line(self.term.screen_lines() as i32 - 1),
                Column(self.term.columns() - 1),
            ),
            Side::Right,
        );
        self.term.selection = Some(sel);
        cx.notify()
    }
    pub fn has_selection(&self) -> bool {
        self.term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
            .is_some()
    }
    pub fn can_copy(&self) -> bool {
        self.has_selection() || self.pending_copy.is_some()
    }
    pub fn copy(&mut self, cx: &mut App) -> bool {
        let text = self
            .term
            .selection_to_string()
            .filter(|t| !t.is_empty())
            .or_else(|| self.pending_copy.take().filter(|t| !t.is_empty()));
        let Some(text) = text else {
            return false;
        };
        self.pending_copy = None;
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        true
    }
    #[cfg(feature = "ui-tests")]
    pub fn selected_text(&self) -> Option<String> {
        self.term.selection_to_string()
    }
    #[cfg(feature = "ui-tests")]
    pub fn screen_text(&self) -> String {
        (0..self.term.screen_lines() as i32)
            .map(|y| {
                (0..self.term.columns())
                    .map(|x| self.term.grid()[Line(y)][Column(x)].c)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    pub fn selected_string(&self) -> Option<String> {
        self.term.selection_to_string().filter(|s| !s.is_empty())
    }
    pub fn search_status(&self) -> SearchStatus {
        SearchStatus {
            total: self.search.matches.len(),
            active: self.search.current,
            truncated: self.search.truncated,
            invalid_regex: self.search.invalid_regex,
        }
    }
    pub fn set_search(
        &mut self,
        query: &str,
        options: SearchOptions,
        reset_anchor: bool,
        cx: &mut Context<Self>,
    ) -> SearchStatus {
        self.search.active = true;
        self.search.query = query.to_owned();
        self.search.options = options;
        if reset_anchor || self.search.anchor.is_none() {
            self.search.anchor = Some(self.viewport_bottom_point());
        }
        if self.recompute_search(true) {
            self.note_scroll_activity(cx);
        }
        cx.notify();
        self.search_status()
    }
    pub fn clear_search(&mut self, cx: &mut Context<Self>) {
        if !self.search.active && self.search.matches.is_empty() && !self.search.invalid_regex {
            return;
        }
        self.search = SearchState::default();
        cx.notify();
    }
    pub fn refresh_search_if_dirty(&mut self) -> bool {
        if !self.search.active || !self.search.dirty {
            return false;
        }
        self.recompute_search(false);
        true
    }
    pub fn step_search(&mut self, next: bool, cx: &mut Context<Self>) -> bool {
        if !self.search.active {
            return false;
        }
        self.refresh_search_if_dirty();
        let len = self.search.matches.len();
        if len == 0 {
            return false;
        }
        let next_idx = match self.search.current {
            Some(i) if next => (i + 1) % len,
            Some(i) => {
                if i == 0 {
                    len - 1
                } else {
                    i - 1
                }
            }
            None if next => 0,
            None => len - 1,
        };
        self.search.current = Some(next_idx);
        let m = self.search.matches[next_idx].clone();
        self.search.anchor = Some(*m.start());
        if self.scroll_to_match(&m) {
            self.note_scroll_activity(cx);
        }
        cx.notify();
        true
    }
    /// Select the active search match into the terminal selection and copy it.
    #[cfg(feature = "ui-tests")]
    pub fn select_active_match(&mut self, cx: &mut Context<Self>) -> Option<String> {
        self.refresh_search_if_dirty();
        let idx = self.search.current?;
        let m = self.search.matches.get(idx)?.clone();
        let mut sel = Selection::new(SelectionType::Simple, *m.start(), Side::Left);
        sel.update(*m.end(), Side::Right);
        self.term.selection = Some(sel);
        let text = self.term.selection_to_string().filter(|s| !s.is_empty())?;
        self.pending_copy = None;
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        cx.notify();
        Some(text)
    }
    /// iTerm2-style Tab / Shift+Tab: select the active match, or extend the selection
    /// by one word forward (`forward = true`) or backward (`forward = false`), copying it.
    pub fn extend_search_selection(
        &mut self,
        forward: bool,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        self.refresh_search_if_dirty();
        let idx = self.search.current?;
        let m = self.search.matches.get(idx)?.clone();
        let (mut start, mut end) = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
            .filter(|r| r.start <= *m.start() && r.end >= *m.end())
            .map(|r| (r.start, r.end))
            .unwrap_or((*m.start(), *m.end()));

        let already_selected = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
            .is_some_and(|r| r.start <= *m.start() && r.end >= *m.end());

        if already_selected {
            if forward {
                end = next_word_end(&self.term, end);
            } else {
                start = prev_word_start(&self.term, start);
            }
        }
        let mut sel = Selection::new(SelectionType::Simple, start, Side::Left);
        sel.update(end, Side::Right);
        self.term.selection = Some(sel);
        let text = self.term.selection_to_string().filter(|s| !s.is_empty())?;
        self.pending_copy = None;
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        cx.notify();
        Some(text)
    }
    #[cfg(feature = "ui-tests")]
    pub fn active_match_text(&mut self) -> Option<String> {
        self.refresh_search_if_dirty();
        let idx = self.search.current?;
        let m = self.search.matches.get(idx)?;
        let mut sel = Selection::new(SelectionType::Simple, *m.start(), Side::Left);
        sel.update(*m.end(), Side::Right);
        let saved = self.term.selection.take();
        self.term.selection = Some(sel);
        let text = self.term.selection_to_string();
        self.term.selection = saved;
        text
    }
    fn viewport_bottom_point(&self) -> CellPoint {
        let bottom_line = Line(
            self.term.screen_lines() as i32 - 1 - self.term.grid().display_offset() as i32,
        );
        CellPoint::new(bottom_line.max(self.term.topmost_line()), self.term.last_column())
    }
    fn recompute_search(&mut self, scroll_to_result: bool) -> bool {
        self.search.dirty = false;
        let prev_active_start = self
            .search
            .current
            .and_then(|i| self.search.matches.get(i))
            .map(|m| *m.start());
        let Some(pattern) = build_search_pattern(&self.search.query, self.search.options) else {
            self.search.matches.clear();
            self.search.current = None;
            self.search.truncated = false;
            self.search.invalid_regex = false;
            return false;
        };
        let Ok(mut regex) = alacritty_terminal::term::search::RegexSearch::new(&pattern) else {
            self.search.matches.clear();
            self.search.current = None;
            self.search.truncated = false;
            self.search.invalid_regex = true;
            return false;
        };
        self.search.invalid_regex = false;
        let (matches, truncated) =
            collect_search_matches(&self.term, &mut regex, self.search.options.whole_word);
        self.search.matches = matches;
        self.search.truncated = truncated;
        if self.search.matches.is_empty() {
            self.search.current = None;
            return false;
        }
        let target = if scroll_to_result {
            let anchor = self
                .search
                .anchor
                .unwrap_or_else(|| self.viewport_bottom_point());
            pick_nearest_match_upward(&self.search.matches, anchor)
        } else if let Some(prev) = prev_active_start {
            pick_nearest_match_upward(&self.search.matches, prev)
        } else {
            self.search.matches.len() - 1
        };
        self.search.current = Some(target);
        if scroll_to_result {
            let m = self.search.matches[target].clone();
            return self.scroll_to_match(&m);
        }
        false
    }
    fn scroll_to_match(&mut self, m: &RangeInclusive<CellPoint>) -> bool {
        let screen_lines = self.term.screen_lines() as i32;
        if screen_lines <= 0 {
            return false;
        }
        let history = self.term.history_size() as i32;
        let offset = self.term.grid().display_offset() as i32;
        let line = m.start().line.0;
        let row = line + offset;
        let top_pad = 2.min(screen_lines / 3);
        let bot_pad = 1.min(screen_lines / 4);
        if row < top_pad || row >= screen_lines - bot_pad {
            let center = (screen_lines / 2).max(top_pad);
            let target_offset = (center - line).clamp(0, history);
            let delta = target_offset - offset;
            if delta != 0 {
                self.term.scroll_display(Scroll::Delta(delta));
                return true;
            }
        }
        false
    }
    fn scrollbar_visible(&self) -> bool {
        !self.term.mode().contains(TermMode::ALT_SCREEN) && self.term.history_size() > 0
    }
    fn scrollbar_geometry(&self) -> Option<ScrollbarGeometry> {
        if !self.scrollbar_visible() {
            return None;
        }
        ScrollbarGeometry::compute(
            f32::from(self.bounds.top()),
            f32::from(self.bounds.size.height),
            self.term.history_size(),
            self.term.screen_lines(),
            self.term.grid().display_offset(),
        )
    }
    fn scrollbar_hit_contains(&self, pos: Point<Pixels>) -> bool {
        if !self.scrollbar_visible() || f32::from(self.bounds.size.height) < 16.0 {
            return false;
        }
        let hit_w = if self.scrollbar.hovered || self.scrollbar.drag.is_some() {
            SCROLLBAR_HIT_HOVER_W
        } else {
            SCROLLBAR_HIT_REST_W
        };
        pos.x >= self.bounds.right() - px(hit_w)
            && pos.x <= self.bounds.right()
            && pos.y >= self.bounds.top()
            && pos.y <= self.bounds.bottom()
    }
    fn set_display_offset(&mut self, target_offset: usize) -> bool {
        let clamped = target_offset.min(self.term.history_size()) as i32;
        let current = self.term.grid().display_offset() as i32;
        let delta = clamped - current;
        if delta != 0 {
            self.term.scroll_display(Scroll::Delta(delta));
            return true;
        }
        false
    }
    fn scroll_display_and_notify(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        self.term.scroll_display(scroll);
        self.note_scroll_activity(cx);
        cx.notify();
    }
    fn set_scrollbar_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        let next = hovered && self.scrollbar_visible();
        if self.scrollbar.hovered == next {
            return;
        }
        self.scrollbar.hover_anim_from = self.scrollbar.hover_t;
        self.scrollbar.hover_anim_at = Some(Instant::now());
        self.scrollbar.hovered = next;
        cx.notify();
    }
    fn note_scroll_activity(&mut self, cx: &mut Context<Self>) {
        if !self.scrollbar_visible() {
            return;
        }
        self.scrollbar.activity_at = Some(Instant::now());
        self.scrollbar.fade_token = self.scrollbar.fade_token.wrapping_add(1);
        let token = self.scrollbar.fade_token;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(SCROLLBAR_HOLD_MS))
                .await;
            let _ = this.update(cx, |s, cx| {
                if s.scrollbar.fade_token == token {
                    cx.notify();
                }
            });
        })
        .detach();
    }
    #[cfg(feature = "ui-tests")]
    pub fn find(&mut self, query: &str, next: bool, cx: &mut Context<Self>) {
        if query.is_empty() {
            self.clear_search(cx);
            return;
        }
        if !self.search.active || self.search.query != query {
            self.set_search(query, self.search.options, true, cx);
        } else {
            self.step_search(next, cx);
        }
    }
    fn layout(&mut self, b: Bounds<Pixels>, cx: &mut Context<Self>) {
        self.bounds = b;
        let ts = cx.text_system();
        let id = ts.resolve_font(&terminal_font(Flags::empty()));
        let cw = ts
            .advance(id, px(self.font_size), 'M')
            .map(|a| a.width)
            .unwrap_or(px(self.font_size * 0.61));
        self.cell = size(cw, px((self.font_size * 1.24).ceil()));
        let usable_w = (b.size.width - px(PANE_RIGHT_MARGIN)).max(px(0.));
        let cols = (usable_w / cw).floor();
        let rows = (b.size.height / self.cell.height).floor();
        if !cols.is_finite() || !rows.is_finite() || cols < 2. || rows < 2. {
            return;
        }
        let dims = (cols.min(400.) as u16, rows.min(200.) as u16);
        if self.desired == Some(dims) {
            return;
        }
        self.desired = Some(dims);
        if let Transport::Local { profile, process } = &mut self.transport {
            match process {
                LocalProcess::WaitingForLayout(input) => {
                    match Local::open(&profile.shell, &profile.args, &profile.home, dims.0, dims.1)
                    {
                        Ok((pty, output)) => {
                            if !input.is_empty()
                                && let Err(error) = pty.send(std::mem::take(input))
                            {
                                self.status = error.to_string();
                                cx.emit(PaneChanged);
                            }
                            *process = LocalProcess::Running(pty);
                            Self::read_shell(output, cx);
                        }
                        Err(error) => {
                            *process = LocalProcess::Failed;
                            self.status = error.to_string();
                            cx.emit(PaneChanged);
                            cx.notify();
                            return;
                        }
                    }
                }
                LocalProcess::Running(pty) => {
                    let _ = pty.resize(dims.0, dims.1);
                }
                LocalProcess::Failed => return,
            }
            self.geometry(dims.0, dims.1);
            self.grid_visible = true;
        } else {
            self.command("resize", json!({"cols":dims.0,"rows":dims.1}));
        }
    }
    fn read_shell(stream: async_channel::Receiver<Output>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            while let Ok(output) = stream.recv().await {
                if this
                    .update(cx, |s, cx| match output {
                        Output::Bytes(bytes) => s.feed(&bytes, cx),
                        Output::Closed(reason) => {
                            s.status = reason;
                            cx.emit(PaneChanged);
                            cx.notify()
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }
    fn point_and_side(&self, p: Point<Pixels>) -> (CellPoint, Side) {
        let cols = self.term.columns();
        let rows = self.term.screen_lines();
        let cell_w = f32::from(self.cell.width).max(1.0);
        let cell_h = f32::from(self.cell.height).max(1.0);
        let rel_x = f32::from(p.x - self.bounds.origin.x);
        let (col, side) = if rel_x <= 0.0 {
            (0, Side::Left)
        } else if rel_x >= cell_w * cols as f32 {
            (cols - 1, Side::Right)
        } else {
            let col = ((rel_x / cell_w).floor() as usize).min(cols - 1);
            let side = if rel_x - (col as f32) * cell_w < cell_w * 0.5 {
                Side::Left
            } else {
                Side::Right
            };
            (col, side)
        };
        let line = (f32::from(p.y - self.bounds.origin.y) / cell_h)
            .floor()
            .clamp(0., (rows - 1) as f32) as i32
            - self.term.grid().display_offset() as i32;
        (CellPoint::new(Line(line), Column(col)), side)
    }
    fn point(&self, p: Point<Pixels>) -> CellPoint {
        self.point_and_side(p).0
    }
    fn bypass_mouse_mode(mods: Modifiers) -> bool {
        mods.shift || (cfg!(target_os = "macos") && mods.alt)
    }
    fn mouse_report(
        &mut self,
        code: u8,
        p: Point<Pixels>,
        up: bool,
        mods: Modifiers,
        force: bool,
        dedupe_motion: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let mode = *self.term.mode();
        if (!force && Self::bypass_mouse_mode(mods)) || !mode.intersects(TermMode::MOUSE_MODE) {
            self.last_mouse_motion = None;
            return false;
        }
        let pos = self.point(p);
        if pos.line.0 < 0 {
            return false;
        }
        let x = pos.column.0 + 1;
        let y = pos.line.0 as usize + 1;
        let flags = mouse_mod_flags(mods);
        if dedupe_motion {
            let key = (code, x, y, flags);
            if self.last_mouse_motion == Some(key) {
                return true;
            }
            self.last_mouse_motion = Some(key);
        } else if up {
            self.last_mouse_motion = None;
        } else {
            self.last_mouse_motion = Some((32 + code, x, y, flags));
        }
        let Some(data) = encode_mouse_sequence(mode, code, x, y, up, flags) else {
            return true;
        };
        self.write(data, cx);
        true
    }
    fn scroll_mouse_report(
        &mut self,
        up: bool,
        count: usize,
        p: Point<Pixels>,
        mods: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        let mode = *self.term.mode();
        if Self::bypass_mouse_mode(mods) || !mode.intersects(TermMode::MOUSE_MODE) {
            return false;
        }
        let pos = self.point(p);
        if pos.line.0 < 0 {
            return false;
        }
        let x = pos.column.0 + 1;
        let y = pos.line.0 as usize + 1;
        let code = if up { 64 } else { 65 };
        let Some(seq) = encode_mouse_sequence(mode, code, x, y, false, mouse_mod_flags(mods))
        else {
            return true;
        };
        let mut batch = Vec::with_capacity(seq.len() * count);
        for _ in 0..count {
            batch.extend_from_slice(&seq);
        }
        self.write(batch, cx);
        true
    }
}

fn mouse_mod_flags(mods: Modifiers) -> u8 {
    8 * u8::from(mods.alt) + 16 * u8::from(mods.control)
}

fn encode_mouse_sequence(
    mode: TermMode,
    code: u8,
    x: usize,
    y: usize,
    up: bool,
    flags: u8,
) -> Option<Vec<u8>> {
    if mode.contains(TermMode::SGR_MOUSE) {
        Some(
            format!(
                "\x1b[<{};{x};{y}{}",
                code + flags,
                if up { "m" } else { "M" }
            )
            .into_bytes(),
        )
    } else if x <= 223 && y <= 223 {
        Some(vec![
            27,
            91,
            77,
            32 + if up { 3 } else { code } + flags,
            32 + x as u8,
            32 + y as u8,
        ])
    } else {
        None
    }
}

fn accumulate_scroll_steps(
    remainder: &mut f32,
    delta: ScrollDelta,
    cell_height: Pixels,
) -> (usize, bool) {
    match delta {
        ScrollDelta::Lines(p) => {
            *remainder = 0.0;
            if p.y.abs() < 0.01 {
                return (0, true);
            }
            ((p.y.abs().ceil() as usize).clamp(1, 60), p.y > 0.0)
        }
        ScrollDelta::Pixels(p) => {
            let rows = f32::from(p.y) / f32::from(cell_height).max(1.0);
            if rows.abs() < 1e-4 {
                return (0, true);
            }
            if *remainder != 0.0 && remainder.signum() != rows.signum() {
                *remainder = 0.0;
            }
            *remainder += rows;
            let whole = remainder.trunc() as i32;
            *remainder -= whole as f32;
            ((whole.unsigned_abs() as usize).min(60), whole > 0)
        }
    }
}
impl Drop for Pane {
    fn drop(&mut self) {
        self.command("close", json!({}))
    }
}

fn terminal_font_features() -> FontFeatures {
    static FEATURES: std::sync::LazyLock<FontFeatures> = std::sync::LazyLock::new(|| {
        FontFeatures(std::sync::Arc::new(vec![
            ("calt".into(), 0),
            ("liga".into(), 0),
            ("clig".into(), 0),
        ]))
    });
    FEATURES.clone()
}

fn terminal_font(flags: Flags) -> Font {
    let mut face = font(FAMILY);
    face.features = terminal_font_features();
    if flags.contains(Flags::BOLD) {
        face.weight = FontWeight::BOLD;
    }
    if flags.contains(Flags::ITALIC) {
        face.style = FontStyle::Italic;
    }
    face
}

fn is_batchable_ascii(c: char) -> bool {
    matches!(c, ' '..='~')
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct BgRun {
    line: i32,
    col: usize,
    width: usize,
    color: u32,
}
impl BgRun {
    fn paint(self, pane: &Pane, grid_origin: Point<Pixels>, w: &mut Window) {
        let bounds = box_glyphs::snapped_cell_bounds(
            grid_origin,
            pane.cell,
            self.line,
            self.col,
            self.width,
            w.scale_factor(),
        );
        w.paint_quad(fill(bounds, rgb(self.color)));
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Ink {
    fg: u32,
    flags: Flags,
}
#[derive(Debug, PartialEq, Eq)]
struct GlyphRun {
    line: i32,
    col: usize,
    width: usize,
    cells: usize,
    isolated: bool,
    ink: Ink,
    text: String,
}
impl GlyphRun {
    fn shape(&self, font_size: Pixels, cell_width: Pixels, ts: &WindowTextSystem) -> ShapedLine {
        let face = terminal_font(self.ink.flags);
        let run = TextRun {
            len: self.text.len(),
            font: face,
            color: rgb(self.ink.fg).into(),
            background_color: None,
            underline: self.ink.flags.intersects(Flags::ALL_UNDERLINES).then_some(
                UnderlineStyle {
                    thickness: px(1.),
                    ..Default::default()
                },
            ),
            strikethrough: self.ink.flags.contains(Flags::STRIKEOUT).then_some(
                StrikethroughStyle {
                    thickness: px(1.),
                    ..Default::default()
                },
            ),
        };
        let force_width = (!self.isolated && self.cells > 1).then_some(cell_width);
        ts.shape_line(self.text.clone().into(), font_size, &[run], force_width)
    }
    fn paint(self, pane: &Pane, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        if self.isolated && self.width == 1 {
            let mut chars = self.text.chars();
            if let (Some(ch), None) = (chars.next(), chars.next())
                && box_glyphs::paint(
                    ch,
                    grid_origin,
                    pane.cell,
                    self.line,
                    self.col,
                    self.ink.fg,
                    self.ink.flags.intersects(Flags::ALL_UNDERLINES),
                    self.ink.flags.contains(Flags::STRIKEOUT),
                    w,
                )
            {
                return;
            }
        }
        let base = grid_origin
            + point(
                pane.cell.width * self.col as f32,
                pane.cell.height * self.line as f32,
            );
        let line = self.shape(px(pane.font_size), pane.cell.width, w.text_system());
        let _ = line.paint(base, pane.cell.height, TextAlign::Left, None, w, cx);
    }
}

fn escape_regex_literal(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn build_search_pattern(query: &str, options: SearchOptions) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let core = if options.regex {
        query.to_owned()
    } else {
        escape_regex_literal(query)
    };
    Some(if options.case_sensitive {
        format!("(?-i:{core})")
    } else {
        format!("(?i:{core})")
    })
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn primary_cell_char<T>(term: &Term<T>, point: CellPoint) -> char {
    let cell = &term.grid()[point];
    if cell.flags.contains(Flags::WIDE_CHAR_SPACER) && point.column > Column(0) {
        term.grid()[CellPoint::new(point.line, point.column - 1)].c
    } else {
        cell.c
    }
}

fn matches_whole_word<T>(term: &Term<T>, m: &RangeInclusive<CellPoint>) -> bool {
    use alacritty_terminal::index::Direction;
    let start = *m.start();
    let end = *m.end();
    let last_col = term.last_column();
    let top_line = term.topmost_line();
    let bottom_line = Line(term.screen_lines() as i32 - 1);

    if is_word_char(primary_cell_char(term, start)) {
        let prev = if start.column > Column(0) {
            Some(CellPoint::new(start.line, start.column - 1))
        } else if start.line > top_line
            && term.grid()[start.line - 1i32][last_col]
                .flags
                .contains(Flags::WRAPLINE)
        {
            Some(CellPoint::new(start.line - 1i32, last_col))
        } else {
            None
        };
        if let Some(prev) = prev
            && is_word_char(primary_cell_char(term, prev))
        {
            return false;
        }
    }

    if is_word_char(primary_cell_char(term, end)) {
        let right_edge = term.expand_wide(end, Direction::Right);
        let next = if right_edge.column < last_col {
            Some(CellPoint::new(right_edge.line, right_edge.column + 1))
        } else if right_edge.line < bottom_line
            && term.grid()[right_edge.line][last_col]
                .flags
                .contains(Flags::WRAPLINE)
        {
            Some(CellPoint::new(right_edge.line + 1i32, Column(0)))
        } else {
            None
        };
        if let Some(mut next) = next {
            if term.grid()[next]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
                && next.line < bottom_line
            {
                next = CellPoint::new(next.line + 1i32, Column(0));
            }
            if is_word_char(primary_cell_char(term, next)) {
                return false;
            }
        }
    }

    true
}

fn collect_search_matches<T>(
    term: &Term<T>,
    regex: &mut alacritty_terminal::term::search::RegexSearch,
    whole_word: bool,
) -> (Vec<RangeInclusive<CellPoint>>, bool) {
    use alacritty_terminal::{
        index::{Boundary, Direction},
        term::search::RegexIter,
    };

    let top_line = term.topmost_line();
    let bottom_line = Line(term.screen_lines() as i32 - 1);
    let last_col = term.last_column();
    if bottom_line < top_line {
        return (Vec::new(), false);
    }

    let mut chunk_end = CellPoint::new(bottom_line, last_col);
    let mut chunks: Vec<Vec<RangeInclusive<CellPoint>>> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    loop {
        let raw_top = Line((chunk_end.line.0 - SEARCH_CHUNK_LINES + 1).max(top_line.0));
        let chunk_start = term.line_search_left(CellPoint::new(raw_top, Column(0)));
        let mut chunk_matches = Vec::new();
        let mut last_end: Option<CellPoint> = None;

        for m in RegexIter::new(chunk_start, chunk_end, Direction::Right, term, regex) {
            if *m.start() > *m.end() || last_end.is_some_and(|prev| *m.start() <= prev) {
                break;
            }
            last_end = Some(*m.end());
            if !whole_word || matches_whole_word(term, &m) {
                chunk_matches.push(m);
            }
        }

        if total + chunk_matches.len() > MAX_SEARCH_MATCHES {
            let keep = MAX_SEARCH_MATCHES.saturating_sub(total);
            let drop_prefix = chunk_matches.len().saturating_sub(keep);
            chunk_matches.drain(..drop_prefix);
            total += chunk_matches.len();
            if !chunk_matches.is_empty() {
                chunks.push(chunk_matches);
            }
            truncated = true;
            break;
        }

        total += chunk_matches.len();
        if !chunk_matches.is_empty() {
            chunks.push(chunk_matches);
        }

        if chunk_start.line <= top_line {
            break;
        }
        chunk_end = chunk_start.sub(term, Boundary::Grid, 1);
        if chunk_end >= chunk_start {
            break;
        }
    }

    let mut all = Vec::with_capacity(total);
    for mut chunk in chunks.into_iter().rev() {
        all.append(&mut chunk);
    }
    (all, truncated)
}

fn pick_nearest_match_upward(matches: &[RangeInclusive<CellPoint>], anchor: CellPoint) -> usize {
    let idx = matches.partition_point(|m| *m.start() <= anchor);
    if idx > 0 { idx - 1 } else { 0 }
}

fn next_word_end<T>(term: &Term<T>, current_end: CellPoint) -> CellPoint {
    use alacritty_terminal::index::{Boundary, Direction};
    let mut pt = term.expand_wide(current_end, Direction::Right);
    let bottom = CellPoint::new(Line(term.screen_lines() as i32 - 1), term.last_column());
    while pt < bottom {
        let next = pt.add(term, Boundary::Grid, 1);
        if next.line != pt.line
            && !term.grid()[pt.line][term.last_column()]
                .flags
                .contains(Flags::WRAPLINE)
        {
            break;
        }
        let c = primary_cell_char(term, next);
        if c.is_whitespace() {
            pt = next;
        } else {
            pt = next;
            // Extend through the contiguous non-whitespace token.
            let right = term.semantic_search_right(pt);
            if right >= pt {
                pt = right;
            }
            break;
        }
    }
    pt
}

fn prev_word_start<T>(term: &Term<T>, current_start: CellPoint) -> CellPoint {
    use alacritty_terminal::index::Boundary;
    let mut pt = current_start;
    let top = CellPoint::new(term.topmost_line(), Column(0));
    while pt > top {
        let prev = pt.sub(term, Boundary::Grid, 1);
        if prev.line != pt.line
            && !term.grid()[prev.line][term.last_column()]
                .flags
                .contains(Flags::WRAPLINE)
        {
            break;
        }
        let c = primary_cell_char(term, prev);
        if c.is_whitespace() {
            pt = prev;
        } else {
            pt = prev;
            let left = term.semantic_search_left(pt);
            if left <= pt {
                pt = left;
            }
            break;
        }
    }
    pt
}

fn match_contains_cell(m: &RangeInclusive<CellPoint>, point: CellPoint, wide: bool) -> bool {
    let contains = |p: CellPoint| p >= *m.start() && p <= *m.end();
    contains(point) || (wide && contains(CellPoint::new(point.line, point.column + 1)))
}

fn plan_draw_runs(
    view: alacritty_terminal::term::RenderableContent<'_>,
    focused: bool,
    search_matches: &[RangeInclusive<CellPoint>],
    active_match: Option<&RangeInclusive<CellPoint>>,
    screen_lines: usize,
) -> (Vec<BgRun>, Vec<GlyphRun>) {
    let cursor = view.cursor.point;
    let block_cursor = focused && view.cursor.shape == CursorShape::Block;
    let mut bgs = Vec::new();
    let mut glyphs = Vec::new();
    let mut pending_bg: Option<BgRun> = None;
    let mut pending_glyph: Option<GlyphRun> = None;

    let visible_top = Line(-(view.display_offset as i32));
    let visible_bottom = Line(screen_lines as i32 - 1 - view.display_offset as i32);
    let visible_matches = if search_matches.is_empty() {
        &[][..]
    } else {
        let lo = search_matches.partition_point(|m| m.end().line < visible_top);
        let hi = search_matches.partition_point(|m| m.start().line <= visible_bottom);
        &search_matches[lo.min(hi)..hi]
    };
    let mut match_cursor = 0usize;

    let push_bg = |pending: &mut Option<BgRun>, out: &mut Vec<BgRun>, row, col, width, color| {
        if color == colors::BG {
            if let Some(r) = pending.take() {
                out.push(r);
            }
            return;
        }
        if let Some(r) = pending.as_mut()
            && r.line == row
            && r.col + r.width == col
            && r.color == color
        {
            r.width += width;
            return;
        }
        if let Some(r) = pending.take() {
            out.push(r);
        }
        *pending = Some(BgRun {
            line: row,
            col,
            width,
            color,
        });
    };

    let flush_glyph = |pending: &mut Option<GlyphRun>, out: &mut Vec<GlyphRun>| {
        let Some(mut run) = pending.take() else {
            return;
        };
        if !run
            .ink
            .flags
            .intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        {
            if !run.isolated {
                let trimmed = run.text.trim_end_matches(' ').len();
                if trimmed == 0 {
                    return;
                }
                run.text.truncate(trimmed);
                run.width = trimmed;
                run.cells = trimmed;
            } else if run.text.trim().is_empty() {
                return;
            }
        }
        out.push(run);
    };

    for item in view.display_iter {
        let cell = item.cell;
        let row = item.point.line.0 + view.display_offset as i32;
        let col = item.point.column.0;
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        let mut fg = colors::resolve(cell.fg, view.colors);
        let mut bg = colors::resolve(cell.bg, view.colors);
        if cell.flags.contains(Flags::DIM) {
            fg = colors::dim(fg)
        }
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg)
        }
        let wide = cell.flags.contains(Flags::WIDE_CHAR);
        let selected = view.selection.is_some_and(|s| {
            s.contains(item.point)
                || (wide && s.contains(CellPoint::new(item.point.line, item.point.column + 1)))
        });
        while match_cursor < visible_matches.len()
            && *visible_matches[match_cursor].end() < item.point
        {
            match_cursor += 1;
        }
        let in_search_match = visible_matches
            .get(match_cursor)
            .is_some_and(|m| match_contains_cell(m, item.point, wide))
            || (wide
                && visible_matches
                    .get(match_cursor + 1)
                    .is_some_and(|m| match_contains_cell(m, item.point, wide)));
        let in_active_match = active_match.is_some_and(|m| match_contains_cell(m, item.point, wide));
        if selected {
            bg = 0x2b4c7e;
            if cell.flags.contains(Flags::INVERSE) {
                fg = colors::FG;
            }
        } else if in_active_match {
            bg = SEARCH_ACTIVE_BG;
            fg = SEARCH_ACTIVE_FG;
        } else if in_search_match {
            bg = SEARCH_MATCH_BG;
            if cell.flags.contains(Flags::INVERSE) || fg == bg {
                fg = colors::FG;
            }
        }
        if block_cursor && item.point == cursor {
            fg = colors::BG;
            bg = colors::FG;
        }
        let width = if wide { 2 } else { 1 };
        push_bg(&mut pending_bg, &mut bgs, row, col, width, bg);

        let flags =
            cell.flags & (Flags::BOLD | Flags::ITALIC | Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
        let ink = Ink { fg, flags };
        let decorated = flags.intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
        let hidden = cell.flags.contains(Flags::HIDDEN);
        let ch = if hidden { ' ' } else { cell.c };
        let has_zerowidth = !hidden && cell.zerowidth().is_some();
        // Fallback fonts, combining clusters, and wide glyphs have independent advances and
        // must be anchored to their own grid cell so following columns never drift.
        let isolated = width == 2 || has_zerowidth || !is_batchable_ascii(ch);
        if isolated {
            flush_glyph(&mut pending_glyph, &mut glyphs);
            let mut text = String::new();
            if hidden {
                for _ in 0..width {
                    text.push(' ');
                }
            } else {
                text.push(ch);
                if let Some(extra) = cell.zerowidth() {
                    text.extend(extra.iter().copied());
                }
            }
            if decorated || !text.trim().is_empty() {
                glyphs.push(GlyphRun {
                    line: row,
                    col,
                    width,
                    cells: if hidden { width } else { 1 },
                    isolated: !hidden,
                    ink,
                    text,
                });
            }
            continue;
        }
        if let Some(r) = pending_glyph.as_mut()
            && r.line == row
            && r.col + r.width == col
            && r.ink == ink
        {
            r.width += 1;
            r.cells += 1;
            r.text.push(ch);
        } else {
            flush_glyph(&mut pending_glyph, &mut glyphs);
            if ch != ' ' || decorated {
                let mut text = String::new();
                text.push(ch);
                pending_glyph = Some(GlyphRun {
                    line: row,
                    col,
                    width: 1,
                    cells: 1,
                    isolated: false,
                    ink,
                    text,
                });
            }
        }
    }
    if let Some(r) = pending_bg {
        bgs.push(r);
    }
    flush_glyph(&mut pending_glyph, &mut glyphs);
    (bgs, glyphs)
}

impl Pane {
    pub(super) fn draw_at(&mut self, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        if !self.grid_visible {
            return;
        }
        self.refresh_search_if_dirty();
        let screen_lines = self.term.screen_lines();
        let view = self.term.renderable_content();
        let cursor = view.cursor.point;
        let cursor_shape = view.cursor.shape;
        let cursor_row = cursor.line.0 + view.display_offset as i32;
        let cursor_origin = grid_origin
            + point(
                self.cell.width * cursor.column.0 as f32,
                self.cell.height * cursor_row as f32,
            );
        let focused = self.focus.is_focused(w);
        let active_match = self
            .search
            .current
            .and_then(|i| self.search.matches.get(i));
        let (bgs, glyphs) = plan_draw_runs(
            view,
            focused,
            &self.search.matches,
            active_match,
            screen_lines,
        );
        for bg in bgs {
            bg.paint(self, grid_origin, w);
        }
        for glyph in glyphs {
            glyph.paint(self, grid_origin, w, cx);
        }
        if cursor_row >= 0 && (cursor_row as usize) < self.term.screen_lines() {
            if cursor_shape != CursorShape::Hidden {
                let cursor_cells = if cursor.line.0 >= -(self.term.history_size() as i32)
                    && cursor.line.0 < self.term.screen_lines() as i32
                    && cursor.column.0 < self.term.columns()
                    && self.term.grid()[cursor].flags.contains(Flags::WIDE_CHAR)
                {
                    2
                } else {
                    1
                };
                let cursor_bounds = box_glyphs::snapped_cell_bounds(
                    grid_origin,
                    self.cell,
                    cursor_row,
                    cursor.column.0,
                    cursor_cells,
                    w.scale_factor(),
                );
                let overlay = match cursor_shape {
                    CursorShape::Beam => Some(Bounds::new(
                        cursor_bounds.origin,
                        size(px(2.), cursor_bounds.size.height),
                    )),
                    CursorShape::Underline => Some(Bounds::new(
                        point(cursor_bounds.left(), cursor_bounds.bottom() - px(2.)),
                        size(cursor_bounds.size.width, px(2.)),
                    )),
                    _ if !focused => Some(Bounds::new(
                        point(cursor_bounds.left(), cursor_bounds.bottom() - px(1.)),
                        size(cursor_bounds.size.width, px(1.)),
                    )),
                    _ => None,
                };
                if let Some(bounds) = overlay {
                    w.paint_quad(fill(bounds, rgb(colors::FG)));
                }
            }
            if !self.marked.is_empty() {
                let marked_run = GlyphRun {
                    line: cursor_row,
                    col: cursor.column.0,
                    width: self.marked.chars().count(),
                    cells: 1,
                    isolated: true,
                    ink: Ink {
                        fg: colors::FG,
                        flags: Flags::UNDERLINE,
                    },
                    text: self.marked.clone(),
                };
                let line = marked_run.shape(px(self.font_size), self.cell.width, w.text_system());
                w.paint_quad(fill(
                    Bounds::new(
                        cursor_origin,
                        size(line.width().max(self.cell.width), self.cell.height),
                    ),
                    rgb(colors::BG),
                ));
                let _ = line.paint(cursor_origin, self.cell.height, TextAlign::Left, None, w, cx);
            }
        }
        self.paint_scrollbar(w);
    }
    fn paint_scrollbar(&mut self, w: &mut Window) {
        let h = f32::from(self.bounds.size.height);
        if h < 16. {
            return;
        }
        let show_bar = self.scrollbar_visible();
        let show_marks = self.search.active && !self.search.matches.is_empty();
        if !show_bar {
            self.scrollbar.hovered = false;
            self.scrollbar.drag = None;
            self.scrollbar.hover_t = 0.0;
            self.scrollbar.hover_anim_at = None;
            self.scrollbar.activity_at = None;
        }
        if !show_bar && !show_marks {
            return;
        }

        let now = Instant::now();
        let hover_target = if show_bar && (self.scrollbar.hovered || self.scrollbar.drag.is_some())
        {
            1.0
        } else {
            0.0
        };
        if let Some(started) = self.scrollbar.hover_anim_at {
            let t = (now.saturating_duration_since(started).as_secs_f32() * 1000.0
                / SCROLLBAR_HOVER_MS)
                .clamp(0.0, 1.0);
            self.scrollbar.hover_t = lerp(
                self.scrollbar.hover_anim_from,
                hover_target,
                ease_out_cubic(t),
            );
            if t < 1.0 {
                w.request_animation_frame();
            } else {
                self.scrollbar.hover_t = hover_target;
                self.scrollbar.hover_anim_at = None;
            }
        } else {
            self.scrollbar.hover_t = hover_target;
        }
        let hover_t = self.scrollbar.hover_t;

        let activity_t = if let Some(at) = self.scrollbar.activity_at {
            let elapsed_ms = now.saturating_duration_since(at).as_secs_f32() * 1000.0;
            let hold_ms = SCROLLBAR_HOLD_MS as f32;
            if elapsed_ms < hold_ms {
                1.0
            } else {
                let fade_t = ((elapsed_ms - hold_ms) / SCROLLBAR_FADE_MS).clamp(0.0, 1.0);
                if fade_t < 1.0 {
                    w.request_animation_frame();
                    1.0 - ease_out_cubic(fade_t)
                } else {
                    self.scrollbar.activity_at = None;
                    0.0
                }
            }
        } else {
            0.0
        };

        let bounds_top = f32::from(self.bounds.top());
        let bounds_right = f32::from(self.bounds.right());
        let track_top = bounds_top + SCROLLBAR_PAD_Y;
        let track_h = (h - 2.0 * SCROLLBAR_PAD_Y).max(1.0);
        let track_x = bounds_right - SCROLLBAR_TRACK_W;

        // Subtle macOS / iTerm2 overlay track that softly fades in on hover or search marks.
        let track_alpha = (if show_bar { hover_t * 0.065 } else { 0.0 })
            .max(if show_marks { 0.04 } else { 0.0 });
        if track_alpha > 0.004 {
            w.paint_quad(fill(
                Bounds::new(
                    point(px(track_x), px(bounds_top)),
                    size(px(SCROLLBAR_TRACK_W), px(h)),
                ),
                white_alpha(track_alpha),
            ));
        }
        if show_bar && hover_t > 0.02 {
            w.paint_quad(fill(
                Bounds::new(point(px(track_x), px(bounds_top)), size(px(1.), px(h))),
                white_alpha(hover_t * 0.11),
            ));
        }

        let history = self.term.history_size();
        let screen_lines = self.term.screen_lines().max(1);
        let total_lines = (history + screen_lines) as f32;

        // Paint search match tick marks inside the scrollbar lane (behind the thumb).
        if show_marks {
            let mark_w = lerp(4.0, 10.0, hover_t);
            let mark_x = bounds_right - SCROLLBAR_THUMB_RIGHT_PAD - mark_w.min(SCROLLBAR_TRACK_W - 4.0);
            let mut last_y = i32::MIN;
            for m in &self.search.matches {
                let line_idx = (m.start().line.0 + history as i32).max(0) as f32;
                let frac = (line_idx / total_lines).clamp(0.0, 1.0);
                let y = (track_top + frac * (track_h - 2.0).max(0.0)).round() as i32;
                if y - last_y < 2 {
                    continue;
                }
                last_y = y;
                w.paint_quad(fill(
                    Bounds::new(point(px(mark_x), px(y as f32)), size(px(mark_w), px(2.))),
                    rgba(0xe09f1fc4),
                ));
            }
        }

        // Paint capsule overlay thumb pill.
        if let Some(geom) = self.scrollbar_geometry() {
            let scrolled_up = geom.display_offset > 0;
            let active_factor = activity_t.max(if scrolled_up { 0.45 } else { 0.0 });
            let rest_w = lerp(SCROLLBAR_THUMB_IDLE_W, SCROLLBAR_THUMB_ACTIVE_W, active_factor);
            let thumb_w = lerp(rest_w, SCROLLBAR_THUMB_HOVER_W, hover_t);
            let thumb_x = bounds_right - SCROLLBAR_THUMB_RIGHT_PAD - thumb_w;
            let base_alpha = if scrolled_up {
                lerp(0.30, 0.42, activity_t)
            } else {
                lerp(0.18, 0.38, activity_t)
            };
            let thumb_alpha = if self.scrollbar.drag.is_some() {
                0.66
            } else {
                lerp(base_alpha, 0.50, hover_t)
            };
            let radius = px(thumb_w * 0.5);
            w.paint_quad(quad(
                Bounds::new(
                    point(px(thumb_x), px(geom.thumb_top)),
                    size(px(thumb_w), px(geom.thumb_h)),
                ),
                Corners::all(radius),
                white_alpha(thumb_alpha),
                Edges::all(px(1.0)),
                black_alpha(thumb_alpha * 0.45),
                BorderStyle::Solid,
            ));
        }

        // Paint the active search match marker on top so it always stays unmistakable.
        if show_marks
            && let Some(active) = self.search.current.and_then(|i| self.search.matches.get(i))
        {
            let line_idx = (active.start().line.0 + history as i32).max(0) as f32;
            let frac = (line_idx / total_lines).clamp(0.0, 1.0);
            let y = (track_top + frac * (track_h - 3.0).max(0.0)).round();
            let mark_w = lerp(6.0, 11.0, hover_t);
            let mark_x = bounds_right - 2.0 - mark_w;
            w.paint_quad(quad(
                Bounds::new(point(px(mark_x), px(y)), size(px(mark_w), px(3.))),
                Corners::all(px(1.5)),
                rgb(0xfacc15),
                Edges::default(),
                transparent_black(),
                BorderStyle::Solid,
            ));
        }
    }
    pub fn restore_links(&mut self, cells: &[serde_json::Value]) {
        use alacritty_terminal::term::cell::Hyperlink;
        for tuple in cells {
            let (Some(line), Some(col), Some(id), Some(uri)) = (
                tuple[0].as_i64(),
                tuple[1].as_u64(),
                tuple[2].as_str(),
                tuple[3].as_str(),
            ) else {
                continue;
            };
            if line >= -(self.term.history_size() as i64)
                && line < self.term.screen_lines() as i64
                && col < self.term.columns() as u64
            {
                self.term.grid_mut()[Line(line as i32)][Column(col as usize)]
                    .set_hyperlink(Some(Hyperlink::new(Some(id), uri.into())));
            }
        }
    }
    pub fn restore_cursor(&mut self, x: u64, y: u64) {
        let cols = self.term.columns();
        let rows = self.term.screen_lines();
        let c = &mut self.term.grid_mut().cursor;
        c.point = CellPoint::new(
            Line(y.min(rows as u64 - 1) as i32),
            Column(x.min(cols as u64 - 1) as usize),
        );
        c.input_needs_wrap = x >= cols as u64;
    }
    pub fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        self.paste_clipboard_key(false, cx);
    }
    fn paste_clipboard_key(&mut self, is_held: bool, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        if self.server.is_none() {
            if let Some(text) = item.text() {
                self.paste(text, cx);
            }
            return;
        }
        self.paste_managed_item(&item, false, is_held, cx);
    }
    pub fn paste_image_path(&mut self, cx: &mut Context<Self>) {
        if let Some(item) = cx.read_from_clipboard() {
            self.paste_managed_item(&item, true, false, cx);
        }
    }
    fn paste_managed_item(
        &mut self,
        item: &ClipboardItem,
        as_path: bool,
        is_held: bool,
        cx: &mut Context<Self>,
    ) {
        match crate::clipboard_image::read(item) {
            Ok(Some((mime, bytes))) => {
                if is_held {
                    return;
                }
                cx.emit(PaneNotice::sticky("Uploading image…"));
                self.command("image", json!({
                    "mime": mime, "data": STANDARD.encode(bytes), "mode": if as_path { "path" } else { "attachment" }
                }));
            }
            Ok(None) if as_path => cx.emit(PasteError("Copy an image first.".into())),
            Ok(None) => {
                if let Some(text) = item.text() {
                    self.paste(text, cx);
                }
            }
            Err(_) if !as_path && item.text().is_some() => {
                if let Some(text) = item.text() {
                    self.paste(text, cx);
                }
            }
            Err(error) => cx.emit(PasteError(error.to_string())),
        }
    }
    fn cursor_menu_position(&self) -> Point<Pixels> {
        let p = self.term.grid().cursor.point;
        let row = (p.line.0 + self.term.grid().display_offset() as i32)
            .clamp(0, self.term.screen_lines().saturating_sub(1) as i32);
        self.bounds.origin
            + point(
                self.cell.width * (p.column.0 as f32 + 0.5),
                self.cell.height * (row as f32 + 1.0),
            )
    }
    fn observe_completion(&self, w: &Window) {
        if self.activity == "finished" && w.is_window_active() && self.focus.is_focused(w) {
            self.command("observe", json!({}));
        }
    }
    fn handle_shortcut(&mut self, e: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let k = &e.keystroke;
        let m = k.modifiers;
        let key = k.key.as_str();

        if !m.control && !m.alt && !m.platform && (key == "menu" || (key == "f10" && m.shift)) {
            if !e.is_held {
                cx.emit(PaneMenu {
                    position: self.cursor_menu_position(),
                });
            }
            return true;
        }

        // Keyboard scrollback navigation (disabled in alt-screen apps like vim/less/tmux).
        if !self.term.mode().contains(TermMode::ALT_SCREEN) {
            if m == Modifiers::shift() || (cfg!(target_os = "macos") && m == Modifiers::command()) {
                let scroll = match key {
                    "pageup" => Some(Scroll::PageUp),
                    "pagedown" => Some(Scroll::PageDown),
                    "home" => Some(Scroll::Top),
                    "end" => Some(Scroll::Bottom),
                    _ => None,
                };
                if let Some(scroll) = scroll {
                    self.scroll_display_and_notify(scroll, cx);
                    return true;
                }
            }
        }

        // Clipboard & terminal shortcuts never use Alt (so they cannot conflict with AltGr).
        if m.alt {
            return false;
        }

        if cfg!(target_os = "macos") {
            if m.platform && !m.control && !m.shift {
                match key {
                    "a" => self.select_all(cx),
                    "c" => {
                        if !e.is_held && self.copy(cx) {
                            cx.emit(PaneNotice::transient("Copied to clipboard"));
                        }
                    }
                    "v" => self.paste_clipboard_key(e.is_held, cx),
                    "k" => {
                        if !e.is_held {
                            self.clear_screen(true, cx);
                        }
                    }
                    _ => return false,
                }
                return true;
            }
            if self.server.is_some() && key == "v" && m == Modifiers::control() {
                self.paste_clipboard_key(e.is_held, cx);
                return true;
            }
            return false;
        }

        if m.control && m.shift && !m.platform {
            match key {
                "a" => self.select_all(cx),
                "c" => {
                    if !e.is_held && self.copy(cx) {
                        cx.emit(PaneNotice::transient("Copied to clipboard"));
                    }
                }
                "v" => self.paste_clipboard_key(e.is_held, cx),
                "k" => {
                    if !e.is_held {
                        self.clear_screen(true, cx);
                    }
                }
                _ => return false,
            }
            return true;
        }
        // Ctrl+C copies and clears selection when text is selected; otherwise sends SIGINT.
        if m == Modifiers::control() && key == "c" && self.has_selection() {
            if !e.is_held && self.copy(cx) {
                self.term.selection = None;
                cx.emit(PaneNotice::transient("Copied to clipboard"));
                cx.notify();
            }
            return true;
        }
        if m == Modifiers::control() && key == "insert" {
            if !e.is_held && self.copy(cx) {
                cx.emit(PaneNotice::transient("Copied to clipboard"));
            }
            return true;
        }
        if m == Modifiers::shift() && key == "insert" {
            self.paste_clipboard_key(e.is_held, cx);
            return true;
        }
        if m == Modifiers::control() && key == "v" {
            if self.server.is_some() {
                self.paste_clipboard_key(e.is_held, cx);
            } else if let Some(item) = cx.read_from_clipboard() {
                if let Some(text) = item.text() {
                    self.paste(text, cx);
                } else if crate::clipboard_image::has_image(&item) && !e.is_held {
                    self.user_write(vec![0x16], cx);
                }
            }
            return true;
        }
        false
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.observe_completion(w);
        if !self.marked.is_empty() {
            return;
        }
        if self.handle_shortcut(e, cx) {
            w.prevent_default();
            cx.stop_propagation();
            return;
        }
        if e.prefer_character_input {
            return;
        }
        if let Some(bytes) = keys::encode(&e.keystroke, *self.term.mode()) {
            self.user_write(bytes, cx);
            w.prevent_default();
            cx.stop_propagation()
        }
    }
    fn hyperlink_at(&self, point: CellPoint) -> Option<String> {
        let cell = &self.term.grid()[point];
        let uri = cell.hyperlink().map(|l| l.uri().to_owned()).or_else(|| {
            let line = &self.term.grid()[point.line];
            let col = point.column.0;
            let start = (0..col)
                .rev()
                .find(|i| line[Column(*i)].c.is_whitespace())
                .map_or(0, |i| i + 1);
            let stop = (col..self.term.columns())
                .find(|i| line[Column(*i)].c.is_whitespace())
                .unwrap_or(self.term.columns());
            Some(
                (start..stop)
                    .map(|i| line[Column(i)].c)
                    .collect::<String>()
                    .trim_matches(['(', ')', '[', ']', '<', '>'])
                    .to_owned(),
            )
        });
        uri.filter(|url| url.starts_with("https://") || url.starts_with("http://"))
    }
    fn down(&mut self, e: &MouseDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(w, cx);
        self.observe_completion(w);
        if e.button == MouseButton::Right {
            // Preserve local selection and never let mouse-mode apps swallow the context menu.
            cx.emit(PaneMenu {
                position: e.position,
            });
            cx.stop_propagation();
            return;
        }
        let button = match e.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            _ => return,
        };
        if e.button == MouseButton::Left && self.scrollbar_hit_contains(e.position) {
            if let Some(geom) = self.scrollbar_geometry() {
                let y = f32::from(e.position.y);
                self.set_scrollbar_hovered(true, cx);
                if geom.contains_thumb_y(y) {
                    self.scrollbar.drag = Some(ScrollbarDrag {
                        grab_offset: y - geom.thumb_top,
                    });
                } else if e.modifiers.alt || e.modifiers.shift {
                    let scroll = if y < geom.thumb_top {
                        Scroll::PageUp
                    } else {
                        Scroll::PageDown
                    };
                    self.term.scroll_display(scroll);
                } else {
                    let desired_top = y - geom.thumb_h * 0.5;
                    let target = geom.offset_for_thumb_top(desired_top);
                    self.set_display_offset(target);
                    self.scrollbar.drag = Some(ScrollbarDrag {
                        grab_offset: geom.thumb_h * 0.5,
                    });
                }
                self.note_scroll_activity(cx);
                cx.stop_propagation();
                cx.notify();
                return;
            }
        }
        if e.button == MouseButton::Left && (e.modifiers.platform || e.modifiers.control) {
            let point = self.point(e.position);
            if let Some(url) = self.hyperlink_at(point) {
                cx.open_url(&url);
                return;
            }
        }
        if self.mouse_report(button, e.position, false, e.modifiers, false, false, cx) {
            self.mouse_reported_button = Some(e.button);
            self.dragging = false;
            self.selection_changed = false;
            return;
        }
        if e.button != MouseButton::Left {
            return;
        }
        let (point, side) = self.point_and_side(e.position);
        if e.modifiers.shift
            && e.click_count == 1
            && let Some(sel) = &mut self.term.selection
            && !sel.is_empty()
        {
            sel.update(point, side);
            self.dragging = true;
            self.selection_changed = true;
            cx.notify();
            return;
        }
        let kind = match e.click_count {
            2 => SelectionType::Semantic,
            3.. => SelectionType::Lines,
            _ if !cfg!(target_os = "macos") && e.modifiers.alt => SelectionType::Block,
            _ => SelectionType::Simple,
        };
        self.term.selection = Some(Selection::new(kind, point, side));
        self.dragging = true;
        self.selection_changed = kind != SelectionType::Simple;
        cx.notify()
    }
    fn update_drag(&mut self, e: &MouseMoveEvent, cx: &mut Context<Self>) {
        if let Some(drag) = self.scrollbar.drag {
            if e.pressed_button != Some(MouseButton::Left) {
                self.scrollbar.drag = None;
                let still_over = self.scrollbar_hit_contains(e.position);
                self.set_scrollbar_hovered(still_over, cx);
                self.note_scroll_activity(cx);
                cx.notify();
                return;
            }
            if let Some(geom) = self.scrollbar_geometry() {
                let desired_top = f32::from(e.position.y) - drag.grab_offset;
                let target = geom.offset_for_thumb_top(desired_top);
                self.set_display_offset(target);
                self.note_scroll_activity(cx);
                cx.notify();
            }
            return;
        }
        if self.dragging {
            if e.pressed_button != Some(MouseButton::Left) {
                self.finish_drag(cx);
                return;
            }
            let cell_h = f32::from(self.cell.height).max(1.0);
            if !self.term.mode().contains(TermMode::ALT_SCREEN) {
                if e.position.y < self.bounds.top() {
                    let delta = ((f32::from(self.bounds.top() - e.position.y) / cell_h).ceil()
                        as i32)
                        .clamp(1, 5);
                    self.term.scroll_display(Scroll::Delta(delta));
                    self.note_scroll_activity(cx);
                } else if e.position.y > self.bounds.bottom() {
                    let delta = ((f32::from(e.position.y - self.bounds.bottom()) / cell_h).ceil()
                        as i32)
                        .clamp(1, 5);
                    self.term.scroll_display(Scroll::Delta(-delta));
                    self.note_scroll_activity(cx);
                }
            }
            let (point, side) = self.point_and_side(e.position);
            if let Some(sel) = &mut self.term.selection {
                sel.update(point, side);
                self.selection_changed = true;
            }
            cx.notify();
            return;
        }
        let over_bar = self.scrollbar_hit_contains(e.position);
        self.set_scrollbar_hovered(over_bar, cx);
        let mouse = !over_bar
            && (self.term.mode().contains(TermMode::MOUSE_MOTION)
                || (e.pressed_button.is_some()
                    && self.mouse_reported_button == e.pressed_button
                    && self.term.mode().contains(TermMode::MOUSE_DRAG)));
        if mouse {
            let force = self.mouse_reported_button.is_some();
            self.mouse_report(
                32 + match e.pressed_button {
                    Some(MouseButton::Left) => 0,
                    Some(MouseButton::Middle) => 1,
                    Some(MouseButton::Right) => 2,
                    _ => 3,
                },
                e.position,
                false,
                e.modifiers,
                force,
                true,
                cx,
            );
        } else {
            self.last_mouse_motion = None;
        }
    }
    fn finish_drag(&mut self, cx: &mut Context<Self>) {
        if !self.dragging {
            return;
        }
        self.dragging = false;
        let changed = std::mem::take(&mut self.selection_changed);
        if changed {
            if self.copy(cx) {
                cx.emit(PaneNotice::transient("Copied to clipboard"));
            }
        } else if self.term.selection.as_ref().is_some_and(Selection::is_empty) {
            self.term.selection = None;
            cx.notify();
        }
    }
    fn up(&mut self, e: &MouseUpEvent, cx: &mut Context<Self>) {
        if e.button == MouseButton::Left && self.scrollbar.drag.is_some() {
            self.scrollbar.drag = None;
            let still_over = self.scrollbar_hit_contains(e.position);
            self.set_scrollbar_hovered(still_over, cx);
            self.note_scroll_activity(cx);
            cx.notify();
            return;
        }
        if e.button == MouseButton::Left && self.dragging {
            self.finish_drag(cx);
            return;
        }
        if self.mouse_reported_button == Some(e.button) {
            self.mouse_reported_button = None;
            let code = match e.button {
                MouseButton::Left => 0,
                MouseButton::Middle => 1,
                MouseButton::Right => 2,
                _ => return,
            };
            self.mouse_report(code, e.position, true, e.modifiers, true, false, cx);
        }
    }
}
impl Render for Pane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let measure = cx.entity();
        let paint = cx.entity();
        let mut area = div()
            .id("terminal-surface")
            .track_focus(&self.focus)
            .size_full()
            .overflow_hidden()
            .cursor(if self.scrollbar.hovered || self.scrollbar.drag.is_some() {
                CursorStyle::Arrow
            } else {
                CursorStyle::IBeam
            })
            .bg(rgb(colors::BG))
            .on_hover(cx.listener(|s, &hovered: &bool, _, cx| {
                if !hovered && s.scrollbar.drag.is_none() {
                    s.set_scrollbar_hovered(false, cx);
                }
            }))
            .on_key_down(cx.listener(|s, e, w, cx| s.key(e, w, cx)))
            .on_scroll(cx.listener(|s, e: &ScrollEvent, _, cx| {
                let (n, up) =
                    accumulate_scroll_steps(&mut s.scroll_remainder, e.delta, s.cell.height);
                if n == 0 {
                    cx.stop_propagation();
                    return;
                }
                if s.scroll_mouse_report(up, n, e.position, e.modifiers, cx) {
                    // Coalesced into a single terminal input write.
                } else if s
                    .term
                    .mode()
                    .contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL)
                {
                    let seq = if up { b"\x1bOA" } else { b"\x1bOB" };
                    let mut batch = Vec::with_capacity(seq.len() * n);
                    for _ in 0..n {
                        batch.extend_from_slice(seq);
                    }
                    s.write(batch, cx);
                } else {
                    let delta = n as i32;
                    s.scroll_display_and_notify(
                        Scroll::Delta(if up { delta } else { -delta }),
                        cx,
                    );
                }
                cx.stop_propagation()
            }))
            .on_mouse_move(cx.listener(|s, e: &MouseMoveEvent, _, cx| {
                if !s.dragging && s.scrollbar.drag.is_none() && s.mouse_reported_button.is_none() {
                    s.update_drag(e, cx);
                }
            }));
        for button in [MouseButton::Left, MouseButton::Middle, MouseButton::Right] {
            area = area.on_mouse_down(button, cx.listener(|s, e, w, cx| s.down(e, w, cx)));
        }
        let drag_entity = cx.weak_entity();
        area.child(
            canvas(
                move |b, _, cx| measure.update(cx, |s, cx| s.layout(b, cx)),
                move |b, (), w, cx| {
                    let move_target = drag_entity.clone();
                    w.on_mouse_event(move |e: &MouseMoveEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = move_target.update(cx, |s, cx| {
                                if s.dragging
                                    || s.scrollbar.drag.is_some()
                                    || s.mouse_reported_button.is_some()
                                {
                                    s.update_drag(e, cx);
                                }
                            });
                        }
                    });
                    let up_target = drag_entity.clone();
                    w.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = up_target.update(cx, |s, cx| {
                                if (e.button == MouseButton::Left
                                    && (s.dragging || s.scrollbar.drag.is_some()))
                                    || s.mouse_reported_button == Some(e.button)
                                {
                                    s.up(e, cx);
                                }
                            });
                        }
                    });
                    let focus = paint.read(cx).focus.clone();
                    w.handle_input(&focus, ElementInputHandler::new(b, paint.clone()), cx);
                    paint.update(cx, |pane, cx| pane.draw_at(b.origin, w, cx))
                },
            )
            .size_full(),
        )
    }
}
impl EntityInputHandler for Pane {
    fn text_for_range(
        &mut self,
        r: Range<usize>,
        actual: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let utf = self.marked.encode_utf16().collect::<Vec<_>>();
        let slice = utf.get(r.clone())?;
        *actual = Some(r);
        String::from_utf16(slice).ok()
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let n = self.marked.encode_utf16().count();
        Some(UTF16Selection {
            range: n..n,
            reversed: false,
        })
    }
    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        (!self.marked.is_empty()).then(|| 0..self.marked.encode_utf16().count())
    }
    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked.clear();
        cx.notify()
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.observe_completion(w);
        self.marked.clear();
        self.user_write(text.as_bytes().to_vec(), cx)
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<Range<usize>>,
        text: &str,
        _: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.marked = text.into();
        cx.notify()
    }
    fn bounds_for_range(
        &mut self,
        _: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let p = self.term.grid().cursor.point;
        Some(Bounds::new(
            self.bounds.origin
                + point(
                    self.cell.width * p.column.0 as f32,
                    self.cell.height * p.line.0 as f32,
                ),
            self.cell,
        ))
    }
    fn character_index_for_point(
        &mut self,
        _: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
}

fn ring_bell() {
    #[cfg(target_os = "macos")]
    unsafe {
        unsafe extern "C" {
            fn NSBeep();
        }
        NSBeep();
    }
    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "user32")]
        unsafe extern "system" {
            fn MessageBeep(kind: u32) -> i32;
        }
        MessageBeep(0xffffffff);
    }
}

#[cfg(feature = "ui-tests")]
impl Pane {
    pub(super) fn measured_size(&self) -> Option<(u16, u16)> {
        self.desired
    }
    pub(super) fn bounds_for_test(&self) -> Bounds<Pixels> {
        self.bounds
    }
    pub(super) fn cell_for_test(&self) -> Size<Pixels> {
        self.cell
    }
    pub(super) fn display_offset_for_test(&self) -> usize {
        self.term.grid().display_offset()
    }
    pub(super) fn history_size_for_test(&self) -> usize {
        self.term.history_size()
    }
    pub(super) fn scrollbar_hovered_for_test(&self) -> bool {
        self.scrollbar.hovered
    }
    pub fn key_for_test(&mut self, key: &'static str, w: &mut Window, cx: &mut Context<Self>) {
        self.key(
            &KeyDownEvent {
                keystroke: Keystroke::parse(key).unwrap(),
                is_held: false,
                prefer_character_input: false,
            },
            w,
            cx,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CellPoint, Column, Config, Events, Flags, Line, Processor, Selection, SelectionType, Side,
        SizeHint, Term, colors, plan_draw_runs, terminal_font,
    };
    use gpui::{TextSystem, WindowTextSystem, px};
    use std::sync::Arc;

    fn term_with(bytes: &[u8], cols: u16, rows: u16) -> Term<Events> {
        let mut term = Term::new(Config::default(), &SizeHint { cols, rows }, Events::default());
        let mut parser: Processor = Default::default();
        parser.advance(&mut term, bytes);
        term
    }

    #[test]
    fn non_ascii_fallback_and_combining_glyphs_stay_isolated_from_ascii_runs() {
        let term = term_with(
            "🖼 Image: Cute Cat → /root/.gemini".as_bytes(),
            60,
            4,
        );
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
        let summary: Vec<(usize, usize, bool, &str)> = glyphs
            .iter()
            .map(|r| (r.col, r.width, r.isolated, r.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (0, 1, true, "🖼"),
                (2, 15, false, "Image: Cute Cat"),
                (18, 1, true, "→"),
                (20, 13, false, "/root/.gemini"),
            ]
        );

        // Combining marks / VS16 must break both before and after the cluster.
        let term = term_with("ab⚠\u{fe0f}cd".as_bytes(), 20, 2);
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 2);
        let summary: Vec<(usize, usize, bool, &str)> = glyphs
            .iter()
            .map(|r| (r.col, r.width, r.isolated, r.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (0, 2, false, "ab"),
                (2, 1, true, "⚠\u{fe0f}"),
                (3, 2, false, "cd"),
            ]
        );
    }

    #[test]
    fn selection_merges_into_single_background_and_does_not_shift_adjacent_text() {
        let mut term = term_with("🖼 Image: Cute Cat → /root".as_bytes(), 60, 4);
        let mut sel = Selection::new(
            SelectionType::Simple,
            CellPoint::new(Line(0), Column(3)),
            Side::Left,
        );
        sel.update(CellPoint::new(Line(0), Column(19)), Side::Right);
        term.selection = Some(sel);

        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
        assert_eq!(bgs.len(), 1);
        assert_eq!(bgs[0].col, 3);
        assert_eq!(bgs[0].width, 17);
        assert_eq!(bgs[0].color, 0x2b4c7e);

        // 'I' at col 2 stays anchored at col 2 instead of drifting under the selection at col 3.
        assert_eq!(glyphs[0].col, 0);
        assert_eq!(glyphs[0].text, "🖼");
        assert_eq!(glyphs[1].col, 2);
        assert_eq!(glyphs[1].text, "Image: Cute Cat");
    }

    #[test]
    fn focused_block_cursor_on_wide_char_covers_both_columns() {
        let mut term = term_with("中a".as_bytes(), 20, 2);
        // Alacritty normalizes a cursor on a wide-char spacer back to the wide cell.
        term.grid_mut().cursor.point = CellPoint::new(Line(0), Column(1));
        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), true, &[], None, 2);
        assert_eq!(bgs.len(), 1);
        assert_eq!(bgs[0].col, 0);
        assert_eq!(bgs[0].width, 2);
        assert_eq!(bgs[0].color, colors::FG);
        assert_eq!(glyphs[0].col, 0);
        assert_eq!(glyphs[0].width, 2);
        assert_eq!(glyphs[0].ink.fg, colors::BG);
        assert_eq!(glyphs[1].col, 2);
        assert_eq!(glyphs[1].text, "a");
    }

    #[test]
    fn shaped_ascii_positions_align_with_cell_grid_after_fallback_glyphs() {
        let platform = gpui_platform::current_platform(false);
        let ts = WindowTextSystem::new(Arc::new(TextSystem::new(platform.text_system())));
        let font_size = px(13.5);
        let id = ts.resolve_font(&terminal_font(Flags::empty()));
        let cw = ts.advance(id, font_size, 'M').unwrap().width;

        for sample in [
            "🖼 Image: Cute Cat → /root/.gemini",
            "➜ hello world",
            "❯\u{a0}hello world",
            "⚠ warning text",
            "⏺ agent output",
            "❘ narrow symbol text",
            "中文 hello",
        ] {
            let term = term_with(sample.as_bytes(), 80, 4);
            let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
            for run in &glyphs {
                if run.isolated {
                    continue;
                }
                let shaped = run.shape(font_size, cw, &ts);
                for (i, ch) in run.text.char_indices() {
                    if ch == ' ' {
                        continue;
                    }
                    let rendered_x = f32::from(cw) * run.col as f32 + f32::from(shaped.x_for_index(i));
                    let expected_x = f32::from(cw) * (run.col + i) as f32;
                    assert!(
                        (rendered_x - expected_x).abs() < 0.05,
                        "sample={sample:?} run={:?} char={ch:?} at col {}: rendered={rendered_x:.3} expected={expected_x:.3}",
                        run.text,
                        run.col + i
                    );
                }
            }
        }
    }

    #[test]
    fn pixel_scroll_accumulates_sub_row_deltas_and_resets_on_direction_flip() {
        use super::{accumulate_scroll_steps, encode_mouse_sequence};
        use alacritty_terminal::term::TermMode;
        use gpui::{ScrollDelta, point};

        let cell_h = px(20.);
        let mut rem = 0.0;
        // Three small 8px ticks = 24px -> emits 1 step once threshold is reached, keeping 4px remainder.
        assert_eq!(
            accumulate_scroll_steps(&mut rem, ScrollDelta::Pixels(point(px(0.), px(8.))), cell_h),
            (0, false)
        );
        assert_eq!(
            accumulate_scroll_steps(&mut rem, ScrollDelta::Pixels(point(px(0.), px(8.))), cell_h),
            (0, false)
        );
        assert_eq!(
            accumulate_scroll_steps(&mut rem, ScrollDelta::Pixels(point(px(0.), px(8.))), cell_h),
            (1, true)
        );
        assert!((rem - 0.2).abs() < 1e-4);

        // Reversing direction clears the old remainder so opposite scroll starts cleanly.
        assert_eq!(
            accumulate_scroll_steps(&mut rem, ScrollDelta::Pixels(point(px(0.), px(-20.))), cell_h),
            (1, false)
        );
        assert!(rem.abs() < 1e-4);

        // Discrete line scroll clears remainder and clamps to 60.
        rem = 0.7;
        assert_eq!(
            accumulate_scroll_steps(&mut rem, ScrollDelta::Lines(point(0., 80.)), cell_h),
            (60, true)
        );
        assert_eq!(rem, 0.0);

        // SGR and X10 mouse sequence encoding.
        assert_eq!(
            encode_mouse_sequence(TermMode::MOUSE_MODE | TermMode::SGR_MOUSE, 64, 12, 5, false, 0),
            Some(b"\x1b[<64;12;5M".to_vec())
        );
        assert_eq!(
            encode_mouse_sequence(TermMode::MOUSE_MODE, 64, 224, 5, false, 0),
            None
        );
    }

    #[test]
    fn search_collects_case_word_regex_wrapped_and_highlights_active_vs_other() {
        use super::{
            MAX_SEARCH_MATCHES, SEARCH_ACTIVE_BG, SEARCH_ACTIVE_FG, SEARCH_MATCH_BG, SearchOptions,
            build_search_pattern, collect_search_matches,
        };
        use alacritty_terminal::{grid::Dimensions, term::search::RegexSearch};

        let term = term_with(
            b"Error error ERROR\r\nerr_code error-msg myerror\r\nwrapped_token_across_edge\r\n",
            20,
            6,
        );

        // Case-insensitive matches all case variations even when query contains uppercase.
        let pat = build_search_pattern("ERROR", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (all, truncated) = collect_search_matches(&term, &mut rx, false);
        assert!(!truncated);
        assert_eq!(all.len(), 5);

        // Explicit case-sensitive with lowercase query excludes "Error" and "ERROR".
        let pat = build_search_pattern(
            "error",
            SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (cs, _) = collect_search_matches(&term, &mut rx, false);
        assert_eq!(cs.len(), 3);

        // Whole word matches standalone "error" and "error-msg" (hyphen is non-word), excludes "myerror".
        let (ww, _) = collect_search_matches(&term, &mut rx, true);
        assert_eq!(ww.len(), 2);

        // Wrapped line match spans across row boundary.
        let pat = build_search_pattern("wrapped_token_across_edge", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (wrapped, _) = collect_search_matches(&term, &mut rx, true);
        assert_eq!(wrapped.len(), 1);
        assert_ne!(wrapped[0].start().line, wrapped[0].end().line);

        // Regex search with alternation and invalid regex rejection.
        let pat = build_search_pattern(
            "err_[a-z]+|ERROR",
            SearchOptions {
                case_sensitive: true,
                regex: true,
                whole_word: false,
            },
        )
        .unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (rx_matches, _) = collect_search_matches(&term, &mut rx, false);
        assert_eq!(rx_matches.len(), 2);
        let bad = build_search_pattern(
            "(unclosed",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(RegexSearch::new(&bad).is_err());

        // Highlighting distinguishes active match (gold + dark ink) from other matches (amber).
        let (bgs, glyphs) = plan_draw_runs(
            term.renderable_content(),
            false,
            &all,
            all.get(1),
            term.screen_lines(),
        );
        assert!(bgs.iter().any(|bg| bg.color == SEARCH_ACTIVE_BG));
        assert!(bgs.iter().any(|bg| bg.color == SEARCH_MATCH_BG));
        assert!(glyphs.iter().any(|g| g.ink.fg == SEARCH_ACTIVE_FG));

        // Capping on large scrollback preserves the MAX_SEARCH_MATCHES most recent matches.
        let mut big = Term::new(
            Config {
                scrolling_history: 15_000,
                ..Default::default()
            },
            &SizeHint { cols: 10, rows: 4 },
            Events::default(),
        );
        let mut parser: Processor = Default::default();
        parser.advance(&mut big, &b"x\r\n".repeat(12_000));
        let pat = build_search_pattern("x", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (capped, truncated) = collect_search_matches(&big, &mut rx, false);
        assert!(truncated);
        assert_eq!(capped.len(), MAX_SEARCH_MATCHES);
        // The newest match on the visible screen must be retained.
        assert!(capped.last().unwrap().start().line >= Line(0));
    }

    #[test]
    fn scrollbar_geometry_maps_top_bottom_clamped_thumb_and_drag_bijectively() {
        use super::{SCROLLBAR_MIN_THUMB_H, SCROLLBAR_PAD_Y, ScrollbarGeometry};

        // Hidden when there is no scrollback or collapsed viewport.
        assert_eq!(ScrollbarGeometry::compute(0.0, 400.0, 0, 24, 0), None);
        assert_eq!(ScrollbarGeometry::compute(0.0, 10.0, 100, 24, 0), None);

        // Live bottom (offset = 0) aligns flush with bottom of track; top (offset = history) aligns with top.
        let bottom = ScrollbarGeometry::compute(10.0, 400.0, 500, 25, 0).unwrap();
        let track_bottom = bottom.track_top + bottom.track_h;
        assert!((bottom.track_top - (10.0 + SCROLLBAR_PAD_Y)).abs() < 1e-4);
        assert!(((bottom.thumb_top + bottom.thumb_h) - track_bottom).abs() < 1e-4);
        assert_eq!(bottom.offset_for_thumb_top(bottom.thumb_top), 0);

        let top = ScrollbarGeometry::compute(10.0, 400.0, 500, 25, 500).unwrap();
        assert!((top.thumb_top - top.track_top).abs() < 1e-4);
        assert_eq!(top.offset_for_thumb_top(top.thumb_top), 500);

        // Huge 100,000-line scrollback clamps thumb to SCROLLBAR_MIN_THUMB_H while preserving exact top/mid/bottom mapping.
        let huge = ScrollbarGeometry::compute(0.0, 500.0, 100_000, 30, 0).unwrap();
        assert!((huge.thumb_h - SCROLLBAR_MIN_THUMB_H).abs() < 1e-4);
        assert_eq!(huge.offset_for_thumb_top(huge.track_top), 100_000);
        assert_eq!(
            huge.offset_for_thumb_top(huge.track_top + huge.max_travel),
            0
        );
        assert_eq!(
            huge.offset_for_thumb_top(huge.track_top + huge.max_travel * 0.5),
            50_000
        );
        // Overshooting beyond track clamps cleanly to history / 0.
        assert_eq!(huge.offset_for_thumb_top(huge.track_top - 200.0), 100_000);
        assert_eq!(huge.offset_for_thumb_top(huge.track_top + 2_000.0), 0);
    }

    #[test]
    fn osc_7770_scanner_extracts_open_session_across_chunks_and_preserves_other_escapes() {
        use super::{Osc7770Scanner, PaneOpenSession, parse_open_session_osc_data};
        use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

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

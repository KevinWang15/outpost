mod input;
mod osc7770;
mod render;
mod scrollbar;
mod search;

pub use osc7770::PaneOpenSession;
pub use search::{SearchOptions, SearchStatus};

use crate::{
    bridge::Bridge,
    colors,
    pty::{Local, Output},
};
use alacritty_terminal::{
    event::{Event as AnsiEvent, EventListener, WindowSize},
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point as CellPoint, Side},
    selection::{Selection, SelectionType},
    term::{Config, Term, TermMode, cell::Flags},
    vte::ansi::{Processor, Rgb},
};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui::*;
use osc7770::Osc7770Scanner;
use render::terminal_font;
use scrollbar::ScrollbarState;
use search::SearchState;
use serde_json::json;
use std::{
    cell::RefCell,
    path::Path,
    rc::Rc,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

pub(crate) const DEFAULT_HISTORY: usize = 10_000;
// Alacritty indexes lines with i32 and adds the viewport height when reflowing.
pub(crate) const MAX_HISTORY: usize = i32::MAX as usize - 200;
const PANE_RIGHT_MARGIN: f32 = 5.0;
pub(crate) const BELL_AUTO_HIDE: Duration = Duration::from_secs(2);

static USAGE_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_usage_seq() -> u64 {
    USAGE_SEQ.fetch_add(1, Ordering::Relaxed)
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
    bell_background: bool,
    bell_generation: u64,
    pub last_used: u64,
    pub activity: String,
    pub activity_blocked_kind: Option<String>,
    pub activity_progress: Option<u8>,
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
    pub(crate) grid_visible: bool,
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

    pub(crate) fn restarted_local(&self, w: &mut Window, cx: &mut App) -> Result<Entity<Self>> {
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
            bell_background: false,
            bell_generation: 0,
            last_used: next_usage_seq(),
            activity: String::new(),
            activity_blocked_kind: None,
            activity_progress: None,
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
                    self.bell_background = !self.active;
                    if self.sound {
                        ring_bell();
                    }
                    if self.active {
                        self.schedule_bell_auto_hide(cx);
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

    pub fn touch_used(&mut self) {
        self.last_used = next_usage_seq();
    }

    pub fn clear_bell(&mut self, cx: &mut Context<Self>) {
        self.bell_generation = self.bell_generation.wrapping_add(1);
        self.bell_background = false;
        if self.bell {
            self.bell = false;
            cx.emit(PaneChanged);
            cx.notify();
        }
    }

    fn schedule_bell_auto_hide(&mut self, cx: &mut Context<Self>) {
        self.bell_generation = self.bell_generation.wrapping_add(1);
        let generation = self.bell_generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(BELL_AUTO_HIDE).await;
            let _ = this.update(cx, |pane, cx| {
                if pane.bell && pane.bell_generation == generation && pane.active {
                    pane.bell = false;
                    pane.bell_background = false;
                    cx.emit(PaneChanged);
                    cx.notify();
                }
            });
        })
        .detach();
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
            self.touch_used();
            if self.bell {
                self.schedule_bell_auto_hide(cx);
            }
        } else if self.bell && !self.bell_background {
            // The bell fired while this pane was already active; leaving it dismisses the flash.
            self.clear_bell(cx);
        } else {
            // Cancel any pending auto-hide so flicking past a background alert keeps it unread.
            self.bell_generation = self.bell_generation.wrapping_add(1);
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

    pub fn selected_string(&self) -> Option<String> {
        self.term.selection_to_string().filter(|s| !s.is_empty())
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

    pub(super) fn layout(&mut self, b: Bounds<Pixels>, cx: &mut Context<Self>) {
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
}

impl Drop for Pane {
    fn drop(&mut self) {
        self.command("close", json!({}))
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
    #[cfg(unix)]
    pub(crate) fn measured_size(&self) -> Option<(u16, u16)> {
        self.desired
    }
    pub(crate) fn bounds_for_test(&self) -> Bounds<Pixels> {
        self.bounds
    }
    pub(crate) fn cell_for_test(&self) -> Size<Pixels> {
        self.cell
    }
    pub(crate) fn display_offset_for_test(&self) -> usize {
        self.term.grid().display_offset()
    }
    pub(crate) fn history_size_for_test(&self) -> usize {
        self.term.history_size()
    }
    pub(crate) fn scrollbar_hovered_for_test(&self) -> bool {
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
pub(super) mod tests {
    use super::{Events, SizeHint};
    use alacritty_terminal::{
        term::{Config, Term},
        vte::ansi::Processor,
    };

    pub(super) fn term_with(bytes: &[u8], cols: u16, rows: u16) -> Term<Events> {
        let mut term = Term::new(Config::default(), &SizeHint { cols, rows }, Events::default());
        let mut parser: Processor = Default::default();
        parser.advance(&mut term, bytes);
        term
    }
}

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
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui::{prelude::*, *};
use serde_json::json;
use std::{cell::RefCell, ops::Range, path::Path, rc::Rc};

pub(super) const DEFAULT_HISTORY: usize = 10_000;
// Alacritty indexes lines with i32 and adds the viewport height when reflowing.
pub(super) const MAX_HISTORY: usize = i32::MAX as usize - 200;

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
pub struct Pane {
    term: Term<Events>,
    parser: Processor,
    events: Events,
    transport: Transport,
    pub focus: FocusHandle,
    pub title: String,
    pub mark: Option<&'static crate::agent_mark::AgentMark>,
    pub status: String,
    pub font_size: f32,
    scrollback: usize,
    pub bell: bool,
    pub activity: String,
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
    pending_copy: Option<String>,
    marked: String,
}
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
            status: String::new(),
            font_size,
            scrollback: DEFAULT_HISTORY,
            bell: false,
            activity: String::new(),
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
            pending_copy: None,
            marked: String::new(),
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
        self.parser.advance(&mut self.term, bytes);
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
        })
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
    }
    pub fn reset(&mut self, cols: u16, rows: u16) {
        self.grid_visible = false;
        self.pending_copy = None;
        self.term = Term::new(
            Config {
                scrolling_history: self.scrollback,
                ..Default::default()
            },
            &SizeHint { cols, rows },
            self.events.clone(),
        );
        self.parser = Default::default()
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
        self.term.scroll_display(Scroll::Bottom);
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
    pub fn find(&mut self, query: &str, next: bool, cx: &mut Context<Self>) {
        use alacritty_terminal::{index::Direction, term::search::RegexSearch};
        if query.is_empty() {
            return;
        }
        let pattern = query
            .chars()
            .map(|c| {
                if ".+*?()[]{}^$|\\".contains(c) {
                    format!("\\{c}")
                } else {
                    c.to_string()
                }
            })
            .collect::<String>();
        let Ok(mut search) = RegexSearch::new(&pattern) else {
            return;
        };
        let direction = if next {
            Direction::Right
        } else {
            Direction::Left
        };
        let origin = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
            .map(|r| {
                if next {
                    r.end
                        .add(&self.term, alacritty_terminal::index::Boundary::Grid, 1)
                } else {
                    r.start
                        .sub(&self.term, alacritty_terminal::index::Boundary::Grid, 1)
                }
            })
            .unwrap_or(CellPoint::new(
                Line(-(self.term.grid().display_offset() as i32)),
                Column(0),
            ));
        if let Some(found) = self
            .term
            .search_next(&mut search, origin, direction, Side::Left, None)
        {
            let mut sel = Selection::new(SelectionType::Simple, *found.start(), Side::Left);
            sel.update(*found.end(), Side::Right);
            self.term.scroll_to_point(*found.start());
            self.term.selection = Some(sel);
            cx.notify()
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
        let cols = (b.size.width / cw).floor();
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
        cx: &mut Context<Self>,
    ) -> bool {
        let mode = *self.term.mode();
        if (!force && Self::bypass_mouse_mode(mods)) || !mode.intersects(TermMode::MOUSE_MODE) {
            return false;
        }
        let pos = self.point(p);
        if pos.line.0 < 0 {
            return false;
        }
        let x = pos.column.0 + 1;
        let y = pos.line.0 as usize + 1;
        let flags = 8 * u8::from(mods.alt) + 16 * u8::from(mods.control);
        let data = if mode.contains(TermMode::SGR_MOUSE) {
            format!(
                "\x1b[<{};{x};{y}{}",
                code + flags,
                if up { "m" } else { "M" }
            )
            .into_bytes()
        } else if x <= 223 && y <= 223 {
            vec![
                27,
                91,
                77,
                32 + if up { 3 } else { code } + flags,
                32 + x as u8,
                32 + y as u8,
            ]
        } else {
            return true;
        };
        self.write(data, cx);
        true
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

fn plan_draw_runs(
    view: alacritty_terminal::term::RenderableContent<'_>,
    focused: bool,
) -> (Vec<BgRun>, Vec<GlyphRun>) {
    let cursor = view.cursor.point;
    let block_cursor = focused && view.cursor.shape == CursorShape::Block;
    let mut bgs = Vec::new();
    let mut glyphs = Vec::new();
    let mut pending_bg: Option<BgRun> = None;
    let mut pending_glyph: Option<GlyphRun> = None;

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
        let selected = view.selection.is_some_and(|s| {
            s.contains(item.point)
                || (cell.flags.contains(Flags::WIDE_CHAR)
                    && s.contains(CellPoint::new(item.point.line, item.point.column + 1)))
        });
        if selected {
            bg = 0x2b4c7e;
            if cell.flags.contains(Flags::INVERSE) {
                fg = colors::FG;
            }
        }
        if block_cursor && item.point == cursor {
            fg = colors::BG;
            bg = colors::FG;
        }
        let width = if cell.flags.contains(Flags::WIDE_CHAR) {
            2
        } else {
            1
        };
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
    pub(super) fn draw_at(&self, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        if !self.grid_visible {
            return;
        }
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
        let (bgs, glyphs) = plan_draw_runs(view, focused);
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
        if e.button == MouseButton::Left && (e.modifiers.platform || e.modifiers.control) {
            let point = self.point(e.position);
            if let Some(url) = self.hyperlink_at(point) {
                cx.open_url(&url);
                return;
            }
        }
        if self.mouse_report(button, e.position, false, e.modifiers, false, cx) {
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
                } else if e.position.y > self.bounds.bottom() {
                    let delta = ((f32::from(e.position.y - self.bounds.bottom()) / cell_h).ceil()
                        as i32)
                        .clamp(1, 5);
                    self.term.scroll_display(Scroll::Delta(-delta));
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
        let mouse = self.term.mode().contains(TermMode::MOUSE_MOTION)
            || (e.pressed_button.is_some()
                && self.mouse_reported_button == e.pressed_button
                && self.term.mode().contains(TermMode::MOUSE_DRAG));
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
                cx,
            );
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
            self.mouse_report(code, e.position, true, e.modifiers, true, cx);
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
            .cursor(CursorStyle::IBeam)
            .bg(rgb(colors::BG))
            .on_key_down(cx.listener(|s, e, w, cx| s.key(e, w, cx)))
            .on_scroll(cx.listener(|s, e: &ScrollEvent, _, cx| {
                let delta = match e.delta {
                    ScrollDelta::Lines(p) => p.y,
                    ScrollDelta::Pixels(p) => f32::from(p.y) / f32::from(s.cell.height),
                };
                if delta.abs() < 0.01 {
                    return;
                }
                let n = (delta.abs().ceil() as i32).clamp(1, 60);
                if s.term.mode().intersects(TermMode::MOUSE_MODE) && !Self::bypass_mouse_mode(e.modifiers) {
                    for _ in 0..n {
                        s.mouse_report(
                            if delta > 0. { 64 } else { 65 },
                            e.position,
                            false,
                            e.modifiers,
                            false,
                            cx,
                        );
                    }
                } else if s
                    .term
                    .mode()
                    .contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL)
                {
                    for _ in 0..n {
                        s.write(if delta > 0. { b"\x1bOA" } else { b"\x1bOB" }.to_vec(), cx)
                    }
                } else {
                    s.term
                        .scroll_display(Scroll::Delta(if delta > 0. { n } else { -n }));
                    cx.notify()
                }
                cx.stop_propagation()
            }))
            .on_mouse_move(cx.listener(|s, e: &MouseMoveEvent, _, cx| {
                if !s.dragging && s.mouse_reported_button.is_none() {
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
                                if s.dragging || s.mouse_reported_button.is_some() {
                                    s.update_drag(e, cx);
                                }
                            });
                        }
                    });
                    let up_target = drag_entity.clone();
                    w.on_mouse_event(move |e: &MouseUpEvent, phase, _, cx| {
                        if phase == DispatchPhase::Capture {
                            let _ = up_target.update(cx, |s, cx| {
                                if (e.button == MouseButton::Left && s.dragging)
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
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false);
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
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false);
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

        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), false);
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
        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), true);
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
            let (_, glyphs) = plan_draw_runs(term.renderable_content(), false);
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
}

use crate::{
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
    Local(Local),
    Remote(Bridge, u64),
}
#[derive(Clone)]
struct LocalProfile {
    shell: String,
    args: Vec<String>,
    home: std::path::PathBuf,
}
pub struct Pane {
    profile: Option<LocalProfile>,
    term: Term<Events>,
    parser: Processor,
    events: Events,
    transport: Transport,
    pub image_syntax: String,
    pub wsl: bool,
    images: Option<tempfile::TempDir>,
    image_bytes: usize,
    pub focus: FocusHandle,
    pub title: String,
    pub route: Option<String>,
    pub status: String,
    pub font_size: f32,
    pub bell: bool,
    pub activity: String,
    pub waiting: u64,
    pub draft: String,
    pub sending: bool,
    pub restoring: bool,
    pub sound: bool,
    pub server: Option<String>,
    focus_subs: Vec<Subscription>,
    active: bool,
    bounds: Bounds<Pixels>,
    cell: Size<Pixels>,
    desired: (u16, u16),
    dragging: bool,
    marked: String,
}
pub struct PaneMenu;
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
    ) -> Result<Entity<Self>> {
        let (local, stream) = Local::open(shell, args, home, 80, 24)?;
        let title = Path::new(shell)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        Ok(cx.new(|cx| {
            let mut pane = Self::new(Transport::Local(local), title, font_size, w, cx);
            pane.profile = Some(LocalProfile {
                shell: shell.to_owned(),
                args: args.to_vec(),
                home: home.to_owned(),
            });
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
            pane
        }))
    }
    pub(super) fn restarted_local(&self, w: &mut Window, cx: &mut App) -> Result<Entity<Self>> {
        let profile = self
            .profile
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The local shell profile is unavailable."))?;
        let pane = Self::local(
            &profile.shell,
            &profile.args,
            &profile.home,
            self.font_size,
            w,
            cx,
        )?;
        pane.update(cx, |next, _| {
            next.image_syntax = self.image_syntax.clone();
            next.wsl = self.wsl;
            next.sound = self.sound;
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
            scrolling_history: 10000,
            ..Default::default()
        };
        let focus = cx.focus_handle();
        Self {
            term: Term::new(config, &SizeHint { cols: 80, rows: 24 }, events.clone()),
            parser: Default::default(),
            events,
            transport,
            profile: None,
            image_syntax: "posix".into(),
            wsl: false,
            images: None,
            image_bytes: 0,
            focus,
            title,
            route: None,
            status: String::new(),
            font_size,
            bell: false,
            activity: String::new(),
            waiting: 0,
            draft: String::new(),
            sending: false,
            restoring: false,
            sound: true,
            server: None,
            focus_subs: Vec::new(),
            active: false,
            bounds: Bounds::default(),
            cell: size(px(8.), px(17.)),
            desired: (80, 24),
            dragging: false,
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
        let local = matches!(self.transport, Transport::Local(_));
        for e in events {
            match e {
                AnsiEvent::Title(s) if local => {
                    self.title = s.chars().take(256).collect();
                    cx.emit(PaneChanged)
                }
                AnsiEvent::PtyWrite(data) if local => self.write(data.into_bytes(), cx),
                AnsiEvent::ClipboardStore(_, text) if !self.restoring => {
                    cx.write_to_clipboard(ClipboardItem::new_string(text))
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
                        num_cols: self.desired.0,
                        num_lines: self.desired.1,
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
    pub fn reset(&mut self, cols: u16, rows: u16) {
        self.term = Term::new(
            Config {
                scrolling_history: 10000,
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
        if matches!(self.transport, Transport::Local(_))
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
        match &self.transport {
            Transport::Local(l) => {
                if let Err(e) = l.send(bytes) {
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
        let text = text.replace('\x1b', "");
        let input = if self.term.mode().contains(TermMode::BRACKETED_PASTE) {
            format!("\x1b[200~{text}\x1b[201~")
        } else {
            text.replace("\r\n", "\r").replace('\n', "\r")
        };
        self.user_write(input.into_bytes(), cx);
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
    pub fn copy(&self, cx: &mut App) {
        if let Some(text) = self.term.selection_to_string() {
            cx.write_to_clipboard(ClipboardItem::new_string(text))
        }
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
        let id = ts.resolve_font(&font(FAMILY));
        let cw = ts
            .advance(id, px(self.font_size), 'M')
            .map(|a| a.width)
            .unwrap_or(px(self.font_size * 0.61));
        self.cell = size(cw, px((self.font_size * 1.24).ceil()));
        let dims = (
            (b.size.width / cw).floor().clamp(2., 400.) as u16,
            (b.size.height / self.cell.height).floor().clamp(2., 200.) as u16,
        );
        if dims != self.desired {
            self.desired = dims;
            match &self.transport {
                Transport::Local(l) => {
                    let _ = l.resize(dims.0, dims.1);
                    self.geometry(dims.0, dims.1)
                }
                Transport::Remote(..) => {
                    self.command("resize", json!({"cols":dims.0,"rows":dims.1}))
                }
            }
        }
    }
    fn point(&self, p: Point<Pixels>) -> CellPoint {
        let col = ((p.x - self.bounds.origin.x) / self.cell.width)
            .floor()
            .clamp(0., (self.term.columns() - 1) as f32) as usize;
        let line = ((p.y - self.bounds.origin.y) / self.cell.height)
            .floor()
            .clamp(0., (self.term.screen_lines() - 1) as f32) as i32
            - self.term.grid().display_offset() as i32;
        CellPoint::new(Line(line), Column(col))
    }
    fn mouse_report(
        &mut self,
        code: u8,
        p: Point<Pixels>,
        up: bool,
        mods: Modifiers,
        cx: &mut Context<Self>,
    ) -> bool {
        let mode = *self.term.mode();
        if mods.shift || !mode.intersects(TermMode::MOUSE_MODE) {
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

#[derive(PartialEq, Clone, Copy)]
struct Ink {
    fg: u32,
    bg: u32,
    flags: Flags,
}
struct GlyphRun {
    line: i32,
    col: usize,
    width: usize,
    ink: Ink,
    text: String,
}
impl GlyphRun {
    fn paint(self, pane: &Pane, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        let base = grid_origin
            + point(
                pane.cell.width * self.col as f32,
                pane.cell.height * self.line as f32,
            );
        if self.ink.bg != colors::BG {
            w.paint_quad(fill(
                Bounds::new(
                    base,
                    size(pane.cell.width * self.width as f32, pane.cell.height),
                ),
                rgb(self.ink.bg),
            ))
        }
        if self.text.trim().is_empty()
            && !self
                .ink
                .flags
                .intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        {
            return;
        }
        let mut face = font(FAMILY);
        if self.ink.flags.contains(Flags::BOLD) {
            face.weight = FontWeight::BOLD
        }
        if self.ink.flags.contains(Flags::ITALIC) {
            face.style = FontStyle::Italic
        }
        let run =
            TextRun {
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
        let line = w
            .text_system()
            .shape_line(self.text.into(), px(pane.font_size), &[run], None);
        let _ = line.paint(base, pane.cell.height, TextAlign::Left, None, w, cx);
    }
}
impl Pane {
    pub(super) fn draw_at(&self, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        let view = self.term.renderable_content();
        let mut pending: Option<GlyphRun> = None;
        let cursor = view.cursor.point;
        let cursor_row = cursor.line.0 + view.display_offset as i32;
        let cursor_origin = grid_origin
            + point(
                self.cell.width * cursor.column.0 as f32,
                self.cell.height * cursor_row as f32,
            );
        let focused = self.focus.is_focused(w);
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
            if view.selection.is_some_and(|s| s.contains(item.point)) {
                bg = 0x3d3d3d;
            }
            if focused && view.cursor.shape == CursorShape::Block && item.point == cursor {
                fg = colors::BG;
                bg = colors::FG;
            }
            let width = if cell.flags.contains(Flags::WIDE_CHAR) {
                2
            } else {
                1
            };
            let ink = Ink {
                fg,
                bg,
                flags: cell.flags
                    & (Flags::BOLD | Flags::ITALIC | Flags::ALL_UNDERLINES | Flags::STRIKEOUT),
            };
            if !pending.as_ref().is_some_and(|r| {
                r.line == row && r.col + r.width == col && r.ink == ink && width == 1
            }) {
                if let Some(r) = pending.take() {
                    r.paint(self, grid_origin, w, cx)
                }
                pending = Some(GlyphRun {
                    line: row,
                    col,
                    width: 0,
                    ink,
                    text: String::new(),
                });
            }
            let r = pending.as_mut().unwrap();
            r.width += width;
            if cell.flags.contains(Flags::HIDDEN) {
                r.text.push(' ')
            } else {
                r.text.push(cell.c);
                if let Some(extra) = cell.zerowidth() {
                    r.text.extend(extra.iter().copied())
                }
            }
            // Fallback fonts and wide glyphs have independent advances.
            if width == 2 || cell.zerowidth().is_some() {
                pending.take().unwrap().paint(self, grid_origin, w, cx)
            }
        }
        if let Some(r) = pending {
            r.paint(self, grid_origin, w, cx)
        }
        if cursor_row >= 0
            && (cursor_row as usize) < self.term.screen_lines()
            && view.cursor.shape != CursorShape::Hidden
        {
            let (origin, extent) = match view.cursor.shape {
                CursorShape::Beam => (cursor_origin, size(px(2.), self.cell.height)),
                CursorShape::Underline => (
                    cursor_origin + point(px(0.), self.cell.height - px(2.)),
                    size(self.cell.width, px(2.)),
                ),
                _ if !focused => (
                    cursor_origin + point(px(0.), self.cell.height - px(1.)),
                    size(self.cell.width, px(1.)),
                ),
                _ => (cursor_origin, Size::default()),
            };
            w.paint_quad(fill(Bounds::new(origin, extent), rgb(colors::FG)));
            if !self.marked.is_empty() {
                GlyphRun {
                    line: cursor_row,
                    col: cursor.column.0,
                    width: self.marked.chars().count(),
                    ink: Ink {
                        fg: colors::FG,
                        bg: colors::BG,
                        flags: Flags::UNDERLINE,
                    },
                    text: self.marked.clone(),
                }
                .paint(self, grid_origin, w, cx);
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
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        for entry in item.entries() {
            if let ClipboardEntry::Image(image) = entry {
                let mime = match image.format {
                    ImageFormat::Png => "image/png",
                    ImageFormat::Jpeg => "image/jpeg",
                    ImageFormat::Webp => "image/webp",
                    _ => continue,
                };
                if self.server.is_some() {
                    self.command(
                        "image",
                        json!({"mime":mime,"data":STANDARD.encode(&image.bytes)}),
                    );
                } else {
                    let ext = mime.split('/').next_back().unwrap_or("png");
                    let outcome = (|| -> Result<String> {
                        anyhow::ensure!(
                            image.bytes.len() <= 16 * 1024 * 1024,
                            "Images must be 16 MiB or smaller."
                        );
                        anyhow::ensure!(
                            self.image_bytes + image.bytes.len() <= 256 * 1024 * 1024,
                            "This tab has reached its image storage limit."
                        );
                        if self.images.is_none() {
                            self.images = Some(
                                tempfile::Builder::new()
                                    .prefix("outpost-images-")
                                    .tempdir()?,
                            );
                        }
                        let mut file = tempfile::Builder::new()
                            .prefix("clipboard-")
                            .suffix(&format!(".{ext}"))
                            .tempfile_in(self.images.as_ref().unwrap().path())?;
                        use std::io::Write;
                        file.write_all(&image.bytes)?;
                        let (_, path) = file.keep()?;
                        self.image_bytes += image.bytes.len();
                        let path = if self.wsl {
                            let output = std::process::Command::new("wsl.exe")
                                .args(["--exec", "wslpath", "-u"])
                                .arg(path)
                                .output()?;
                            let path = String::from_utf8(output.stdout)?.trim().to_owned();
                            anyhow::ensure!(
                                output.status.success() && path.starts_with('/'),
                                "Could not resolve image path in WSL"
                            );
                            path
                        } else {
                            path.display().to_string()
                        };
                        Ok(match self.image_syntax.as_str() {
                            "powershell" => format!("'{}' ", path.replace('\'', "''")),
                            "cmd" => format!("\"{}\" ", path),
                            _ => format!("'{}' ", path.replace('\'', "'\''")),
                        })
                    })();
                    match outcome {
                        Ok(path) => self.paste(path, cx),
                        Err(e) => {
                            self.status = e.to_string();
                            cx.emit(PaneChanged)
                        }
                    }
                }
                return;
            }
        }
        if let Some(text) = item.text() {
            self.paste(text, cx);
        }
    }
    fn observe_completion(&self, w: &Window) {
        if self.activity == "finished" && w.is_window_active() && self.focus.is_focused(w) {
            self.command("observe", json!({}));
        }
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.observe_completion(w);
        if !self.marked.is_empty() {
            return;
        }
        if e.prefer_character_input {
            return;
        }
        let k = &e.keystroke;
        let shortcut = if cfg!(target_os = "macos") {
            k.modifiers.platform
        } else {
            k.modifiers.control && k.modifiers.shift
        };
        if shortcut && !k.modifiers.alt {
            match k.key.as_str() {
                "a" => self.select_all(cx),
                "c" => self.copy(cx),
                "v" => self.paste_clipboard(cx),
                "k" => self.clear_screen(true, cx),
                _ => return,
            };
            cx.stop_propagation();
            return;
        }
        if let Some(bytes) = keys::encode(k, *self.term.mode()) {
            self.user_write(bytes, cx);
            w.prevent_default();
            cx.stop_propagation()
        }
    }
    fn down(&mut self, e: &MouseDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.focus.focus(w, cx);
        self.observe_completion(w);
        let button = match e.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            _ => return,
        };
        if self.mouse_report(button, e.position, false, e.modifiers, cx) {
            return;
        }
        if e.button == MouseButton::Right {
            cx.emit(PaneMenu);
            return;
        }
        if e.button != MouseButton::Left {
            return;
        }
        let point = self.point(e.position);
        if e.modifiers.platform || e.modifiers.control {
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
            if let Some(url) = uri
                && (url.starts_with("https://") || url.starts_with("http://"))
            {
                cx.open_url(&url);
                return;
            }
        }
        let kind = match e.click_count {
            2 => SelectionType::Semantic,
            3.. => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.term.selection = Some(Selection::new(kind, point, Side::Left));
        self.dragging = true;
        cx.notify()
    }
    fn up(&mut self, e: &MouseUpEvent, cx: &mut Context<Self>) {
        self.dragging = false;
        let code = match e.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            _ => return,
        };
        self.mouse_report(code, e.position, true, e.modifiers, cx);
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
                if s.term.mode().intersects(TermMode::MOUSE_MODE) && !e.modifiers.shift {
                    for _ in 0..n {
                        s.mouse_report(
                            if delta > 0. { 64 } else { 65 },
                            e.position,
                            false,
                            e.modifiers,
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
                let mouse = s.term.mode().contains(TermMode::MOUSE_MOTION)
                    || e.pressed_button.is_some() && s.term.mode().contains(TermMode::MOUSE_DRAG);
                if mouse
                    && s.mouse_report(
                        32 + match e.pressed_button {
                            Some(MouseButton::Left) => 0,
                            Some(MouseButton::Middle) => 1,
                            Some(MouseButton::Right) => 2,
                            _ => 3,
                        },
                        e.position,
                        false,
                        e.modifiers,
                        cx,
                    )
                {
                    return;
                }
                if s.dragging {
                    let p = s.point(e.position);
                    if let Some(sel) = &mut s.term.selection {
                        sel.update(p, Side::Right);
                    }
                    cx.notify()
                }
            }));
        for button in [MouseButton::Left, MouseButton::Middle, MouseButton::Right] {
            area = area
                .on_mouse_down(button, cx.listener(|s, e, w, cx| s.down(e, w, cx)))
                .on_mouse_up(button, cx.listener(|s, e, _, cx| s.up(e, cx)));
        }
        area.on_mouse_up_out(
            MouseButton::Left,
            cx.listener(|s, _, _, _| s.dragging = false),
        )
        .child(
            canvas(
                move |b, _, cx| measure.update(cx, |s, cx| s.layout(b, cx)),
                move |b, (), w, cx| {
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

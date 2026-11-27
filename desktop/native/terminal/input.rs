use super::{Pane, PaneMenu, PaneNotice, PasteError, scrollbar::ScrollbarDrag};
use crate::{colors, keys};
use alacritty_terminal::{
    grid::{Dimensions, Scroll},
    index::{Column, Line, Point as CellPoint, Side},
    selection::{Selection, SelectionType},
    term::TermMode,
};
use base64::{Engine, engine::general_purpose::STANDARD};
use gpui::{prelude::*, *};
use serde_json::json;
use std::ops::Range;

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

impl Pane {
    pub fn paste_clipboard(&mut self, cx: &mut Context<Self>) {
        self.paste_clipboard_key(false, cx);
    }

    fn paste_clipboard_key(&mut self, is_held: bool, cx: &mut Context<Self>) {
        let Some(item) = cx.read_from_clipboard() else {
            return;
        };
        if !self.can_paste_image() {
            if let Some(text) = item.text() {
                self.paste(text, cx);
            }
            return;
        }
        self.paste_image_or_text(&item, false, is_held, cx);
    }

    pub fn paste_image_path(&mut self, cx: &mut Context<Self>) {
        if !self.can_paste_image() {
            return;
        }
        if let Some(item) = cx.read_from_clipboard() {
            self.paste_image_or_text(&item, true, false, cx);
        }
    }

    fn paste_image_or_text(
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
                if self.server.is_some() {
                    cx.emit(PaneNotice::sticky("Uploading image…"));
                    self.command(
                        "image",
                        json!({
                            "mime": mime,
                            "data": STANDARD.encode(bytes),
                            "mode": if as_path { "path" } else { "attachment" },
                        }),
                    );
                } else {
                    self.start_ssh_image_paste(mime, bytes.into_owned(), as_path, cx);
                }
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

    fn observe_interaction(&mut self, w: &Window, cx: &mut Context<Self>) {
        if w.is_window_active() && self.focus.is_focused(w) {
            self.clear_bell(cx);
            if self.activity == "finished" {
                if self.server.is_some() {
                    self.command("observe", json!({}));
                } else {
                    self.activity = "idle".into();
                    cx.emit(super::PaneChanged);
                }
            }
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
        if !self.term.mode().contains(TermMode::ALT_SCREEN)
            && (m == Modifiers::shift() || (cfg!(target_os = "macos") && m == Modifiers::command()))
        {
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
            if self.can_paste_image() && key == "v" && m == Modifiers::control() {
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
            if self.can_paste_image() {
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

    pub(super) fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        self.observe_interaction(w, cx);
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

    #[allow(clippy::too_many_arguments)]
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
        self.observe_interaction(w, cx);
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
        if e.button == MouseButton::Left
            && self.scrollbar_hit_contains(e.position)
            && let Some(geom) = self.scrollbar_geometry()
        {
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
        self.observe_interaction(w, cx);
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

#[cfg(test)]
mod tests {
    use super::{accumulate_scroll_steps, encode_mouse_sequence};
    use alacritty_terminal::term::TermMode;
    use gpui::{ScrollDelta, point, px};

    #[test]
    fn pixel_scroll_accumulates_sub_row_deltas_and_resets_on_direction_flip() {
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
            accumulate_scroll_steps(
                &mut rem,
                ScrollDelta::Pixels(point(px(0.), px(-20.))),
                cell_h
            ),
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
            encode_mouse_sequence(
                TermMode::MOUSE_MODE | TermMode::SGR_MOUSE,
                64,
                12,
                5,
                false,
                0
            ),
            Some(b"\x1b[<64;12;5M".to_vec())
        );
        assert_eq!(
            encode_mouse_sequence(TermMode::MOUSE_MODE, 64, 224, 5, false, 0),
            None
        );
    }
}

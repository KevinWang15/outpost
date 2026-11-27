use super::*;
use crate::prefs::{DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE};

impl Workspace {
    pub(super) fn cycle_tab(&mut self, delta: isize, w: &mut Window, cx: &mut Context<Self>) {
        let n = self.tabs.len();
        if n == 0 {
            return;
        }
        let next = (self.current as isize + delta).rem_euclid(n as isize) as usize;
        self.select(self.tabs[next].active, w, cx);
    }

    pub(super) fn select_tab_index(
        &mut self,
        one_based: usize,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let target = if one_based == 9 {
            self.tabs.last()
        } else {
            one_based.checked_sub(1).and_then(|i| self.tabs.get(i))
        };
        if let Some(t) = target {
            self.select(t.active, w, cx);
        }
    }

    pub(super) fn move_tab_by_id(&mut self, tab_id: Id, delta: isize, cx: &mut Context<Self>) {
        if self.tabs.len() <= 1 {
            return;
        }
        let Some(index) = self.tabs.iter().position(|t| t.id == tab_id) else {
            return;
        };
        if let Some(next) = index
            .checked_add_signed(delta)
            .filter(|i| *i < self.tabs.len())
        {
            self.tabs.swap(index, next);
            if self.current == index {
                self.current = next;
                self.strip_scroll_anim = None;
                self.drag.strip.scroll_to_item(next);
            } else if self.current == next {
                self.current = index;
            }
            cx.notify();
        }
    }

    pub(super) fn move_tab(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(id) = self.tabs.get(self.current).map(|t| t.id) {
            self.move_tab_by_id(id, delta, cx);
        }
    }

    pub(super) fn focus_pane_delta(
        &mut self,
        delta: isize,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(t) = self.tabs.get(self.current) else {
            return;
        };
        let mut ids = Vec::new();
        t.layout.pane_order(&mut ids);
        if ids.len() <= 1 {
            return;
        }
        let pos = ids.iter().position(|id| *id == t.active).unwrap_or(0) as isize;
        let next = (pos + delta).rem_euclid(ids.len() as isize) as usize;
        self.select(ids[next], w, cx);
    }

    pub(super) fn adjust_font_size(&mut self, delta: Option<f32>, cx: &mut Context<Self>) {
        let next = match delta {
            Some(d) => ((self.prefs.font_size + d) * 2.0).round() / 2.0,
            None => DEFAULT_FONT_SIZE,
        }
        .clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        self.prefs.font_size = next;
        self.settings(cx);
        self.show_toast(None, format!("Text size: {next:.1} px"), false, cx);
    }

    pub(super) fn open_sessions(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.split_at = None;
        if items(&self.accounts["accounts"]).is_empty() {
            self.show(Page::Home, w, cx);
        } else {
            self.catalogue(w, cx);
        }
    }

    pub(super) fn close_focused_pane(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.page, Page::Terminal | Page::Compose)
            && let Some(t) = self.tabs.get(self.current)
        {
            self.close(t.active, w, cx);
        }
    }

    pub(super) fn close_current_tab(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.page, Page::Terminal | Page::Compose)
            && let Some(t) = self.tabs.get(self.current)
        {
            self.close_tab(t.active, w, cx);
        }
    }

    pub(super) fn close_current_window(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.request_window_close(w, cx) {
            w.remove_window();
        }
    }

    pub(super) fn shortcuts(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.overlay, Some(OverlayMenu::Tab(..))) {
            if e.keystroke.key == "escape" && !e.keystroke.modifiers.modified() {
                self.overlay = None;
                self.restore_focus(w, cx);
                cx.notify();
                w.prevent_default();
                cx.stop_propagation();
            }
            return;
        }
        if matches!(
            self.overlay,
            Some(
                OverlayMenu::NewTab
                    | OverlayMenu::BarOverflow
                    | OverlayMenu::Pane(_)
                    | OverlayMenu::Context(..)
            )
        ) || self.file_key(e, w, cx)
        {
            return;
        }
        if matches!(self.overlay, Some(OverlayMenu::TabRename(_))) {
            let m = e.keystroke.modifiers;
            if !m.control && !m.alt && !m.platform && !m.shift {
                match e.keystroke.key.as_str() {
                    "escape" => {
                        self.close_tab_rename(w, cx);
                        w.prevent_default();
                        cx.stop_propagation();
                    }
                    "enter" => {
                        self.commit_tab_rename(w, cx);
                        w.prevent_default();
                        cx.stop_propagation();
                    }
                    _ => {}
                }
            }
            return;
        }
        if e.keystroke.key == "escape" && self.drag.gesture.is_some() {
            self.cancel_drag(cx);
            w.prevent_default();
            cx.stop_propagation();
            return;
        }
        let k = &e.keystroke;
        let m = k.modifiers;
        let key = k.key.as_str();
        if self.page == Page::Create && self.create.any_open(cx) {
            if key == "escape" {
                self.create.close_all(cx);
                w.prevent_default();
                cx.stop_propagation();
            }
            return;
        }
        let mac = cfg!(target_os = "macos");
        let no_mod = !m.control && !m.alt && !m.platform && !m.shift;
        let shift_only = m.shift && !m.control && !m.alt && !m.platform;
        let ctrl = m.control && !m.shift && !m.alt && !m.platform;
        let ctrl_shift = m.control && m.shift && !m.alt && !m.platform;
        let ctrl_alt = m.control && m.alt && !m.shift && !m.platform;
        let alt = m.alt && !m.control && !m.shift && !m.platform;
        let cmd = m.platform && !m.control && !m.alt && !m.shift;
        let cmd_shift = m.platform && m.shift && !m.control && !m.alt;
        let cmd_alt = m.platform && m.alt && !m.control && !m.shift;
        let primary = if mac { cmd } else { ctrl_shift };
        let accel = if mac { cmd } else { ctrl };
        let accel_any_shift = if mac {
            m.platform && !m.control && !m.alt
        } else {
            m.control && !m.alt && !m.platform
        };
        let pane_alt = if mac { cmd_alt } else { ctrl_alt };
        let split_down_mod = if mac { cmd_shift } else { ctrl_alt };
        let on_terminal = matches!(self.page, Page::Terminal | Page::Compose);
        let find_active = self.find.open && self.page == Page::Terminal;
        let find_focused = find_active && self.find_is_focused(w, cx);
        let find_opt_mod = if mac { cmd_alt } else { alt };

        if matches!(self.page, Page::Choose | Page::Switch)
            && no_mod
            && matches!(key, "down" | "up")
        {
            self.step_picker(if key == "down" { 1 } else { -1 }, cx);
        } else if find_active
            && ((find_focused && shift_only && key == "enter")
                || (shift_only && key == "f3")
                || ((if mac { cmd_shift } else { ctrl_shift }) && key == "g"))
        {
            self.step_find(false, cx);
        } else if find_active && ((no_mod && key == "f3") || (accel && key == "g")) {
            self.step_find(true, cx);
        } else if !find_active
            && mac
            && self.page == Page::Terminal
            && (cmd || cmd_shift)
            && key == "g"
            && !self.find.query.read(cx).committed_value().is_empty()
        {
            self.step_find(!m.shift, cx);
        } else if find_active && find_opt_mod && key == "c" {
            self.toggle_find_case(w, cx);
        } else if find_active && find_opt_mod && key == "w" {
            self.toggle_find_whole_word(w, cx);
        } else if find_active && find_opt_mod && key == "r" {
            self.toggle_find_regex(w, cx);
        } else if find_focused && (no_mod || shift_only) && key == "tab" {
            self.extend_find_selection(!m.shift, cx);
        } else if find_active
            && no_mod
            && key == "escape"
            && (find_focused
                || !self
                    .active()
                    .is_some_and(|p| p.read(cx).focus.is_focused(w)))
        {
            self.close_find(w, cx);
        } else if key == "escape"
            && no_mod
            && ((self.page != Page::Terminal && !self.tabs.is_empty())
                || !matches!(self.page, Page::Terminal | Page::Home))
        {
            self.dismiss_page(w, cx)
        } else if key == "enter"
            && (no_mod || shift_only)
            && !matches!(self.page, Page::Terminal | Page::Settings)
            && (self.page != Page::Compose || !m.shift)
            && !(self.page == Page::Create && self.create.any_focused(w, cx))
        {
            self.submit(w, cx)
        } else if (mac && m.control && m.platform && !m.alt && !m.shift && key == "f")
            || (!mac && no_mod && key == "f11")
        {
            if !e.is_held {
                w.toggle_fullscreen();
            }
        } else if (ctrl || ctrl_shift) && key == "tab" && !self.tabs.is_empty() {
            self.cycle_tab(if m.shift { -1 } else { 1 }, w, cx);
        } else if ctrl && matches!(key, "pagedown" | "pageup") && !self.tabs.is_empty() {
            self.cycle_tab(if key == "pagedown" { 1 } else { -1 }, w, cx);
        } else if mac
            && ((cmd_shift && matches!(key, "]" | "[")) || (cmd && matches!(key, "}" | "{")))
            && !self.tabs.is_empty()
        {
            self.cycle_tab(if matches!(key, "]" | "}") { 1 } else { -1 }, w, cx);
        } else if ctrl_shift && matches!(key, "pageup" | "pagedown") && !self.tabs.is_empty() {
            self.move_tab(if key == "pageup" { -1 } else { 1 }, cx);
        } else if (if mac { cmd } else { alt })
            && matches!(key, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            && !self.tabs.is_empty()
        {
            self.select_tab_index(key.parse::<usize>().unwrap(), w, cx);
        } else if accel_any_shift && matches!(key, "=" | "+") {
            self.adjust_font_size(Some(1.0), cx);
        } else if accel && key == "-" {
            self.adjust_font_size(Some(-1.0), cx);
        } else if accel && key == "0" {
            self.adjust_font_size(None, cx);
        } else if (accel && key == ",")
            || (!mac && ((ctrl_shift && key == ",") || (ctrl && key == "<")))
        {
            if !e.is_held {
                self.show(Page::Settings, w, cx);
            }
        } else if pane_alt
            && matches!(key, "right" | "down" | "left" | "up")
            && self.page == Page::Terminal
            && !self.tabs.is_empty()
        {
            self.focus_pane_delta(
                if matches!(key, "right" | "down") { 1 } else { -1 },
                w,
                cx,
            );
        } else if split_down_mod
            && key == "d"
            && self.page == Page::Terminal
            && !self.tabs.is_empty()
        {
            if !e.is_held {
                self.split(Axis::Down, w, cx);
            }
        } else if split_down_mod
            && key == "enter"
            && self.page == Page::Terminal
            && self.active().is_some()
        {
            if !e.is_held {
                self.toggle_zoom(self.tabs[self.current].active, w, cx);
            }
        } else if pane_alt && key == "w" && on_terminal && !self.tabs.is_empty() {
            if !e.is_held {
                self.close_current_tab(w, cx);
            }
        } else if (mac && cmd_shift && key == "w") || (!mac && alt && key == "f4") {
            if !e.is_held {
                self.close_current_window(w, cx);
            }
        } else if ((mac && (cmd || cmd_shift)) || (!mac && ctrl_shift)) && key == "n" {
            if !e.is_held
                && let Err(err) = crate::open_workspace(true, cx)
            {
                self.message = err.to_string();
                cx.notify();
            }
        } else if (if mac { cmd_shift } else { ctrl_shift }) && key == "o" {
            if !e.is_held {
                self.open_sessions(w, cx);
            }
        } else if primary {
            match key {
                "t" => {
                    if !e.is_held {
                        self.split_at = None;
                        self.local(None, w, cx);
                    }
                }
                "d" if self.page == Page::Terminal && !self.tabs.is_empty() => {
                    if !e.is_held {
                        self.split(Axis::Across, w, cx);
                    }
                }
                "w" if on_terminal && !self.tabs.is_empty() => {
                    if !e.is_held {
                        self.close_focused_pane(w, cx);
                    }
                }
                "r" if on_terminal && !self.tabs.is_empty() => {
                    if !e.is_held {
                        self.reload_selected(w, cx);
                    }
                }
                "k" if self.page == Page::Terminal && self.active().is_some() => {
                    if !e.is_held
                        && let Some(p) = self.active()
                    {
                        p.update(cx, |p, cx| p.clear_screen(true, cx));
                    }
                }
                "p" => {
                    if !e.is_held {
                        self.show(Page::Switch, w, cx);
                    }
                }
                "f" if self.active().is_some() => {
                    if !e.is_held {
                        self.open_find(w, cx);
                    }
                }
                "e" if self.page == Page::Terminal && self.active().is_some() => {
                    if !e.is_held {
                        self.use_selection_for_find(w, cx);
                    }
                }
                "enter" if self.active().is_some() => {
                    if !e.is_held {
                        self.show(Page::Compose, w, cx);
                    }
                }
                _ => return,
            }
        } else {
            return;
        }
        w.prevent_default();
        cx.stop_propagation()
    }
}

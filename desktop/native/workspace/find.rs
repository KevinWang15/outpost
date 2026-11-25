use super::{Page, Workspace, row};
use crate::{
    layout::Id,
    terminal::{Pane, SearchStatus},
};
use gpui::{
    components::*,
    icons::{LucideIcon, lucide_icon},
    prelude::*,
    *,
};

fn format_match_count(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().rev().enumerate() {
        if i > 0 && i % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out.chars().rev().collect()
}

pub(super) fn format_find_counter(query: &str, status: &SearchStatus) -> Option<(String, bool)> {
    if query.is_empty() {
        return None;
    }
    if status.invalid_regex {
        return Some(("Invalid regex".to_owned(), true));
    }
    if status.total == 0 {
        return Some(("No results".to_owned(), true));
    }
    let current = status.active.map(|i| i + 1).unwrap_or(0);
    let suffix = if status.truncated { "+" } else { "" };
    Some((
        format!("{current}/{}{suffix}", format_match_count(status.total)),
        false,
    ))
}

fn single_line_selection(pane: &Pane) -> Option<String> {
    let raw = pane.selected_string()?;
    let trimmed = raw.trim_end_matches(['\r', '\n']);
    if trimmed.is_empty() || trimmed.contains(['\r', '\n']) || trimmed.chars().count() > 200 {
        return None;
    }
    Some(trimmed.to_owned())
}

impl Workspace {
    pub(super) fn find_is_focused(&self, w: &Window, cx: &App) -> bool {
        self.find_focus.contains_focused(w, cx)
            || self.find_query.read(cx).focus_handle(cx).is_focused(w)
    }

    pub(super) fn open_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(active_id) = self.tabs.get(self.current).map(|t| t.active) else {
            return;
        };
        let Some(pane) = self.panes.get(&active_id).cloned() else {
            return;
        };

        if self.page != Page::Terminal {
            self.page = Page::Terminal;
        }
        self.new_tab_menu_open = false;
        self.bar_menu_open = false;
        self.pane_menu = None;
        self.context_menu = None;
        self.tab_menu = None;
        self.tab_rename = None;
        self.files_menu = None;

        // Like iTerm2 & VS Code, seed Find from a short single-line terminal selection when present;
        // otherwise keep the previous query ready to refine or step through.
        if let Some(selected) = single_line_selection(pane.read(cx)) {
            self.find_query
                .update(cx, |input, cx| input.set_value_silent(selected, cx));
        }
        self.find_open = true;
        self.sync_find(true, cx);
        self.find_query.read(cx).focus_handle(cx).focus(w, cx);
        cx.notify();
    }

    pub(super) fn use_selection_for_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.active() else {
            return;
        };
        let Some(selected) = single_line_selection(pane.read(cx)) else {
            return;
        };
        self.find_query
            .update(cx, |input, cx| input.set_value_silent(selected, cx));
        if self.page != Page::Terminal {
            self.page = Page::Terminal;
        }
        self.find_open = true;
        self.sync_find(true, cx);
        if self.find_is_focused(w, cx) {
            self.find_query.read(cx).focus_handle(cx).focus(w, cx);
        }
        cx.notify();
    }

    pub(super) fn close_find(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let was_open = self.find_open;
        self.find_open = false;
        self.clear_find_highlights(cx);
        self.find_query
            .update(cx, |input, cx| input.set_invalid(false, cx));
        if was_open && self.page == Page::Terminal {
            if let Some(p) = self.active() {
                p.update(cx, |p, cx| p.focus_terminal(w, cx));
            }
        }
        cx.notify();
    }

    pub(super) fn clear_find_highlights(&mut self, cx: &mut Context<Self>) {
        if let Some(prev_id) = self.find_pane.take()
            && let Some(prev_pane) = self.panes.get(&prev_id).cloned()
        {
            prev_pane.update(cx, |p, cx| p.clear_search(cx));
        }
        if let Some(active) = self.active() {
            active.update(cx, |p, cx| p.clear_search(cx));
        }
    }

    pub(super) fn sync_find(&mut self, reset_anchor: bool, cx: &mut Context<Self>) {
        if !self.find_open {
            return;
        }
        let target_id = self.tabs.get(self.current).map(|t| t.active);
        let switched = self.find_pane != target_id;
        if switched
            && let Some(prev_id) = self.find_pane.take()
            && let Some(prev_pane) = self.panes.get(&prev_id).cloned()
        {
            prev_pane.update(cx, |p, cx| p.clear_search(cx));
        }
        let Some(target_id) = target_id else {
            self.find_open = false;
            self.find_query
                .update(cx, |input, cx| input.set_invalid(false, cx));
            return;
        };
        self.find_pane = Some(target_id);
        let Some(pane) = self.panes.get(&target_id).cloned() else {
            return;
        };
        let query = self.find_query.read(cx).committed_value();
        let options = self.find_options;
        let status = pane.update(cx, |p, cx| {
            p.set_search(&query, options, reset_anchor || switched, cx)
        });
        self.find_query
            .update(cx, |input, cx| input.set_invalid(status.invalid_regex, cx));
        cx.notify();
    }

    pub(super) fn step_find(&mut self, next: bool, cx: &mut Context<Self>) {
        let query = self.find_query.read(cx).committed_value();
        if query.is_empty() {
            return;
        }
        let Some(target_id) = self.tabs.get(self.current).map(|t| t.active) else {
            return;
        };
        if !self.find_open || self.find_pane != Some(target_id) {
            self.find_open = true;
            self.sync_find(true, cx);
            return;
        }
        if let Some(pane) = self.panes.get(&target_id).cloned() {
            pane.update(cx, |p, cx| {
                p.step_search(next, cx);
            });
            cx.notify();
        }
    }

    pub(super) fn toggle_find_case(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.find_options.case_sensitive = !self.find_options.case_sensitive;
        self.sync_find(false, cx);
        self.find_query.read(cx).focus_handle(cx).focus(w, cx);
    }

    pub(super) fn toggle_find_whole_word(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.find_options.whole_word = !self.find_options.whole_word;
        self.sync_find(false, cx);
        self.find_query.read(cx).focus_handle(cx).focus(w, cx);
    }

    pub(super) fn toggle_find_regex(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.find_options.regex = !self.find_options.regex;
        self.sync_find(false, cx);
        self.find_query.read(cx).focus_handle(cx).focus(w, cx);
    }

    pub(super) fn extend_find_selection(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(target_id) = self.tabs.get(self.current).map(|t| t.active) else {
            return;
        };
        let Some(pane) = self.panes.get(&target_id).cloned() else {
            return;
        };
        let copied = pane.update(cx, |p, cx| p.extend_search_selection(forward, cx));
        if copied.is_some() {
            self.show_toast(Some(target_id), "Copied match to clipboard".into(), false, cx);
        }
    }

    pub(super) fn find_overlay(
        &self,
        pane_id: Id,
        pane: &Pane,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        if !self.find_open || self.page != Page::Terminal {
            return None;
        }
        let mac = cfg!(target_os = "macos");
        let query = self.find_query.read(cx).committed_value();
        let status = pane.search_status();
        let counter = format_find_counter(&query, &status);
        let has_matches = status.total > 0;

        let toggle_btn = |id: &'static str,
                          glyph: LucideIcon,
                          tip: &'static str,
                          pressed: bool,
                          on_click: fn(&mut Self, &mut Window, &mut Context<Self>)| {
            div()
                .id(id)
                .role(gpui::accesskit::Role::Button)
                .aria_label(tip)
                .size(px(24.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .border_1()
                .cursor_pointer()
                .tooltip(move |w, cx| Tooltip::text(tip, w, cx))
                .when(pressed, |e| {
                    e.bg(rgba(0x3b82f636))
                        .border_color(rgba(0x60a5fa66))
                        .text_color(rgb(0x93c5fd))
                })
                .when(!pressed, |e| {
                    e.border_color(rgba(0x00000000))
                        .text_color(rgba(0xffffff80))
                        .hover(|s| s.bg(rgba(0xffffff16)).text_color(rgb(0xf0f0f0)))
                })
                .on_mouse_down(MouseButton::Left, |_, w, cx| {
                    w.prevent_default();
                    cx.stop_propagation();
                })
                .on_click(cx.listener(move |s, _, w, cx| on_click(s, w, cx)))
                .child(lucide_icon(glyph).size(px(14.)))
        };

        let nav_btn = |id: &'static str,
                       glyph: LucideIcon,
                       tip: &'static str,
                       enabled: bool,
                       next: bool| {
            div()
                .id(id)
                .role(gpui::accesskit::Role::Button)
                .aria_label(tip)
                .size(px(24.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .text_color(if enabled {
                    rgba(0xffffffa6)
                } else {
                    rgba(0xffffff38)
                })
                .when(enabled, |e| {
                    e.cursor_pointer()
                        .hover(|s| s.bg(rgba(0xffffff16)).text_color(rgb(0xf0f0f0)))
                        .tooltip(move |w, cx| Tooltip::text(tip, w, cx))
                        .on_mouse_down(MouseButton::Left, |_, w, cx| {
                            w.prevent_default();
                            cx.stop_propagation();
                        })
                        .on_click(cx.listener(move |s, _, _, cx| s.step_find(next, cx)))
                })
                .child(lucide_icon(glyph).size(px(14.5)))
        };

        let case_tip = if mac {
            "Match case (⌥⌘C)"
        } else {
            "Match case (Alt+C)"
        };
        let word_tip = if mac {
            "Match whole word (⌥⌘W)"
        } else {
            "Match whole word (Alt+W)"
        };
        let regex_tip = if mac {
            "Use regular expression (⌥⌘R)"
        } else {
            "Use regular expression (Alt+R)"
        };
        let prev_tip = if mac {
            "Previous match (⇧↵ / ⇧⌘G)"
        } else {
            "Previous match (Shift+Enter / Shift+F3)"
        };
        let next_tip = if mac {
            "Next match (↵ / ⌘G)"
        } else {
            "Next match (Enter / F3)"
        };

        Some(
            row()
                .id(("terminal-find", pane_id))
                .track_focus(&self.find_focus)
                .absolute()
                .top(px(8.))
                .right(px(16.))
                .max_w(relative(0.94))
                .occlude()
                .px(px(6.))
                .py(px(5.))
                .gap(px(3.))
                .rounded(px(9.))
                .backdrop_blur(px(14.))
                .bg(rgba(0x161618ee))
                .border_1()
                .border_color(if status.invalid_regex {
                    rgba(0xf8717188)
                } else {
                    rgba(0xffffff24)
                })
                .shadow_lg()
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
                .on_scroll(|_, _, cx| cx.stop_propagation())
                .child(
                    div().w(px(210.)).min_w(px(120.)).flex_shrink_1().child(
                        input(&self.find_query)
                            .w_full()
                            .h(px(28.))
                            .text_size(px(12.5))
                            .bg(rgba(0x09090be0))
                            .border_color(if status.invalid_regex {
                                rgba(0xf87171aa)
                            } else {
                                rgba(0xffffff1a)
                            })
                            .rounded(px(6.)),
                    ),
                )
                .when_some(counter, |e, (label, is_err)| {
                    e.child(
                        div()
                            .flex_none()
                            .px(px(4.))
                            .text_size(px(11.5))
                            .font_family(crate::terminal::FAMILY)
                            .text_color(if is_err { rgb(0xf87171) } else { rgb(0x9a9a9a) })
                            .child(label),
                    )
                })
                .child(toggle_btn(
                    "find-case",
                    LucideIcon::CaseSensitive,
                    case_tip,
                    self.find_options.case_sensitive,
                    Self::toggle_find_case,
                ))
                .child(toggle_btn(
                    "find-word",
                    LucideIcon::WholeWord,
                    word_tip,
                    self.find_options.whole_word,
                    Self::toggle_find_whole_word,
                ))
                .child(toggle_btn(
                    "find-regex",
                    LucideIcon::Regex,
                    regex_tip,
                    self.find_options.regex,
                    Self::toggle_find_regex,
                ))
                .child(div().flex_none().w(px(1.)).h(px(16.)).mx(px(2.)).bg(rgba(0xffffff1a)))
                .child(nav_btn(
                    "find-prev",
                    LucideIcon::ChevronUp,
                    prev_tip,
                    has_matches,
                    false,
                ))
                .child(nav_btn(
                    "find-next",
                    LucideIcon::ChevronDown,
                    next_tip,
                    has_matches,
                    true,
                ))
                .child(
                    div()
                        .id("find-close")
                        .role(gpui::accesskit::Role::Button)
                        .aria_label("Close search")
                        .size(px(24.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(5.))
                        .text_color(rgba(0xffffff80))
                        .cursor_pointer()
                        .hover(|s| s.bg(rgba(0xffffff16)).text_color(rgb(0xf0f0f0)))
                        .tooltip(|w, cx| Tooltip::text("Close (Esc)", w, cx))
                        .on_mouse_down(MouseButton::Left, |_, w, cx| {
                            w.prevent_default();
                            cx.stop_propagation();
                        })
                        .on_click(cx.listener(|s, _, w, cx| s.close_find(w, cx)))
                        .child(lucide_icon(LucideIcon::X).size(px(14.))),
                )
                .into_any_element(),
        )
    }
}

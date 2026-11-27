use super::Workspace;
use crate::agent_mark::AgentMark;
use gpui::{
    components::*,
    icons::{LucideIcon, lucide_icon},
    prelude::*,
    *,
};
use serde_json::Value;
use std::path::PathBuf;

pub(super) const BG: u32 = 0x0c0c0c;
pub(super) const TEXT: u32 = 0xe6e6e6;
pub(super) const MUTED: u32 = 0xa3a3a3;

pub(super) fn strval(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

pub(super) fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

pub(super) fn format_thousands(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

pub(super) fn col() -> Div {
    div().flex().flex_col().min_w_0().min_h_0()
}

pub(super) fn row() -> Div {
    div().flex().flex_row().items_center().min_w_0().gap(px(8.))
}

pub(super) fn text(s: impl Into<SharedString>, size: f32, color: u32) -> Div {
    div()
        .text_size(px(size))
        .text_color(rgb(color))
        .child(s.into())
}

pub(super) fn section(s: &str) -> Div {
    text(s.to_uppercase(), 12., MUTED)
        .font_weight(FontWeight::SEMIBOLD)
        .mt(px(20.))
}

pub(super) fn card() -> Div {
    col()
        .w_full()
        .rounded(px(10.))
        .bg(rgb(0x131313))
        .border_1()
        .border_color(rgb(0x252525))
}

pub(super) fn card_divider() -> Div {
    div().w_full().h(px(1.)).bg(rgb(0x202020))
}

pub(super) fn field(state: &Entity<InputState>) -> Input {
    input(state)
        .w_full()
        .h(px(38.))
        .text_size(px(13.))
        .bg(rgb(0x0a0a0a))
        .border_color(rgb(0x2e2e2e))
        .rounded(px(8.))
}

pub(super) fn control(
    label: impl Into<SharedString>,
    primary: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    button(label.clone(), primary, cx, action).child(label)
}

pub(super) fn control_with_icon(
    label: impl Into<SharedString>,
    symbol: LucideIcon,
    trailing: bool,
    primary: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    let glyph = lucide_icon(symbol).size(px(13.5));
    let inner = if trailing {
        row().gap(px(6.)).child(label.clone()).child(glyph)
    } else {
        row().gap(px(6.)).child(glyph).child(label.clone())
    };
    button(label, primary, cx, action).child(inner)
}

pub(super) fn button(
    id: impl Into<ElementId>,
    primary: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::accesskit::Role::Button)
        .focusable()
        .tab_stop(true)
        .focus_visible(|s| s.border_color(rgb(0x888888)))
        .flex_none()
        .py(px(7.))
        .px(px(12.))
        .rounded(px(7.))
        .border_1()
        .border_color(rgb(if primary { TEXT } else { 0x2e2e2e }))
        .bg(rgb(if primary { TEXT } else { 0x161616 }))
        .text_color(rgb(if primary { BG } else { TEXT }))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer()
        .hover(move |e| {
            e.bg(rgb(if primary { 0xffffff } else { 0x242424 }))
                .border_color(rgb(if primary { 0xffffff } else { 0x454545 }))
        })
        .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)))
}

pub(super) fn agent_label(mark: Option<&'static AgentMark>, title: impl Into<SharedString>) -> Div {
    row()
        .children(mark.map(|m| m.icon(16.)))
        .child(div().min_w_0().truncate().child(title.into()))
}

pub(super) fn icon(
    id: impl Into<ElementId>,
    symbol: LucideIcon,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .size(px(30.))
        .flex_none()
        .flex()
        .justify_center()
        .items_center()
        .rounded(px(5.))
        .text_color(rgba(0xffffffa6))
        .cursor_pointer()
        .hover(|s| s.bg(rgba(0xffffff18)).text_color(rgb(0xf0f0f0)))
        .child(lucide_icon(symbol).size(px(17.)))
        .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)))
}

pub(super) fn home_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().to_owned())
        .unwrap_or_default()
}

pub(super) fn confirm(
    title: &str,
    detail: &str,
    w: &mut Window,
    cx: &mut Context<Workspace>,
    f: impl FnOnce(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) {
    let response = w.prompt(
        PromptLevel::Warning,
        title,
        Some(detail),
        &["Cancel", "Continue"],
        cx,
    );
    cx.spawn_in(w, async move |this, cx| {
        if response.await == Ok(1) {
            let _ = this.update_in(cx, f);
        }
    })
    .detach()
}

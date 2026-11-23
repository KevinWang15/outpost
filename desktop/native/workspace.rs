mod drag;
pub(crate) mod files;
mod panes;
mod picker;
mod settings;
use crate::{
    agent_mark::AgentMark,
    bridge::Bridge,
    layout::{Axis, Id, Layout, Tab, next_id},
    terminal::{Pane, PaneChanged},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use drag::{DragLabel, DragState};
use gpui::components::InputEvent;
use gpui::{
    components::*,
    icons::{LucideIcon, lucide_icon},
    prelude::*,
    *,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap},
    path::PathBuf,
    sync::Arc,
};

const BG: u32 = 0x0c0c0c;
const TEXT: u32 = 0xe6e6e6;
const MUTED: u32 = 0xa3a3a3;
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Terminal,
    Home,
    Switch,
    Choose,
    Settings,
    Manage,
    Create,
    Find,
    Compose,
}
struct ToastNotice {
    token: u64,
    pane: Option<Id>,
    message: String,
    sticky: bool,
}
pub struct Workspace {
    watches: HashMap<Id, ([Subscription; 5], SnapshotSource)>,
    drag: DragState,
    active_order: usize,
    handle: AnyWindowHandle,
    pub(super) id: u64,
    bridge: Option<Bridge>,
    panes: BTreeMap<Id, Entity<Pane>>,
    pub(super) remote: HashMap<u64, Id>,
    tabs: Vec<Tab>,
    current: usize,
    startup_local: bool,
    startup_cloak: bool,
    startup_hint: bool,
    new_tab_menu_open: bool,
    pane_menu: Option<Id>,
    context_menu: Option<(Id, Point<Pixels>)>,
    toast: Option<ToastNotice>,
    close_pending: bool,
    page: Page,
    focus: FocusHandle,
    logo: Arc<Image>,
    message: String,
    accounts: Value,
    prefs: Value,
    address: Entity<InputState>,
    query: Entity<InputState>,
    find_query: Entity<InputState>,
    history_input: Entity<InputState>,
    directory: Entity<InputState>,
    name: Entity<InputState>,
    compose: Entity<TextBoxState>,
    split_at: Option<(Id, Axis)>,
    bounds: HashMap<Id, Bounds<Pixels>>,
    resizing: Option<(Id, Axis)>,
    origin: String,
    account_id: String,
    target: String,
    tool: String,
    targets: Value,
    options: Value,
    creating: bool,
    picker_index: usize,
    picker_scroll: ScrollHandle,
    refreshing_catalogue: bool,
    files_menu: Option<Id>,
    preview_id: Option<String>,
    preview: Option<Arc<Image>>,
}
type Transfer = (Tab, BTreeMap<Id, Entity<Pane>>, HashMap<u64, Id>);
#[derive(Clone)]
struct DragItem {
    pane: Id,
    window: u64,
    whole: bool,
    label: DragLabel,
}
#[derive(Clone, Copy, PartialEq)]
enum Destination {
    Split(Id, Axis, bool),
    Before(Id),
    Tab,
}
#[derive(Clone, Copy)]
enum CloseScope {
    Window,
    Tab(Id),
    Pane(Id),
}
fn strval(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}
fn items(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn col() -> Div {
    div().flex().flex_col().min_w_0().min_h_0()
}
fn row() -> Div {
    div().flex().flex_row().items_center().min_w_0().gap(px(8.))
}
fn text(s: impl Into<SharedString>, size: f32, color: u32) -> Div {
    div()
        .text_size(px(size))
        .text_color(rgb(color))
        .child(s.into())
}
fn section(s: &str) -> Div {
    text(s.to_uppercase(), 12., MUTED)
        .font_weight(FontWeight::SEMIBOLD)
        .mt(px(20.))
}
fn field(state: &Entity<InputState>) -> Input {
    input(state)
        .w_full()
        .h(px(37.))
        .text_size(px(13.))
        .bg(rgb(0x0a0a0a))
        .border_color(rgb(0x2e2e2e))
        .rounded(px(8.))
}
fn control(
    label: impl Into<SharedString>,
    primary: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    button(label.clone(), primary, cx, action).child(label)
}
fn control_with_icon(
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
fn button(
    id: impl Into<ElementId>,
    primary: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
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
        .hover(move |e| e.bg(rgb(if primary { 0xffffff } else { 0x242424 })))
        .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)))
}
fn agent_label(mark: Option<&'static AgentMark>, title: impl Into<SharedString>) -> Div {
    row()
        .children(mark.map(|m| m.icon(16.)))
        .child(div().min_w_0().truncate().child(title.into()))
}
fn icon(
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
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0x222222)))
        .child(lucide_icon(symbol).size(px(17.)))
        .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)))
}
fn home_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|d| d.home_dir().to_owned())
        .unwrap_or_default()
}
fn confirm(
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
impl Workspace {
    pub fn new(local: bool, w: &mut Window, cx: &mut Context<Self>) -> Self {
        use crate::hub::Hub;
        let hub = cx.global::<Hub>();
        let message = hub.error.clone();
        let bridge = hub.bridge.clone();
        let prefs = hub.prefs.clone();
        let accounts = hub.accounts.clone();
        let ready = !prefs.is_null() || bridge.is_none();
        let startup_local = local && !ready;
        let startup_cloak = local || (bridge.is_some() && prefs.is_null());
        if local && ready {
            cx.defer_in(w, |s, w, cx| s.local(None, w, cx))
        }
        if startup_cloak {
            cx.spawn_in(w, async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let still_cloaked = this
                    .update(cx, |s, cx| {
                        if s.startup_cloak {
                            s.startup_hint = true;
                            cx.notify();
                        }
                        s.startup_cloak
                    })
                    .unwrap_or(false);
                if !still_cloaked {
                    return;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(2250))
                    .await;
                let _ = this.update_in(cx, |s, w, cx| {
                    if !s.startup_cloak {
                        return;
                    }
                    s.startup_cloak = false;
                    s.startup_hint = false;
                    if s.startup_local && s.panes.is_empty() {
                        s.startup_local = false;
                        s.local(None, w, cx);
                    } else {
                        cx.notify();
                    }
                });
            })
            .detach();
        }
        let entry = |placeholder: &'static str, cx: &mut Context<Self>| {
            cx.new(|cx| InputState::new(cx).placeholder(placeholder))
        };
        let query = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("Search sessions, machines, or servers…")
                .leading_icon(LucideIcon::Search)
        });
        cx.subscribe(&query, |s: &mut Self, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change(_)) {
                s.picker_index = 0;
            }
            cx.notify()
        })
        .detach();
        let find_query = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("Find in terminal…")
                .leading_icon(LucideIcon::Search)
        });
        cx.subscribe(&find_query, |_, _, _: &InputEvent, cx| cx.notify())
            .detach();
        let history_input = entry("Lines", cx);
        cx.subscribe(&history_input, |s: &mut Self, _, event: &InputEvent, cx| {
            if let InputEvent::Submit(_) = event {
                s.save_history_limit(cx);
            }
        })
        .detach();
        let compose = cx.new(|cx| TextBoxState::new(cx).placeholder("Write a message…"));
        cx.subscribe(&compose, |s: &mut Self, _, e: &TextBoxEvent, cx| {
            if let TextBoxEvent::Change(value) = e
                && s.page == Page::Compose
                && let Some(pane) = s.active()
            {
                pane.update(cx, |p, _| {
                    p.draft = value.to_string();
                    p.command("draft", json!({"active":!value.is_empty()}))
                })
            }
        })
        .detach();
        cx.on_release(|s: &mut Self, cx| s.end_preview(cx)).detach();
        cx.observe_window_activation(w, |s, w, cx| {
            if !w.is_window_active() {
                s.set_new_tab_menu(false, cx);
                if s.pane_menu.take().is_some() || s.context_menu.take().is_some() {
                    cx.notify();
                }
                s.cancel_drag(cx);
            }
            if w.is_window_active() {
                s.active_order = next_id();
                for pane in s.panes.values() {
                    pane.read(cx).command("resume", json!({}))
                }
            }
        })
        .detach();
        let weak = cx.weak_entity();
        w.on_window_should_close(cx, move |w, cx| {
            weak.update(cx, |s, cx| s.request_window_close(w, cx))
                .unwrap_or(true)
        });
        Self {
            watches: HashMap::new(),
            drag: DragState::default(),
            active_order: next_id(),
            handle: w.window_handle(),
            id: next_id() as u64,
            startup_local,
            startup_cloak,
            startup_hint: false,
            new_tab_menu_open: false,
            pane_menu: None,
            context_menu: None,
            toast: None,
            close_pending: false,
            bridge,
            panes: Default::default(),
            remote: Default::default(),
            tabs: vec![],
            current: 0,
            page: Page::Home,
            focus: cx.focus_handle(),
            logo: Arc::new(Image::from_bytes(
                ImageFormat::Png,
                include_bytes!("../../public/outpost-256.png").to_vec(),
            )),
            message,
            accounts,
            prefs: if prefs.is_null() {
                json!({"fontSize":13.5,"sound":true})
            } else {
                prefs
            },
            address: entry("https://outpost.example.com", cx),
            query,
            find_query,
            history_input,
            directory: entry("Absolute working directory", cx),
            name: entry("Session name", cx),
            compose,
            split_at: None,
            bounds: Default::default(),
            resizing: None,
            origin: String::new(),
            account_id: String::new(),
            target: String::new(),
            tool: String::new(),
            targets: Value::Null,
            options: Value::Null,
            creating: false,
            picker_index: 0,
            picker_scroll: ScrollHandle::new(),
            refreshing_catalogue: false,
            files_menu: None,
            preview_id: None,
            preview: None,
        }
    }
    fn call(&self, mut data: Value) {
        if let Some(b) = &self.bridge {
            data["window"] = self.id.into();
            b.call(data)
        }
    }
    fn id(&mut self) -> Id {
        next_id()
    }
    fn fontsize(&self) -> f32 {
        self.prefs["fontSize"]
            .as_f64()
            .unwrap_or(f64::from(settings::DEFAULT_FONT_SIZE)) as f32
    }
    fn bounded_history(&self) -> usize {
        self.prefs["scrollbackLines"]
            .as_u64()
            .map_or(crate::terminal::DEFAULT_HISTORY, |n| n as usize)
    }
    fn history(&self) -> usize {
        if self.prefs["unlimitedScrollback"] == true {
            crate::terminal::MAX_HISTORY
        } else {
            self.bounded_history()
        }
    }
    fn sync_history_input(&mut self, cx: &mut Context<Self>) {
        let lines = self.bounded_history().to_string();
        self.history_input
            .update(cx, |input, cx| input.set_value_silent(lines, cx));
    }
    fn save_history_limit(&mut self, cx: &mut Context<Self>) {
        let value = self.history_input.read(cx).value().trim().parse::<usize>();
        if let Ok(lines) = value
            && lines <= crate::terminal::MAX_HISTORY
        {
            self.message.clear();
            self.prefs["scrollbackLines"] = json!(lines);
            self.settings(cx);
        } else {
            self.message = format!(
                "Enter a whole number from 0 to {}.",
                crate::terminal::MAX_HISTORY
            );
            cx.notify();
        }
    }
    fn active(&self) -> Option<Entity<Pane>> {
        self.panes
            .get(&self.tabs.get(self.current)?.active)
            .cloned()
    }
    fn show(&mut self, page: Page, w: &mut Window, cx: &mut Context<Self>) {
        self.startup_cloak = false;
        self.startup_hint = false;
        self.page = if page == Page::Terminal && self.tabs.is_empty() {
            Page::Home
        } else {
            page
        };
        self.message.clear();
        self.new_tab_menu_open = false;
        self.pane_menu = None;
        self.context_menu = None;
        self.files_menu = None;
        self.preview_id = None;
        self.preview = None;
        match self.page {
            Page::Terminal => {
                if let Some(p) = self.active() {
                    p.update(cx, |p, cx| p.focus_terminal(w, cx))
                }
            }
            Page::Settings => {
                self.sync_history_input(cx);
                self.focus.focus(w, cx);
            }
            Page::Find => {
                self.find_query.update(cx, |s, cx| s.set_value_silent("", cx));
                self.find_query.read(cx).focus_handle(cx).focus(w, cx)
            }
            Page::Choose | Page::Switch => {
                self.picker_index = 0;
                self.query.update(cx, |s, cx| s.set_value_silent("", cx));
                self.query.read(cx).focus_handle(cx).focus(w, cx)
            }
            Page::Compose => {
                let draft = self
                    .active()
                    .map(|p| p.read(cx).draft.clone())
                    .unwrap_or_default();
                self.compose.update(cx, |s, cx| s.set_value(draft, cx));
                self.compose.read(cx).focus_handle(cx).focus(w, cx)
            }
            _ => self.focus.focus(w, cx),
        }
        cx.notify()
    }
    fn select(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(i) = self.tabs.iter().position(|t| t.layout.contains(id)) {
            self.current = i;
            self.tabs[i].active = id;
            self.show(Page::Terminal, w, cx)
        }
    }
    fn insert(&mut self, p: Entity<Pane>, w: &mut Window, cx: &mut Context<Self>) -> Id {
        let id = self.id();
        let split = self.id();
        if let Some((at, axis)) = self.split_at.take()
            && let Some(i) = self.tabs.iter().position(|t| t.layout.contains(at))
        {
            self.tabs[i].layout.split(at, split, axis, Layout::Pane(id));
            self.tabs[i].zoom = false;
        } else {
            self.tabs.push(Tab::single(id))
        }
        let sound = self.prefs["sound"].as_bool().unwrap_or(true);
        p.update(cx, |p, _| {
            p.sound = sound;
            p.set_scrollback(self.history());
        });
        self.watch(id, &p, w, cx);
        self.panes.insert(id, p);
        self.select(id, w, cx);
        id
    }
    fn show_toast(
        &mut self,
        pane: Option<Id>,
        message: String,
        sticky: bool,
        cx: &mut Context<Self>,
    ) {
        let token = next_id() as u64;
        self.toast = Some(ToastNotice {
            token,
            pane,
            message,
            sticky,
        });
        cx.notify();
        if sticky {
            return;
        }
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            let _ = this.update(cx, |s, cx| {
                if s.toast.as_ref().is_some_and(|t| t.token == token) {
                    s.toast = None;
                    cx.notify();
                }
            });
        })
        .detach();
    }
    fn clear_pane_sticky_toast(&mut self, pane: Id) {
        if self
            .toast
            .as_ref()
            .is_some_and(|t| t.sticky && t.pane == Some(pane))
        {
            self.toast = None;
        }
    }
    fn watch(&mut self, id: Id, p: &Entity<Pane>, w: &mut Window, cx: &mut Context<Self>) {
        p.update(cx, |p, cx| p.bind_focus(w, cx));
        let menu = cx.subscribe(p, move |s, _, e: &crate::terminal::PaneMenu, cx| {
            if s.panes.contains_key(&id) {
                s.open_context_menu(id, e.position, cx);
            }
        });
        let sub = cx.subscribe_in(p, w, move |s, p, _: &PaneChanged, w, cx| {
            if !s.panes.contains_key(&id) {
                return;
            }
            if p.read(cx).focus.is_focused(w)
                && let Some(t) = s.tabs.get_mut(s.current)
                && t.layout.contains(id)
            {
                t.active = id
            }
            cx.notify()
        });
        let paste_error = cx.subscribe(p, move |s, _, e: &crate::terminal::PasteError, cx| {
            s.clear_pane_sticky_toast(id);
            s.message = e.0.clone();
            cx.notify();
        });
        let notice = cx.subscribe(p, move |s, _, e: &crate::terminal::PaneNotice, cx| {
            if s.tabs.get(s.current).is_some_and(|t| t.active == id) {
                s.show_toast(Some(id), e.message.clone(), e.sticky, cx);
            }
        });
        let ready = cx.subscribe(p, move |s, p, e: &files::PreviewReady, cx| {
            if s.active().as_ref() == Some(&p) && s.preview_id.as_deref() == Some(&e.file) {
                s.preview = Some(e.image.clone());
                cx.notify();
            }
        });
        self.watches.insert(
            id,
            ([sub, menu, paste_error, notice, ready], SnapshotSource::new()),
        );
    }
    fn local_profile(&self, id: Option<&str>) -> Option<&Value> {
        let profiles = items(&self.prefs["profiles"]);
        let preferred = id.or_else(|| self.prefs["localShell"].as_str());
        profiles
            .iter()
            .find(|profile| profile["id"].as_str() == preferred)
            .or(profiles.first())
    }
    fn local(&mut self, profile: Option<String>, w: &mut Window, cx: &mut Context<Self>) {
        let profile = self.local_profile(profile.as_deref());
        let executable = profile.map(|s| strval(s, "executable")).unwrap_or_else(|| {
            std::env::var("SHELL").unwrap_or_else(|_| {
                if cfg!(windows) {
                    "cmd.exe".into()
                } else {
                    "/bin/sh".into()
                }
            })
        });
        let args = profile
            .map(|s| {
                items(&s["args"])
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    vec![]
                } else {
                    vec!["-l".into()]
                }
            });
        let pane = Pane::local(&executable, &args, &home_dir(), self.fontsize(), w, cx);
        self.insert(pane, w, cx);
    }
    fn split(&mut self, axis: Axis, w: &mut Window, cx: &mut Context<Self>) {
        self.split_at = self.tabs.get(self.current).map(|t| (t.active, axis));
        self.local(None, w, cx)
    }
    fn select_all(&self, cx: &mut Context<Self>) {
        if let Some(p) = self.active() {
            p.update(cx, |p, cx| p.select_all(cx))
        }
    }
    fn request_window_close(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.panes.is_empty() {
            return true;
        }
        self.request_close(CloseScope::Window, w, cx);
        false
    }
    fn close_tab(&mut self, pane: Id, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(tab) = self.tabs.iter().find(|t| t.layout.contains(pane)) {
            self.request_close(CloseScope::Tab(tab.id), w, cx);
        }
    }
    fn close(&mut self, pane: Id, w: &mut Window, cx: &mut Context<Self>) {
        self.request_close(CloseScope::Pane(pane), w, cx);
    }
    fn in_scope(&self, scope: CloseScope, id: Id) -> bool {
        match scope {
            CloseScope::Window => self.panes.contains_key(&id),
            CloseScope::Tab(tab) => self
                .tabs
                .iter()
                .any(|t| t.id == tab && t.layout.contains(id)),
            CloseScope::Pane(pane) => pane == id && self.panes.contains_key(&id),
        }
    }
    fn request_close(&mut self, scope: CloseScope, w: &mut Window, cx: &mut Context<Self>) {
        if self.close_pending {
            return;
        }
        let captured: Vec<_> = self
            .panes
            .keys()
            .copied()
            .filter(|id| self.in_scope(scope, *id))
            .collect();
        if captured.is_empty() {
            return;
        }
        let count = captured.len();
        let noun = if count == 1 { "pane" } else { "panes" };
        let (title, action) = match scope {
            CloseScope::Pane(id) => (
                format!("Close “{}”?", self.panes[&id].read(cx).title),
                "Close pane",
            ),
            CloseScope::Tab(_) => (
                format!("Close this tab and its {count} {noun}?"),
                "Close tab",
            ),
            CloseScope::Window => (
                format!("Close this window and its {count} {noun}?"),
                "Close window",
            ),
        };
        let panes = || captured.iter().map(|id| self.panes[id].read(cx));
        let mut detail = Vec::new();
        if panes().any(|p| p.server.is_none()) {
            detail.push("Local shells and their processes will end.");
        }
        if panes().any(|p| p.server.is_some()) {
            detail.push("Managed sessions will keep running on their machines.");
        }
        if panes().any(|p| !p.draft.is_empty()) {
            detail.push("Unsent message drafts will be discarded.");
        }
        let response = w.prompt(
            PromptLevel::Warning,
            &title,
            Some(&detail.join(" ")),
            &["Cancel", action],
            cx,
        );
        self.close_pending = true;
        cx.spawn_in(w, async move |this, cx| {
            let accepted = response.await == Ok(1);
            let _ = this.update_in(cx, |s, w, cx| {
                s.close_pending = false;
                if !accepted {
                    return;
                }
                for id in captured {
                    if s.in_scope(scope, id) {
                        s.remove_pane(id);
                    }
                }
                if s.panes.is_empty() {
                    w.remove_window();
                } else {
                    s.show(Page::Terminal, w, cx);
                }
            });
        })
        .detach();
    }
    fn receive(
        &mut self,
        (tab, panes, remote): Transfer,
        destination: Destination,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let active = tab.active;
        for (id, p) in panes {
            self.watch(id, &p, w, cx);
            self.panes.insert(id, p);
        }
        self.remote.extend(remote);
        match destination {
            Destination::Split(at, axis, before)
                if self.tabs.iter().any(|t| t.layout.contains(at)) =>
            {
                let serial = self.id();
                let t = self
                    .tabs
                    .iter_mut()
                    .find(|t| t.layout.contains(at))
                    .unwrap();
                t.zoom = false;
                t.layout.insert_at(at, serial, axis, tab.layout, before);
            }
            Destination::Before(at) => {
                let index = self
                    .tabs
                    .iter()
                    .position(|t| t.id == at)
                    .unwrap_or(self.tabs.len());
                self.tabs.insert(index, tab);
            }
            _ => self.tabs.push(tab),
        }
        self.select(active, w, cx)
    }
    fn take_item(&mut self, item: &DragItem) -> Option<Transfer> {
        let i = self
            .tabs
            .iter()
            .position(|t| t.layout.contains(item.pane))?;
        let tab = if item.whole {
            let tab = self.tabs.remove(i);
            if self.current > i {
                self.current -= 1
            }
            self.current = self.current.min(self.tabs.len().saturating_sub(1));
            tab
        } else {
            self.remove_leaf(item.pane);
            Tab::single(item.pane)
        };
        let ids = self
            .panes
            .keys()
            .copied()
            .filter(|id| tab.layout.contains(*id))
            .collect::<Vec<_>>();
        for id in &ids {
            self.watches.remove(id);
        }
        let panes = ids
            .iter()
            .filter_map(|id| self.panes.remove(id).map(|p| (*id, p)))
            .collect();
        let mut remote = HashMap::new();
        self.remote.retain(|key, id| {
            if ids.contains(id) {
                remote.insert(*key, *id);
                false
            } else {
                true
            }
        });
        Some((tab, panes, remote))
    }
    fn selected_item(&self, whole: bool, cx: &App) -> Option<DragItem> {
        let tab = self.tabs.get(self.current)?;
        let pane = self.panes.get(&tab.active)?.read(cx);
        Some(DragItem {
            pane: tab.active,
            window: self.id,
            whole,
            label: DragLabel::new(pane.title.clone(), pane.mark),
        })
    }
    fn detach(&mut self, whole: bool, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.selected_item(whole, cx) {
            self.detach_item(&item, None, w, cx)
        }
    }
    fn place_selected(
        &mut self,
        whole: bool,
        dest: Destination,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(item) = self.selected_item(whole, cx)
            && let Some(t) = self.take_item(&item)
        {
            self.receive(t, dest, w, cx)
        }
    }
    fn reload_selected(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.tabs.get(self.current) else {
            return;
        };
        let id = tab.active;
        if self.panes[&id].read(cx).server.is_some() {
            self.panes[&id].read(cx).command("reconnect", json!({}));
            self.show(Page::Terminal, w, cx);
            return;
        }
        confirm(
            "Restart this local terminal?",
            "Restarting ends the current shell and discards its draft.",
            w,
            cx,
            move |s, w, cx| {
                let Some(old) = s.panes.get(&id).cloned() else {
                    return;
                };
                match old.update(cx, |p, cx| p.restarted_local(w, cx)) {
                    Ok(pane) => {
                        s.watch(id, &pane, w, cx);
                        s.panes.insert(id, pane);
                        s.select(id, w, cx);
                    }
                    Err(e) => {
                        s.message = e.to_string();
                        cx.notify();
                    }
                }
            },
        );
    }
    fn remove_pane(&mut self, id: Id) {
        self.remove_leaf(id);
        self.watches.remove(&id);
        self.panes.remove(&id);
        self.remote.retain(|_, pane_id| *pane_id != id);
    }
    fn remove_leaf(&mut self, id: Id) {
        if self.pane_menu == Some(id) {
            self.pane_menu = None;
        }
        if self.context_menu.is_some_and(|(pane, _)| pane == id) {
            self.context_menu = None;
        }
        if self.toast.as_ref().is_some_and(|t| t.pane == Some(id)) {
            self.toast = None;
        }
        if let Some(i) = self.tabs.iter().position(|t| t.layout.contains(id)) {
            if let Some(layout) = self.tabs[i].layout.clone().remove(id) {
                let tab = &mut self.tabs[i];
                if tab.active == id {
                    tab.active = layout.first()
                }
                tab.layout = layout;
                tab.zoom = false
            } else {
                self.tabs.remove(i);
                if i < self.current {
                    self.current -= 1
                }
                self.current = self.current.min(self.tabs.len().saturating_sub(1))
            }
        }
    }
    pub(super) fn event(&mut self, e: Value, w: &mut Window, cx: &mut Context<Self>) {
        let kind = e["event"].as_str().unwrap_or("");
        let n = e["pane"].as_u64().unwrap_or(0);
        let cols = e["cols"].as_u64().unwrap_or(80).clamp(2, 400) as u16;
        let rows = e["rows"].as_u64().unwrap_or(24).clamp(2, 200) as u16;
        match kind {
            "prefs" => {
                let previous_lines = self.bounded_history();
                self.prefs = e;
                if self.bounded_history() != previous_lines {
                    self.sync_history_input(cx);
                }
                self.apply_preferences(cx);
                if self.startup_local && self.panes.is_empty() {
                    self.startup_local = false;
                    self.local(None, w, cx)
                }
            }
            "accounts" => {
                self.accounts = e;
                self.refreshing_catalogue = false;
                if self.page == Page::Create
                    && !items(&self.accounts["accounts"]).iter().any(|a| {
                        a["origin"] == self.origin
                            && a["account"]["id"] == self.account_id
                            && a["canCreate"] == true
                    })
                {
                    self.creating = false;
                    self.show(Page::Home, w, cx);
                    self.message = "Choose a signed-in account to create a session.".into();
                }
            }
            "paneRemoved" => {
                if let Some(&id) = self.remote.get(&n) {
                    let selected = self.tabs.get(self.current).is_some_and(|t| t.active == id);
                    self.remove_pane(id);
                    if selected && self.page != Page::Home {
                        self.show(Page::Terminal, w, cx);
                    }
                }
            }
            "opened" => {
                if let Some(b) = self.bridge.clone() {
                    self.creating = false;
                    let fs = self.fontsize();
                    let p = cx.new(|cx| {
                        let mut pane = Pane::remote(
                            b,
                            n,
                            strval(&e, "title"),
                            strval(&e, "server"),
                            fs,
                            w,
                            cx,
                        );
                        pane.mark = AgentMark::get(e["tool"].as_str());
                        pane.session_key = e["sessionKey"].as_str().map(str::to_owned);
                        pane
                    });
                    let id = self.insert(p, w, cx);
                    self.remote.insert(n, id);
                }
            }
            "select" => {
                self.split_at = None;
                self.creating = false;
                w.activate_window();
                if let Some(&id) = self.remote.get(&n) {
                    self.select(id, w, cx)
                }
            }
            "trust" => {
                self.startup_cloak = false;
                self.startup_hint = false;
                let answer = w.prompt(
                    PromptLevel::Warning,
                    "Trust this Outpost server?",
                    Some(&strval(&e, "origin")),
                    &["Cancel", "Trust server"],
                    cx,
                );
                let id = e["id"].clone();
                let b = self.bridge.clone();
                cx.spawn(async move |_, _| {
                    let yes = answer.await == Ok(1);
                    if let Some(b) = b {
                        b.call(json!({"op":"answer","id":id,"answer":yes}))
                    }
                })
                .detach();
            }
            "browser" => {
                let url = strval(&e, "url");
                if url.starts_with("https://") || url.starts_with("http://") {
                    cx.open_url(&url)
                }
            }
            "fileSaved" => self.message = format!("Saved {}", strval(&e, "path")),
            "notice" => {
                let pane_id = self.remote.get(&n).copied();
                if let Some(id) = pane_id {
                    self.clear_pane_sticky_toast(id);
                }
                let active_pane = self.tabs.get(self.current).map(|t| t.active);
                if pane_id.is_none() || pane_id == active_pane {
                    self.show_toast(pane_id, strval(&e, "message"), false, cx);
                }
            }
            "error" => {
                if let Some(&id) = self.remote.get(&n) {
                    self.clear_pane_sticky_toast(id);
                    if let Some(p) = self.panes.get(&id) {
                        p.update(cx, |p, _| p.sending = false);
                    }
                }
                self.creating = false;
                self.refreshing_catalogue = false;
                let error_message = strval(&e, "message");
                if self.startup_local && self.panes.is_empty() {
                    self.startup_local = false;
                    self.startup_cloak = false;
                    self.startup_hint = false;
                    self.local(None, w, cx);
                } else {
                    self.startup_cloak = false;
                    self.startup_hint = false;
                }
                self.message = error_message
            }
            "targets" if self.origin == e["origin"] && self.account_id == e["accountId"] => {
                self.targets = e["targets"].clone()
            }
            "options"
                if self.origin == e["origin"]
                    && self.account_id == e["accountId"]
                    && self.target == e["target"] =>
            {
                self.tool = items(&e["tools"])
                    .first()
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .into();
                self.options = e;
            }
            "submitted" => {
                if let Some(id) = self.remote.get(&n)
                    && let Some(p) = self.panes.get(id)
                {
                    let submitted = strval(&e, "text");
                    let matched = p.update(cx, |p, _| {
                        p.sending = false;
                        if p.draft == submitted {
                            p.draft.clear();
                            p.command("draft", json!({"active":false}));
                            true
                        } else {
                            false
                        }
                    });
                    if matched
                        && self.tabs.get(self.current).is_some_and(|t| t.active == *id)
                        && self.page == Page::Compose
                    {
                        self.show(Page::Terminal, w, cx)
                    }
                }
            }
            "preview" | "fileProgress" | "previewFailed" => self.file_event(n, e, cx),
            "filesChanged" => {
                if let Some(pane) = self.remote.get(&n).and_then(|id| self.panes.get(id)) {
                    pane.read(cx).command("files", json!({}));
                }
            }
            "files" => {
                if let Some(pane) = self.remote.get(&n).and_then(|id| self.panes.get(id)) {
                    pane.update(cx, |p, _| {
                        p.files = e["files"].clone();
                        p.file_previews.retain(items(&p.files));
                    });
                    if self.active().as_ref() == Some(pane)
                        && self
                            .preview_id
                            .as_ref()
                            .is_some_and(|id| !items(&e["files"]).iter().any(|f| f["id"] == *id))
                    {
                        self.preview_id = None;
                        self.preview = None;
                    }
                }
            }
            "barrier" => self.call(json!({"op":"ack","pane":n,"seq":e["seq"]})),
            _ => {
                if let Some(p) = self.remote.get(&n).and_then(|id| self.panes.get(id)) {
                    p.update(cx, |p, cx| {
                        match kind {
                            "links" => p.restore_links(items(&e["cells"])),
                            "cursor" => p.restore_cursor(
                                e["x"].as_u64().unwrap_or(0),
                                e["y"].as_u64().unwrap_or(0),
                            ),
                            "reset" => p.reset(cols, rows),
                            "geometry" => p.geometry(cols, rows),
                            "clear" => p.clear_screen(false, cx),
                            "output" => {
                                if let Ok(bytes) = STANDARD.decode(strval(&e, "data")) {
                                    p.feed(&bytes, cx)
                                }
                            }
                            "connection" => {
                                let state = &e["state"];
                                p.restoring = state["kind"] != "connected";
                                if !p.restoring {
                                    p.grid_visible = true;
                                    p.command("files", json!({}));
                                }
                                p.status = if state["kind"] == "connected" {
                                    String::new()
                                } else {
                                    state["message"]
                                        .as_str()
                                        .or(state["kind"].as_str())
                                        .unwrap_or("")
                                        .into()
                                }
                            }
                            "session" => {
                                p.title = strval(&e, "title");
                                p.mark = AgentMark::get(e["tool"].as_str());
                            }
                            "deliveries" => p.waiting = e["waiting"].as_u64().unwrap_or(0),
                            "activity" => {
                                p.activity = strval(&e["activity"], "state");
                                if let Some(seq) = e["seq"].as_u64() {
                                    p.command("ack", json!({"seq":seq}));
                                }
                            }
                            _ => return,
                        }
                        cx.notify()
                    });
                    if matches!(
                        kind,
                        "output" | "geometry" | "reset" | "clear" | "cursor" | "links"
                    ) {
                        return;
                    }
                }
            }
        }
        cx.notify()
    }
    fn choose(&mut self, id: String) {
        self.call(json!({"op":"choose","value":id}))
    }
    fn create_form(
        &mut self,
        origin: String,
        account_id: String,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.origin != origin || self.account_id != account_id {
            self.name.update(cx, |s, cx| s.set_value_silent("", cx));
            self.directory
                .update(cx, |s, cx| s.set_value_silent("", cx));
        }
        self.origin = origin;
        self.account_id = account_id;
        self.target.clear();
        self.tool.clear();
        self.targets = Value::Null;
        self.options = Value::Null;
        self.creating = false;
        self.call(json!({"op":"targets","origin":self.origin,"accountId":self.account_id}));
        self.show(Page::Create, w, cx)
    }
    fn creation_ready(&self) -> bool {
        !self.creating && !self.tool.is_empty() && items(&self.options["missing"]).is_empty()
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        match self.page {
            Page::Home => {
                self.call(json!({"op":"login","origin":self.address.read(cx).value().trim()}))
            }
            Page::Find => self.find(true, cx),
            Page::Compose => {
                let msg = self.compose.read(cx).value().to_string();
                if !msg.is_empty()
                    && let Some(p) = self.active()
                {
                    if p.read(cx).server.is_some() {
                        p.update(cx, |p, _| {
                            if !p.sending {
                                p.sending = true;
                                p.command("submit", json!({"text":msg}))
                            }
                        });
                    } else {
                        p.update(cx, |p, cx| {
                            p.paste(msg, cx);
                            p.write(vec![13], cx);
                            p.draft.clear()
                        });
                        self.show(Page::Terminal, w, cx)
                    }
                }
            }
            Page::Create => {
                if !self.creation_ready() {
                    return;
                }
                let name = self.name.read(cx).value().trim();
                let dir = self.directory.read(cx).value().trim();
                if name.is_empty() || dir.is_empty() {
                    self.message = "Enter a session name and working directory.".into()
                } else {
                    self.creating = true;
                    self.message = "Creating session…".into();
                    self.call(json!({"op":"create","origin":self.origin,"accountId":self.account_id,"target":self.target,"input":{"name":name,"rootDir":dir,"tool":self.tool}}))
                }
                cx.notify()
            }
            Page::Manage => {
                if let Some(t) = self.tabs.get_mut(self.current) {
                    t.name = self.name.read(cx).value().chars().take(120).collect()
                }
                self.show(Page::Terminal, w, cx)
            }
            Page::Switch | Page::Choose => {
                let index = self.picker_index;
                self.activate_picker_item(index, w, cx);
            }
            _ => {}
        }
    }
    fn find(&self, next: bool, cx: &mut Context<Self>) {
        let query = self.find_query.read(cx).value().to_owned();
        if let Some(p) = self.active() {
            p.update(cx, |p, cx| p.find(&query, next, cx))
        }
    }
    fn settings(&mut self, cx: &mut Context<Self>) {
        self.call(json!({"op":"prefs","fontSize":self.fontsize(),"sound":self.prefs["sound"],"localShell":self.prefs["localShell"], "scrollbackLines":self.bounded_history(), "unlimitedScrollback": self.prefs["unlimitedScrollback"] == true}));
        self.apply_preferences(cx);
        cx.notify()
    }
    fn apply_preferences(&self, cx: &mut Context<Self>) {
        for p in self.panes.values() {
            p.update(cx, |p, cx| {
                p.set_scrollback(self.history());
                p.font_size = self.fontsize();
                p.sound = self.prefs["sound"].as_bool().unwrap_or(true);
                cx.notify()
            })
        }
    }
    pub(super) fn manage(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(t) = self.tabs.get(self.current) {
            self.name
                .update(cx, |s, cx| s.set_value_silent(&t.name, cx));
            self.show(Page::Manage, w, cx)
        }
    }
    fn catalogue(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.refreshing_catalogue = true;
        self.call(json!({"op":"refresh"}));
        self.show(Page::Choose, w, cx)
    }
    pub(super) fn dismiss_page(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.split_at = None;
        let next = if self.tabs.is_empty() {
            Page::Home
        } else {
            Page::Terminal
        };
        self.show(next, w, cx);
    }
    fn shortcuts(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        if self.new_tab_menu_open
            || self.pane_menu.is_some()
            || self.context_menu.is_some()
            || self.file_key(e, w, cx)
        {
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
        let cmd = if cfg!(target_os = "macos") {
            m.platform
        } else {
            m.control && m.shift
        };
        let key = k.key.as_str();
        if matches!(self.page, Page::Choose | Page::Switch)
            && !m.control
            && !m.alt
            && !m.platform
            && !m.shift
            && matches!(key, "down" | "up")
        {
            self.step_picker(if key == "down" { 1 } else { -1 }, cx);
        } else if key == "escape"
            && ((self.page != Page::Terminal && !self.tabs.is_empty())
                || !matches!(self.page, Page::Terminal | Page::Home))
        {
            self.dismiss_page(w, cx)
        } else if key == "enter"
            && !matches!(self.page, Page::Terminal | Page::Settings)
            && (self.page != Page::Compose || !m.shift)
        {
            self.submit(w, cx)
        } else if key == "tab" && m.control && !self.tabs.is_empty() {
            let n = self.tabs.len();
            let next = (self.current + if m.shift { n - 1 } else { 1 }) % n;
            self.select(self.tabs[next].active, w, cx)
        } else if key == "right"
            && m.alt
            && (m.platform || m.control)
            && self.page == Page::Terminal
            && !self.tabs.is_empty()
        {
            let t = &self.tabs[self.current];
            let mut ids = Vec::new();
            t.layout.pane_order(&mut ids);
            let pos = ids.iter().position(|id| *id == t.active).unwrap_or(0);
            self.select(ids[(pos + 1) % ids.len()], w, cx)
        } else if key == "d"
            && self.page == Page::Terminal
            && !cfg!(target_os = "macos")
            && m.control
            && m.alt
        {
            self.split(Axis::Down, w, cx)
        } else if key == "enter"
            && self.page == Page::Terminal
            && self.active().is_some()
            && !cfg!(target_os = "macos")
            && m.control
            && m.alt
        {
            self.toggle_zoom(self.tabs[self.current].active, w, cx)
        } else if cmd {
            match key {
                "t" => {
                    self.split_at = None;
                    self.local(None, w, cx)
                }
                "d" if self.page == Page::Terminal => self.split(
                    if m.shift && cfg!(target_os = "macos") || m.alt {
                        Axis::Down
                    } else {
                        Axis::Across
                    },
                    w,
                    cx,
                ),
                "w" if self.page == Page::Terminal => {
                    if let Some(t) = self.tabs.get(self.current) {
                        self.close(t.active, w, cx)
                    }
                }
                "p" => self.show(Page::Switch, w, cx),
                "," => self.show(Page::Settings, w, cx),
                "f" if self.active().is_some() => self.show(Page::Find, w, cx),
                "enter"
                    if self.page == Page::Terminal
                        && self.active().is_some()
                        && cfg!(target_os = "macos")
                        && m.shift =>
                {
                    self.toggle_zoom(self.tabs[self.current].active, w, cx)
                }
                "enter" if self.active().is_some() => self.show(Page::Compose, w, cx),
                "n" => {
                    if let Err(e) = crate::open_workspace(true, cx) {
                        self.message = e.to_string()
                    }
                }
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" => {
                    if let Some(t) = self.tabs.get(key.parse::<usize>().unwrap() - 1) {
                        self.select(t.active, w, cx)
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
    fn set_new_tab_menu(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.new_tab_menu_open != open {
            self.new_tab_menu_open = open;
            if open {
                self.pane_menu = None;
                self.context_menu = None;
                self.files_menu = None;
            }
            cx.notify();
        }
    }
    fn new_tab_menu(&self, cx: &Context<Self>) -> impl IntoElement + use<> {
        let open = self.new_tab_menu_open;
        // The menu also dismisses on outside mouse-down. Both handlers use
        // the state of this frame so a second press on + closes it once.
        let toggle =
            || cx.listener(move |s, _: &MouseDownEvent, _, cx| s.set_new_tab_menu(!open, cx));
        let trigger = div()
            .on_mouse_down(MouseButton::Left, toggle())
            .on_mouse_down(MouseButton::Right, toggle())
            .child(
                gpui::components::Button::icon("new", LucideIcon::Plus)
                    .ghost()
                    .size(ComponentSize::Sm)
                    .w(px(30.))
                    .h(px(30.))
                    .when(!open, |button| {
                        button.tooltip_text("Open a terminal or session")
                    })
                    .on_click(cx.listener(move |s, e: &ClickEvent, _, cx| {
                        if !matches!(e, ClickEvent::Mouse(_)) {
                            s.set_new_tab_menu(!open, cx);
                        }
                    })),
            );
        let local_entry = |label: SharedString, profile: Option<String>| {
            MenuEntry::item_with_icon(
                label,
                LucideIcon::Terminal,
                cx.listener(move |s, _, w, cx| {
                    s.split_at = None;
                    s.local(profile.clone(), w, cx)
                }),
            )
        };
        let mut menu = dropdown_menu("new-tab-menu", open)
            .trigger(trigger)
            .min_width(px(240.))
            .on_close(cx.listener(|s, _, _, cx| s.set_new_tab_menu(false, cx)));
        let profiles = items(&self.prefs["profiles"]);
        let shortcut = if cfg!(target_os = "macos") {
            "⌘T"
        } else {
            "Ctrl+Shift+T"
        };
        if profiles.len() <= 1 {
            menu = menu.entry(local_entry("Local terminal".into(), None).with_shortcut(shortcut));
        } else {
            menu = menu.entry(MenuEntry::Label("Local shells".into()));
            let preferred = self
                .local_profile(None)
                .and_then(|profile| profile["id"].as_str());
            for profile in profiles {
                let entry =
                    local_entry(strval(profile, "name").into(), Some(strval(profile, "id")));
                menu = menu.entry(if profile["id"].as_str() == preferred {
                    entry.with_shortcut(shortcut)
                } else {
                    entry
                });
            }
        }
        menu = menu.entry(MenuEntry::Separator);
        if items(&self.accounts["accounts"]).is_empty() {
            menu.entry(MenuEntry::item_with_icon(
                "Connect to an Outpost server…",
                LucideIcon::Server,
                cx.listener(|s, _, w, cx| {
                    s.split_at = None;
                    s.show(Page::Home, w, cx);
                    s.address.read(cx).focus_handle(cx).focus(w, cx);
                }),
            ))
        } else {
            menu.entry(MenuEntry::item_with_icon(
                "Outpost session…",
                LucideIcon::Server,
                cx.listener(|s, _, w, cx| {
                    s.split_at = None;
                    s.catalogue(w, cx)
                }),
            ))
        }
    }
    fn chrome(&self, w: &Window, cx: &mut Context<Self>) -> Div {
        let mut strip = row()
            .gap(px(3.))
            .id("tabs")
            .track_scroll(&self.drag.strip)
            .overflow_x_scroll()
            .max_w(relative(0.76));
        for slot in self.strip_slots() {
            let Some(i) = slot else {
                let preview = self.drag.preview.as_ref().expect("preview slot");
                strip = strip.child(
                    row()
                        .mt(px(3.))
                        .h(px(37.))
                        .min_w(px(130.))
                        .w(px(210.))
                        .max_w(px(240.))
                        .px(px(9.))
                        .items_center()
                        .truncate()
                        .rounded_t(px(6.))
                        .bg(rgb(0x242424))
                        .border_b_2()
                        .border_color(rgb(0xd4d4d4))
                        .child(preview.label.content()),
                );
                continue;
            };
            let tab = &self.tabs[i];
            let id = tab.active;
            let title = if tab.name.is_empty() {
                self.panes[&id].read(cx).title.clone()
            } else {
                tab.name.clone()
            };
            let handle = row()
                .id(("tab-handle", tab.id))
                .role(gpui::accesskit::Role::Tab)
                .aria_selected(i == self.current && self.page == Page::Terminal)
                .focusable()
                .tab_stop(i == self.current)
                .on_click(cx.listener(move |s, e: &ClickEvent, w, cx| {
                    if !matches!(e, ClickEvent::Mouse(_)) {
                        s.select(id, w, cx);
                    }
                }))
                .flex_1()
                .min_w_0()
                .h_full()
                .pl(px(9.))
                .gap(px(6.))
                .cursor_pointer()
                .aria_label(format!("Select or drag tab {title}"))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, e: &MouseDownEvent, w, cx| {
                        w.prevent_default();
                        if e.click_count == 2 {
                            s.cancel_drag(cx);
                            s.select(id, w, cx);
                            s.manage(w, cx);
                            s.name.read(cx).focus_handle(cx).focus(w, cx);
                        } else {
                            s.arm(id, true, e.position, w, cx);
                        }
                    }),
                )
                .child(panes::status_dot(self.panes[&id].read(cx)))
                .children(self.panes[&id].read(cx).mark.map(|m| m.icon(14.)))
                .child(div().flex_1().truncate().child(title.clone()))
                .when(!matches!(tab.layout, Layout::Pane(_)), |e| {
                    e.child(text(
                        self.panes
                            .keys()
                            .filter(|id| tab.layout.contains(**id))
                            .count()
                            .to_string(),
                        10.,
                        MUTED,
                    ))
                });
            let tab = row()
                .id(("tab", tab.id))
                .relative()
                .mt(px(3.))
                .h(px(37.))
                .min_w(px(130.))
                .w(px(210.))
                .max_w(px(240.))
                .border_1()
                .border_color(gpui::transparent_black())
                .border_b_2()
                .pr(px(3.))
                .gap(px(6.))
                .rounded_t(px(6.))
                .cursor_pointer()
                .when(i == self.current && self.page == Page::Terminal, |e| {
                    e.bg(rgb(0x161616)).border_color(rgb(0x2a2a2a)).child(
                        div()
                            .absolute()
                            .bottom_0()
                            .left_0()
                            .right_0()
                            .h(px(2.))
                            .bg(rgb(0xd4d4d4)),
                    )
                })
                .hover(|e| e.bg(rgb(0x222222)))
                .child(handle)
                .child(panes::header_button(
                    ("tab-close", tab.id),
                    LucideIcon::X,
                    "Close tab",
                    true,
                    cx.listener(move |s, _, w, cx| s.close_tab(id, w, cx)),
                ))
                .on_mouse_up(
                    MouseButton::Middle,
                    cx.listener(move |s, _, w, cx| s.close_tab(id, w, cx)),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |s, _, w, cx| {
                        s.select(id, w, cx);
                        s.manage(w, cx)
                    }),
                );
            strip = strip.child(tab)
        }
        row()
            .w_full()
            .h(px(40.))
            .flex_none()
            .px(px(8.))
            .when(cfg!(target_os = "macos"), |e| e.pl(px(78.)))
            .gap(px(4.))
            .bg(rgb(0))
            .border_b_1()
            .border_color(rgb(0x1f1f1f))
            .child(
                div()
                    .id("home")
                    .size(px(30.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .cursor_pointer()
                    .child(img(self.logo.clone()).size(px(20.)))
                    .on_click(cx.listener(|s, _, w, cx| {
                        s.split_at = None;
                        s.show(Page::Home, w, cx)
                    })),
            )
            .when(!self.startup_cloak, |bar| {
                bar.child(strip).child(self.new_tab_menu(cx))
            })
            .child(snapshot_source(
                &self.drag.empty_bar,
                div()
                    .id("window-drag-area")
                    .flex_1()
                    .h_full()
                    .window_control_area(WindowControlArea::Drag)
                    .when(!cfg!(windows), |area| {
                        area.on_mouse_down(MouseButton::Left, |event, w, _| {
                            if event.click_count == 2 {
                                w.zoom_window();
                            } else {
                                w.start_window_move();
                            }
                        })
                    }),
            ))
            .when(!self.startup_cloak, |bar| {
                bar.child(icon("switch", LucideIcon::Search, cx, |s, w, cx| {
                    s.show(Page::Switch, w, cx)
                }))
                .child(if self.page == Page::Terminal {
                    icon("split", LucideIcon::Columns2, cx, |s, w, cx| {
                        s.split(Axis::Across, w, cx)
                    })
                    .on_mouse_down(
                        MouseButton::Right,
                        cx.listener(|s, _, w, cx| s.split(Axis::Down, w, cx)),
                    )
                    .into_any_element()
                } else {
                    div()
                        .size(px(30.))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .opacity(0.35)
                        .child(lucide_icon(LucideIcon::Columns2).size(px(17.)))
                        .into_any_element()
                })
                .child(icon("settings", LucideIcon::Settings, cx, |s, w, cx| {
                    s.show(Page::Settings, w, cx)
                }))
            })
            .when(cfg!(windows), |bar| {
                // Win32 handles clicks, Snap Layouts, and the normal close request through these hitboxes.
                let caption = |id: &'static str, area: WindowControlArea, glyph: &'static str| {
                    div()
                        .id(id)
                        .w(px(46.))
                        .h_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .window_control_area(area)
                        .font_family("Segoe MDL2 Assets")
                        .text_size(px(10.))
                        .hover(move |s| {
                            s.bg(rgb(if area == WindowControlArea::Close {
                                0xc42b1c
                            } else {
                                0x292929
                            }))
                        })
                        .child(glyph)
                };
                bar.pr_0().child(
                    row()
                        .h_full()
                        .flex_none()
                        .child(caption(
                            "window-minimize",
                            WindowControlArea::Min,
                            "\u{e921}",
                        ))
                        .child(caption(
                            "window-maximize",
                            WindowControlArea::Max,
                            if w.is_maximized() {
                                "\u{e923}"
                            } else {
                                "\u{e922}"
                            },
                        ))
                        .child(caption(
                            "window-close",
                            WindowControlArea::Close,
                            "\u{e8bb}",
                        )),
                )
            })
    }
    fn node(&self, node: &Layout, headers: bool, cx: &mut Context<Self>) -> AnyElement {
        match node {
            Layout::Pane(id) => {
                let id = *id;
                let p = self.panes[&id].clone();
                let pane = p.read(cx);
                let active = self.tabs[self.current].active == id;
                let mut body = col().size_full().bg(rgb(BG));
                if headers {
                    body = body.child(self.pane_header(id, pane, active, cx));
                }
                let status = (!pane.status.is_empty()).then(|| {
                    row()
                        .absolute()
                        .top(px(5.))
                        .left(px(5.))
                        .bg(rgb(BG))
                        .px(px(8.))
                        .child(text(pane.status.clone(), 12., MUTED))
                        .when(pane.server.is_some(), |e| {
                            e.child(control("Reconnect", false, cx, move |s, _, cx| {
                                s.panes[&id].read(cx).command("reconnect", json!({}))
                            }))
                        })
                });
                if pane.waiting > 0 {
                    body = body.child(control(
                        format!("Deliver waiting message ({})", pane.waiting),
                        false,
                        cx,
                        move |s, _, cx| s.panes[&id].read(cx).command("deliver", json!({})),
                    ))
                }
                let badge = (self.files_menu == Some(id) || !items(&pane.files).is_empty())
                    .then(|| self.files_dropdown(id, pane, cx));
                let surface = col()
                    .relative()
                    .p(px(5.))
                    .flex_1()
                    .overflow_hidden()
                    .child(p)
                    .when(!active, |e| {
                        e.child(div().absolute().inset_0().bg(rgba(0x00000052)))
                    })
                    .children(status)
                    .children(
                        badge.map(|badge| div().absolute().top(px(6.)).right(px(8.)).child(badge)),
                    );
                let pane_body = body.child(surface);
                snapshot_source(&self.watches[&id].1, pane_body).into_any_element()
            }
            Layout::Split {
                id,
                axis,
                ratio,
                first,
                second,
            } => {
                let id = *id;
                let axis = *axis;
                let extent = self.bounds.get(&id).map(|b| {
                    px(node.first_extent(f32::from(if axis == Axis::Across {
                        b.size.width
                    } else {
                        b.size.height
                    })))
                });
                let this = cx.weak_entity();
                let bound = canvas(
                    move |b, _, cx| {
                        let _ = this.update(cx, |s, cx| {
                            if s.bounds.insert(id, b) != Some(b) {
                                cx.notify()
                            }
                        });
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full();
                let ratio = *ratio;
                let bar = div()
                    .id(("divider", id))
                    .role(gpui::accesskit::Role::Splitter)
                    .aria_label("Resize terminal panes")
                    .aria_orientation(if axis == Axis::Across {
                        gpui::accesskit::Orientation::Vertical
                    } else {
                        gpui::accesskit::Orientation::Horizontal
                    })
                    .aria_value(format!("{:.0}%", ratio * 100.))
                    .focusable()
                    .tab_stop(true)
                    .focus_visible(|s| s.bg(rgb(0x707070)))
                    .flex_none()
                    .bg(rgb(0x292929))
                    .hover(|e| e.bg(rgb(0x707070)))
                    .when(axis == Axis::Across, |e| {
                        e.w(px(crate::layout::GAP))
                            .h_full()
                            .cursor(CursorStyle::ResizeLeftRight)
                    })
                    .when(axis == Axis::Down, |e| {
                        e.h(px(crate::layout::GAP))
                            .w_full()
                            .cursor(CursorStyle::ResizeUpDown)
                    })
                    .on_key_down(cx.listener(move |s, e: &KeyDownEvent, w, cx| {
                        if e.keystroke.modifiers != Modifiers::default() {
                            return;
                        }
                        let value = match (axis, e.keystroke.key.as_str()) {
                            (Axis::Across, "left") | (Axis::Down, "up") => ratio - 0.05,
                            (Axis::Across, "right") | (Axis::Down, "down") => ratio + 0.05,
                            (_, "home") => 0.5,
                            _ => return,
                        };
                        s.tabs[s.current].layout.resize(id, value);
                        w.prevent_default();
                        cx.stop_propagation();
                        cx.notify();
                    }))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |s, e: &MouseDownEvent, _, cx| {
                            if e.click_count == 2 {
                                s.resizing = None;
                                let tab = &mut s.tabs[s.current];
                                tab.layout.resize(id, 0.5);
                                cx.notify();
                            } else {
                                s.resizing = Some((id, axis));
                            }
                        }),
                    );
                div()
                    .relative()
                    .size_full()
                    .flex()
                    .when(axis == Axis::Across, |e| e.flex_row())
                    .when(axis == Axis::Down, |e| e.flex_col())
                    .child(bound)
                    .child(
                        col()
                            .flex_none()
                            .when(axis == Axis::Across, |e| {
                                e.w(extent
                                    .map(DefiniteLength::from)
                                    .unwrap_or_else(|| relative(ratio)))
                                    .h_full()
                            })
                            .when(axis == Axis::Down, |e| {
                                e.h(extent
                                    .map(DefiniteLength::from)
                                    .unwrap_or_else(|| relative(ratio)))
                                    .w_full()
                            })
                            .child(self.node(first, true, cx)),
                    )
                    .child(bar)
                    .child(col().flex_1().child(self.node(second, true, cx)))
                    .into_any_element()
            }
        }
    }
    fn panel(&self, page: Page, cx: &mut Context<Self>) -> AnyElement {
        let mut content = col()
            .w_full()
            .max_w(px(680.))
            .mx_auto()
            .gap(px(11.))
            .py(px(55.));
        if !self.tabs.is_empty() {
            content = content.child(
                row().child(
                    div()
                        .id("back-to-terminal")
                        .role(gpui::accesskit::Role::Button)
                        .focusable()
                        .tab_stop(true)
                        .focus_visible(|s| s.bg(rgb(0x242424)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .py(px(4.))
                        .px(px(6.))
                        .ml(px(-6.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .text_size(px(13.))
                        .text_color(rgb(MUTED))
                        .hover(|s| s.bg(rgb(0x1a1a1a)).text_color(rgb(0xffffff)))
                        .on_click(cx.listener(|s, _, w, cx| s.show(Page::Terminal, w, cx)))
                        .child(lucide_icon(LucideIcon::ArrowLeft).size(px(14.)))
                        .child("Back to terminal")
                        .child(kbd("Esc").ml(px(4.)).bg(rgb(0x161616))),
                ),
            );
        }
        let title = |k: &str, t: &str| {
            col()
                .gap(px(3.))
                .child(text(k.to_owned(), 10., 0x8f8f8f).font_weight(FontWeight::SEMIBOLD))
                .child(text(t.to_owned(), 28., 0xfafafa).font_weight(FontWeight::SEMIBOLD))
        };
        match page {
            Page::Home => {
                content = content
                    .child(
                        row()
                            .gap(px(20.))
                            .child(img(self.logo.clone()).size(px(52.)))
                            .child(title(
                                "YOUR TERMINAL WORKSPACE",
                                "A place for every session.",
                            )),
                    )
                    .child(text(
                        "Use + to open a local shell or an Outpost session in a new tab.",
                        13.,
                        MUTED,
                    ))
                    .child(section("Recent sessions"));
                for item in items(&self.accounts["recent"]) {
                    let id = strval(item, "id");
                    let raw_title = strval(item, "title");
                    let server = strval(item, "server");
                    let (name, machine) = picker::split_session_title(&raw_title);
                    let host = picker::display_server(&server);
                    let subtitle = match machine {
                        Some(m) => format!("{m} · {host}"),
                        None => host.to_owned(),
                    };
                    let mark = AgentMark::get(item["tool"].as_str());
                    content = content.child(
                        button(SharedString::from(id.clone()), false, cx, move |s, _, _| {
                            s.choose(id.clone())
                        })
                        .py(px(8.))
                        .child(
                            col()
                                .gap(px(2.))
                                .child(agent_label(mark, name.to_owned()))
                                .child(
                                    div()
                                        .when(mark.is_some(), |d| d.pl(px(24.)))
                                        .truncate()
                                        .text_size(px(11.5))
                                        .text_color(rgb(0x888888))
                                        .child(subtitle),
                                ),
                        ),
                    )
                }
                if items(&self.accounts["recent"]).is_empty() {
                    content=content.child(text("Your 10 most recent managed sessions will appear here after connecting. Local terminals aren't saved.",13.,MUTED))
                } else {
                    content = content.child(row().child(control(
                        "Clear recent sessions",
                        false,
                        cx,
                        |s, _, _| s.call(json!({"op":"forget"})),
                    )))
                }
                content = content
                    .child(
                        row().child(control_with_icon(
                            "Open local terminal",
                            LucideIcon::Terminal,
                            false,
                            true,
                            cx,
                            |s, w, cx| {
                                s.split_at = None;
                                s.local(None, w, cx)
                            },
                        )),
                    )
                    .child(
                        row()
                            .justify_between()
                            .child(section("Logged-in Outpost servers"))
                            .child(control_with_icon(
                                "Refresh",
                                LucideIcon::RefreshCw,
                                false,
                                false,
                                cx,
                                |s, _, _| s.call(json!({"op":"refresh"})),
                            )),
                    );
                for acc in items(&self.accounts["accounts"]) {
                    let origin = strval(acc, "origin");
                    let new = origin.clone();
                    let account = strval(&acc["account"], "id");
                    let machines = origin.clone();
                    content = content.child(
                        row()
                            .id(SharedString::from(origin.clone()))
                            .flex_wrap()
                            .child(
                                col()
                                    .flex_1()
                                    .child(text(origin.clone(), 14., TEXT))
                                    .child(text(strval(acc, "status"), 12., MUTED)),
                            )
                            .child(control_with_icon(
                                "Machines",
                                LucideIcon::ExternalLink,
                                true,
                                false,
                                cx,
                                move |_, _, cx| cx.open_url(&machines),
                            ))
                            .when(acc["canCreate"] == true, |row| {
                                row.child(control_with_icon(
                                    "New session",
                                    LucideIcon::Plus,
                                    false,
                                    false,
                                    cx,
                                    move |s, w, cx| {
                                        s.create_form(new.clone(), account.clone(), w, cx)
                                    },
                                ))
                            })
                            .child(control("Sign out", false, cx, move |s, _, _| {
                                s.call(json!({"op":"logout","origin":origin}))
                            })),
                    )
                }
                if items(&self.accounts["accounts"]).is_empty() {
                    content = content.child(text("No servers signed in yet.", 13., MUTED))
                }
                content = content
                    .child(section("Connect a server"))
                    .child(
                        row()
                            .child(col().flex_1().child(field(&self.address)))
                            .child(control_with_icon(
                                "Sign in with browser",
                                LucideIcon::ExternalLink,
                                true,
                                true,
                                cx,
                                |s, w, cx| s.submit(w, cx),
                            )),
                    )
                    .child(text(
                        "Sign-in happens in your browser. Server logins last 30 days.",
                        13.,
                        MUTED,
                    ));
                for sign in items(&self.accounts["signIns"]) {
                    let origin = strval(sign, "origin");
                    content = content.child(
                        row()
                            .child(text(
                                format!("{origin} · {}", strval(sign, "phase")),
                                13.,
                                TEXT,
                            ))
                            .child(control("Cancel sign-in", false, cx, move |s, _, _| {
                                s.call(json!({"op":"cancel","origin":origin}))
                            })),
                    )
                }
            }
            Page::Settings => {
                content = content.child(self.settings_view(cx));
            }
            Page::Choose | Page::Switch => {}
            Page::Create => {
                let servers = self.creatable_accounts();
                content = content.child(title("MANAGED SESSIONS", "New session"));
                if servers.len() > 1 {
                    let mut server_row = row().flex_wrap();
                    for (origin, account_id) in servers {
                        let selected = self.origin == origin && self.account_id == account_id;
                        let label = picker::display_server(&origin).to_owned();
                        server_row = server_row.child(control(
                            label,
                            selected,
                            cx,
                            move |s, w, cx| {
                                s.create_form(origin.clone(), account_id.clone(), w, cx)
                            },
                        ));
                    }
                    content = content.child(section("Server")).child(server_row);
                } else {
                    content = content.child(text(
                        picker::display_server(&self.origin).to_owned(),
                        13.,
                        MUTED,
                    ));
                }
                content = content.child(section("Machine"));
                for t in items(&self.targets) {
                    let id = strval(t, "id");
                    content = content.child(control(
                        strval(t, "name"),
                        self.target == id,
                        cx,
                        move |s, _, cx| {
                            s.target = id.clone();
                            s.options = Value::Null;
                            s.tool.clear();
                            s.message.clear();
                            s.call(json!({"op":"options","origin":s.origin,"accountId":s.account_id,"target":id}));
                            cx.notify()
                        },
                    ))
                }
                if self.targets.is_null() && self.message.is_empty() {
                    content = content.child(text("Loading machines…", 13., MUTED));
                } else if self.targets.is_array() && items(&self.targets).is_empty() {
                    let url = format!("{}/?add=1", self.origin);
                    content = content
                        .child(text(
                            "Add a machine to this account to create a session.",
                            13.,
                            MUTED,
                        ))
                        .child(control_with_icon(
                            "Add a machine",
                            LucideIcon::ExternalLink,
                            true,
                            false,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        ));
                }
                if !self.target.is_empty() {
                    content = content.child(section("Tool"));
                    if self.options.is_null() && self.message.is_empty() {
                        content = content.child(text("Checking required software…", 13., MUTED));
                    }
                }
                let missing = items(&self.options["missing"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                if !missing.is_empty() {
                    let url = format!("{}/?target={}", self.origin, self.target);
                    content = content
                        .child(text(
                            format!(
                                "Install {} on this machine to create a session.",
                                missing.join(", ")
                            ),
                            13.,
                            TEXT,
                        ))
                        .child(control_with_icon(
                            "Open machine",
                            LucideIcon::ExternalLink,
                            true,
                            false,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        ));
                }
                for t in items(&self.options["tools"]) {
                    let t = t.as_str().unwrap_or("").to_owned();
                    let label = agent_label(AgentMark::get(Some(&t)), t.clone());
                    content = content.child(
                        row().child(
                            button(
                                SharedString::from(t.clone()),
                                self.tool == t,
                                cx,
                                move |s, _, cx| {
                                    s.tool = t.clone();
                                    cx.notify()
                                },
                            )
                            .child(label),
                        ),
                    )
                }
                content = content
                    .child(section("Session name"))
                    .child(field(&self.name))
                    .child(section("Working directory"))
                    .child(field(&self.directory))
                    .child(
                        row().child(
                            Button::new("create-session")
                                .label("Create and open")
                                .primary()
                                .disabled(!self.creation_ready())
                                .on_click(cx.listener(|s, _, w, cx| s.submit(w, cx))),
                        ),
                    );
            }
            Page::Manage => {
                content = content
                    .child(title("ORGANIZE YOUR WORKSPACE", "Terminal actions"))
                    .child(section("Tab name"))
                    .child(
                        row()
                            .child(col().flex_1().child(field(&self.name)))
                            .child(control("Save name", false, cx, |s, w, cx| s.submit(w, cx))),
                    );
                content = content.child(
                    row()
                        .child(control("Split side by side", false, cx, |s, w, cx| {
                            s.split(Axis::Across, w, cx)
                        }))
                        .child(control("Split top and bottom", false, cx, |s, w, cx| {
                            s.split(Axis::Down, w, cx)
                        }))
                        .child(control(
                            "Split with managed session",
                            false,
                            cx,
                            |s, w, cx| {
                                s.split_at =
                                    s.tabs.get(s.current).map(|t| (t.active, Axis::Across));
                                s.catalogue(w, cx)
                            },
                        )),
                );
                content = content.child(
                    row()
                        .child(control("Copy selection", false, cx, |s, w, cx| {
                            if let Some(id) = s.tabs.get(s.current).map(|t| t.active)
                                && let Some(p) = s.panes.get(&id).cloned()
                                && p.update(cx, |p, cx| p.copy(cx))
                            {
                                s.show_toast(Some(id), "Copied to clipboard".into(), false, cx);
                            }
                            s.show(Page::Terminal, w, cx)
                        }))
                        .child(control("Paste", false, cx, |s, w, cx| {
                            if let Some(p) = s.active() {
                                p.update(cx, |p, cx| p.paste_clipboard(cx))
                            }
                            s.show(Page::Terminal, w, cx)
                        }))
                        .when(
                            self.active().is_some_and(|p| p.read(cx).server.is_some()),
                            |row| {
                                row.child(control(
                                    "Paste image as file path",
                                    false,
                                    cx,
                                    |s, w, cx| {
                                        if let Some(p) = s.active() {
                                            p.update(cx, |p, cx| p.paste_image_path(cx));
                                        }
                                        s.show(Page::Terminal, w, cx)
                                    },
                                ))
                            },
                        )
                        .child(control("Select all", false, cx, |s, w, cx| {
                            s.select_all(cx);
                            s.show(Page::Terminal, w, cx)
                        })),
                );
                content = content.child(
                    row()
                        .child(control("Find", false, cx, |s, w, cx| {
                            s.show(Page::Find, w, cx)
                        }))
                        .child(control("Write a message", false, cx, |s, w, cx| {
                            s.show(Page::Compose, w, cx)
                        }))
                        .child(control("Clear screen", false, cx, |s, w, cx| {
                            if let Some(p) = s.active() {
                                p.update(cx, |p, cx| p.clear_screen(true, cx))
                            }
                            s.show(Page::Terminal, w, cx)
                        })),
                );
                if self.active().is_some_and(|p| p.read(cx).server.is_some()) {
                    content = content.child(row().child(control(
                        "Session files",
                        false,
                        cx,
                        |s, w, cx| {
                            let id = s.tabs[s.current].active;
                            s.open_files(id, w, cx);
                        },
                    )))
                }
                content = content.child(
                    row()
                        .child(control("Move tab to new window", false, cx, |s, w, cx| {
                            s.detach(true, w, cx)
                        }))
                        .child(control("Move pane to new window", false, cx, |s, w, cx| {
                            s.detach(false, w, cx)
                        })),
                );
                if let Some(tab) = self.tabs.get(self.current) {
                    content = content.child(row().child(control(
                        "Reload focused terminal",
                        false,
                        cx,
                        |s, w, cx| s.reload_selected(w, cx),
                    )));
                    if !matches!(tab.layout, Layout::Pane(_)) {
                        content = content.child(
                            row()
                                .child(control(
                                    "Move pane to its own tab",
                                    false,
                                    cx,
                                    |s, w, cx| s.place_selected(false, Destination::Tab, w, cx),
                                ))
                                .child(control(
                                    if tab.zoom {
                                        "Restore split panes"
                                    } else {
                                        "Zoom pane"
                                    },
                                    false,
                                    cx,
                                    |s, w, cx| s.toggle_zoom(s.tabs[s.current].active, w, cx),
                                )),
                        );
                    }
                    let mut order = row();
                    for (label, direction) in [("Move tab left", -1isize), ("Move tab right", 1)] {
                        if let Some(next) = self
                            .current
                            .checked_add_signed(direction)
                            .filter(|i| *i < self.tabs.len())
                        {
                            order = order.child(control(label, false, cx, move |s, w, cx| {
                                s.tabs.swap(s.current, next);
                                s.current = next;
                                s.show(Page::Terminal, w, cx);
                            }));
                        }
                    }
                    content = content.child(order);
                    for (i, other) in self
                        .tabs
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i != self.current)
                    {
                        let dest = other.active;
                        let pane = self.panes[&dest].read(cx);
                        let label = agent_label(
                            pane.mark,
                            format!("Move beside tab {} · {}", i + 1, pane.title),
                        );
                        content = content.child(
                            button(("move-beside", dest), false, cx, move |s, w, cx| {
                                s.place_selected(
                                    true,
                                    Destination::Split(dest, Axis::Across, false),
                                    w,
                                    cx,
                                )
                            })
                            .child(label),
                        );
                    }
                    for h in cx
                        .windows()
                        .into_iter()
                        .filter(|h| *h != self.handle)
                        .filter_map(|h| h.downcast::<Workspace>())
                    {
                        let Ok(other) = h.read(cx) else { continue };
                        let active = other.active();
                        let pane = active.as_ref().map(|p| p.read(cx));
                        let title = pane.map_or("Outpost", |p| p.title.as_str());
                        let mut actions = row();
                        for (whole, label) in [(true, "Move tab"), (false, "Move pane")] {
                            let label = format!("{label} to window {} · {title}", other.id);
                            actions = actions.child(
                                button(
                                    SharedString::from(label.clone()),
                                    false,
                                    cx,
                                    move |s, w, cx| {
                                        if let Some(item) = s.selected_item(whole, cx) {
                                            s.transfer_to(&item, h, Destination::Tab, w, cx)
                                        }
                                    },
                                )
                                .child(agent_label(pane.and_then(|p| p.mark), label)),
                            );
                        }
                        content = content.child(actions);
                    }
                    content = content.child(
                        row()
                            .child(control("Close pane", false, cx, |s, w, cx| {
                                s.close(s.tabs[s.current].active, w, cx)
                            }))
                            .child(control("Close tab", false, cx, |s, w, cx| {
                                s.close_tab(s.tabs[s.current].active, w, cx)
                            })),
                    );
                }
            }
            Page::Find | Page::Compose => {}
            Page::Terminal => {}
        }
        div()
            .id("page")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(32.))
            .child(content)
            .into_any_element()
    }
    fn startup_cloak_view(&self) -> AnyElement {
        col()
            .size_full()
            .bg(rgb(BG))
            .items_center()
            .justify_center()
            .when(self.startup_hint, |c| {
                c.gap(px(10.))
                    .child(img(self.logo.clone()).size(px(28.)).opacity(0.4))
                    .child(text("Starting…", 12., 0x6e6e6e))
            })
            .into_any_element()
    }
}
impl Render for Workspace {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.prefetch_thumbnail(cx);
        self.drag.rendered_tabs = self
            .strip_slots()
            .into_iter()
            .map(|slot| slot.map(|i| self.tabs[i].id))
            .collect();
        self.drag.rendered_anchor = self.drag.preview.as_ref().map(|p| p.destination);
        let body = if self.startup_cloak {
            self.startup_cloak_view()
        } else if matches!(
            self.page,
            Page::Terminal | Page::Find | Page::Compose | Page::Choose | Page::Switch
        ) && let Some(t) = self.tabs.get(self.current)
        {
            if t.zoom {
                self.node(&Layout::Pane(t.active), true, cx)
            } else {
                self.node(&t.layout, false, cx)
            }
        } else if matches!(self.page, Page::Choose | Page::Switch) {
            self.panel(Page::Home, cx)
        } else {
            self.panel(self.page, cx)
        };
        let visible_toast = self.toast.as_ref().filter(|t| {
            t.pane.is_none()
                || self
                    .tabs
                    .get(self.current)
                    .is_some_and(|tab| Some(tab.active) == t.pane)
        });
        col()
            .relative()
            .child(self.drag_listener(cx))
            .track_focus(&self.focus)
            .size_full()
            .bg(rgb(BG))
            .text_color(rgb(TEXT))
            .text_size(px(13.))
            .child(self.chrome(w, cx))
            .when(self.page == Page::Find, |e| {
                e.child(
                    row()
                        .justify_end()
                        .px(px(8.))
                        .bg(rgb(0x161616))
                        .child(col().w(px(300.)).child(field(&self.find_query)))
                        .child(icon("previous", LucideIcon::ChevronUp, cx, |s, _, cx| {
                            s.find(false, cx)
                        }))
                        .child(icon("next", LucideIcon::ChevronDown, cx, |s, _, cx| {
                            s.find(true, cx)
                        }))
                        .child(icon("close-find", LucideIcon::X, cx, |s, w, cx| {
                            s.show(Page::Terminal, w, cx)
                        })),
                )
            })
            .child(
                col()
                    .relative()
                    .flex_1()
                    .overflow_hidden()
                    .child(body)
                    .children(self.picker_overlay(cx)),
            )
            .child(self.context_menu_overlay(cx))
            .children(self.drag_overlay())
            .children(self.file_viewer(cx))
            .when_some(visible_toast, |e, toast| {
                e.child(
                    div()
                        .absolute()
                        .bottom(px(14.))
                        .right(px(14.))
                        .px(px(10.))
                        .py(px(5.))
                        .rounded(px(6.))
                        .bg(rgb(0x1f1f1f))
                        .border_1()
                        .border_color(rgb(0x363636))
                        .shadow_md()
                        .text_size(px(12.))
                        .text_color(rgb(TEXT))
                        .child(toast.message.clone()),
                )
            })
            .when(self.page == Page::Compose, |e| {
                e.child(
                    row()
                        .items_end()
                        .p(px(8.))
                        .child(
                            col()
                                .flex_1()
                                .child(text_area(&self.compose).w_full().h(px(76.))),
                        )
                        .child(control("Send", true, cx, |s, w, cx| s.submit(w, cx)))
                        .child(icon("close-compose", LucideIcon::X, cx, |s, w, cx| {
                            s.show(Page::Terminal, w, cx)
                        })),
                )
            })
            .when(!self.message.is_empty(), |e| {
                e.child(
                    row()
                        .bg(rgb(0x242020))
                        .px(px(12.))
                        .child(text(self.message.clone(), 13., TEXT).flex_1())
                        .child(icon("dismiss-message", LucideIcon::X, cx, |s, _, cx| {
                            s.message.clear();
                            cx.notify()
                        })),
                )
            })
            .on_action(cx.listener(|s, _: &crate::menu::NewTerminal, w, cx| {
                s.split_at = None;
                s.local(None, w, cx)
            }))
            .on_action(cx.listener(|s, _: &crate::menu::TerminalActions, w, cx| s.manage(w, cx)))
            .on_action(
                cx.listener(|s, _: &crate::menu::Settings, w, cx| s.show(Page::Settings, w, cx)),
            )
            .on_action(cx.listener(|s, _: &crate::menu::CloseTerminal, w, cx| {
                if s.page == Page::Terminal
                    && let Some(t) = s.tabs.get(s.current)
                {
                    s.close(t.active, w, cx)
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::CopySelection, _, cx| {
                if s.page == Page::Terminal
                    && let Some(id) = s.tabs.get(s.current).map(|t| t.active)
                    && let Some(p) = s.panes.get(&id).cloned()
                    && p.update(cx, |p, cx| p.copy(cx))
                {
                    s.show_toast(Some(id), "Copied to clipboard".into(), false, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::PasteClipboard, _, cx| {
                if s.page == Page::Terminal
                    && let Some(p) = s.active()
                {
                    p.update(cx, |p, cx| p.paste_clipboard(cx));
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectAll, _, cx| {
                if s.page == Page::Terminal {
                    s.select_all(cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::FindInTerminal, w, cx| {
                if s.active().is_some() {
                    s.show(Page::Find, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ClearScreen, _, cx| {
                if s.page == Page::Terminal
                    && let Some(p) = s.active()
                {
                    p.update(cx, |p, cx| p.clear_screen(true, cx));
                }
            }))
            .capture_key_down(cx.listener(|s, e, w, cx| s.shortcuts(e, w, cx)))
    }
}

#[cfg(feature = "ui-tests")]
pub fn exercise_workspace() -> anyhow::Result<()> {
    use gpui::HeadlessAppContext;
    use std::time::{Duration, Instant};
    let mut test = HeadlessAppContext::with_platform(
        gpui_platform::current_platform(true).text_system(),
        Arc::new(gpui::icons::LucideAssetSource::new()),
        gpui_platform::current_headless_renderer,
    );
    let init_test = |cx: &mut App| {
        crate::init(cx);
        cx.set_global(crate::hub::Hub {
            bridge: None,
            prefs: json!({"fontSize":13.5,"sound":false,"profiles":[if cfg!(windows){json!({"id":"fixture","executable":"cmd.exe","args":["/D","/Q"]})}else{json!({"id":"fixture","executable":"/bin/sh","args":["-c",r#"printf 'INITIAL-SIZE=%s\n' "$(stty size)"; exec /bin/sh -i"#]})}]}),
            accounts: Value::Null,
            error: String::new(),
        })
    };
    test.update(init_test);
    let window = test.open_window(size(px(1024.), px(680.)), |w, cx| {
        cx.new(|cx| Workspace::new(false, w, cx))
    })?;
    let draw = |test: &mut HeadlessAppContext| {
        test.run_until_parked();
        test.update_window(window.into(), |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    };
    draw(&mut test);
    let click = |test: &mut HeadlessAppContext, x: f32, y: f32| -> anyhow::Result<()> {
        let position = point(px(x), px(y));
        test.update_window(window.into(), |_, w, cx| {
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        Ok(())
    };
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("home.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.show(Page::Settings, w, cx));
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("scrollback-settings.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.show(Page::Home, w, cx));
        })?;
        // Only the agent changes. Identical frames would mean the marks failed to paint.
        let mut frames = Vec::new();
        for tool in ["claude", "codex", "kimi", "deepseek", "antigravity"] {
            test.update_window(window.into(), |root, _, cx| {
                root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                    s.accounts = json!({"recent":[{"id":"fixture","title":"Session","server":"example","tool":tool}]});
                    cx.notify();
                });
            })?;
            draw(&mut test);
            let frame = test.capture_screenshot(window.into())?;
            anyhow::ensure!(
                !frames.contains(&frame),
                "Recent sessions did not render a distinct {tool} icon"
            );
            frames.push(frame);
        }
    }
    // Drive remote panes through the same focus and window activation callbacks as the app.
    let (bridge, commands) = Bridge::recording();
    let remote_window = test.open_window(size(px(700.), px(500.)), |w, cx| {
        cx.new(|cx| {
            let mut s = Workspace::new(false, w, cx);
            s.bridge = Some(bridge);
            s
        })
    })?;
    test.update_window(remote_window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            let origin = "https://example.com";
            s.create_form(origin.into(), "first".into(), w, cx);
            assert_eq!(commands.try_recv().unwrap()["accountId"], "first");
            s.target = "machine".into();
            s.name.update(cx, |name, cx| name.set_value_silent("Review", cx));
            s.directory.update(cx, |dir, cx| dir.set_value_silent("/work", cx));
            let mut options = json!({"event":"options","origin":origin,"accountId":"first","target":"machine","tools":["codex"],"missing":["bash"]});
            s.event(options.clone(), w, cx);
            s.submit(w, cx);
            assert!(!s.creation_ready());
            assert!(commands.try_recv().is_err());
            options["missing"] = json!([]);
            s.event(options, w, cx);
            assert!(s.creation_ready());
            s.submit(w, cx);
            let created = commands.try_recv().unwrap();
            assert_eq!(created["op"], "create");
            assert_eq!(created["accountId"], "first");
            s.event(json!({"event":"accounts","accounts":[{"origin":origin,"account":{"id":"second"},"canCreate":true}]}), w, cx);
            assert!(s.page == Page::Home);
        });
    })?;
    let focused = || {
        std::iter::from_fn(|| commands.try_recv().ok())
            .filter(|c| c["op"] == "focus")
            .map(|c| (c["pane"].as_u64().unwrap(), c["active"].as_bool().unwrap()))
            .collect::<Vec<_>>()
    };
    let open_remote = |test: &mut HeadlessAppContext, id| -> anyhow::Result<()> {
        test.update_window(remote_window.into(), |root, w, cx| {
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx|
                s.event(json!({"event":"opened","pane":id,"title":"test","server":"https://example.com"}), w, cx));
            w.draw(cx).clear(cx);
        })?;
        test.run_until_parked();
        Ok(())
    };
    open_remote(&mut test, 1)?;
    test.update_window(remote_window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(1, true)]);
    open_remote(&mut test, 2)?;
    let mut switched = focused();
    switched.sort_unstable();
    assert_eq!(switched, vec![(1, false), (2, true)]);
    test.update_window(remote_window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.show(Page::Settings, w, cx);
            s.prefs["unlimitedScrollback"] = json!(true);
            s.settings(cx);
            let pane = s.active().unwrap();
            pane.update(cx, |p, cx| {
                p.reset(40, 8);
                p.feed(b"FIRST-RETAINED-ROW\r\n", cx);
                p.feed(&b"row\r\n".repeat(25_000), cx);
                p.geometry(25, 6);
                p.find("FIRST-RETAINED-ROW", true, cx);
                assert_eq!(p.selected_text().as_deref(), Some("FIRST-RETAINED-ROW"));
                p.feed(b"\x1b[?1049hALT", cx);
            });
            s.prefs["unlimitedScrollback"] = json!(false);
            s.history_input
                .update(cx, |i, cx| i.set_value_silent("42", cx));
            s.save_history_limit(cx);
            assert_eq!(s.history(), 42);
            assert!(s.has_custom_settings());
            pane.update(cx, |p, cx| {
                p.feed(b"\x1b[?1049l", cx);
                p.find("FIRST-RETAINED-ROW", true, cx);
                assert!(p.selected_text().is_none());
                p.find("row", false, cx);
                assert_eq!(p.selected_text().as_deref(), Some("row"));
            });
            s.reset_terminal_settings(cx);
            assert!(!s.has_custom_settings());
            assert_eq!(s.history(), crate::terminal::DEFAULT_HISTORY);
        })
    })?;
    test.update_window(remote_window.into(), |root, w, cx| {
        w.draw(cx).clear(cx);
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.show(Page::Terminal, w, cx));
    })?;
    // A publication on a background tab must refresh that pane while Files is closed.
    test.update_window(remote_window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"connected"}}),
                w,
                cx,
            );
            s.event(json!({"event":"filesChanged","pane":1}), w, cx);
            s.event(
                json!({"event":"files","pane":1,"files":[{"id":"fixture"}]}),
                w,
                cx,
            );
            assert_eq!(items(&s.panes[&s.remote[&1]].read(cx).files).len(), 1);
            assert!(s.active().unwrap().read(cx).files.is_null());
        });
    })?;
    let lists: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter(|c| c["op"] == "files")
        .map(|c| c["pane"].as_u64().unwrap())
        .collect();
    assert_eq!(lists, [2, 1]);
    let screenshot = include_bytes!("../../public/favicon-32x32.png");
    test.update_window(remote_window.into(), |root, w, cx| {
        let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
        cx.write_to_clipboard(ClipboardItem::new_image(&image));
        let pane = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .active()
            .unwrap();
        pane.update(cx, |p, cx| {
            let paste = if cfg!(target_os = "macos") {
                "cmd-v"
            } else {
                "ctrl-shift-v"
            };
            p.key_for_test(paste, w, cx);
            p.paste_image_path(cx);
        });
    })?;
    for mode in ["attachment", "path"] {
        let command = commands.try_recv()?;
        assert_eq!(command["op"], "image");
        assert_eq!(command["pane"], 2);
        assert_eq!(command["mime"], "image/png");
        assert_eq!(command["mode"], mode);
        assert_eq!(
            STANDARD.decode(command["data"].as_str().unwrap())?,
            screenshot
        );
    }
    assert!(commands.try_recv().is_err());

    // Exercise clipboard copy/paste shortcuts, bracketed paste normalization,
    // left-to-right & right-to-left copy-on-select, and right-click context menu in mouse mode.
    test.update_window(remote_window.into(), |root, w, cx| {
        let pane = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .active()
            .unwrap();
        pane.update(cx, |p, cx| {
            p.reset(40, 8);
            p.grid_visible = true;
            p.feed(b"\x1b[?2004hhello world\r\nsecond line", cx);
        });
        w.draw(cx).clear(cx);
    })?;
    test.run_until_parked();
    // Drain any resize commands triggered by drawing remote_window.
    while commands.try_recv().is_ok() {}
    #[cfg(not(target_os = "macos"))]
    {
        test.update_window(remote_window.into(), |root, w, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            // Ctrl+V with text pastes using bracketed paste and \r line endings.
            cx.write_to_clipboard(ClipboardItem::new_string("line1\r\nline2\x1b[201~".into()));
            pane.update(cx, |p, cx| {
                p.key_for_test("ctrl-v", w, cx);
                p.key_for_test("shift-insert", w, cx);
            });
            // Ctrl+V with image in remote terminal uploads an attachment.
            let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            pane.update(cx, |p, cx| p.key_for_test("ctrl-v", w, cx));
        })?;
        for _ in 0..2 {
            let cmd = commands.try_recv()?;
            assert_eq!(cmd["op"], "input");
            assert_eq!(
                STANDARD.decode(cmd["data"].as_str().unwrap())?,
                b"\x1b[200~line1\rline2[201~\x1b[201~"
            );
        }
        let img_cmd = commands.try_recv()?;
        assert_eq!(img_cmd["op"], "image");
        assert_eq!(img_cmd["mode"], "attachment");
        assert!(commands.try_recv().is_err());

        // Ctrl+C with selection copies and clears selection without sending \x03;
        // a second Ctrl+C (with no selection) sends \x03.
        test.update_window(remote_window.into(), |root, w, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            pane.update(cx, |p, cx| {
                p.find("hello", true, cx);
                assert_eq!(p.selected_text().as_deref(), Some("hello"));
                p.key_for_test("ctrl-c", w, cx);
                assert!(!p.has_selection());
                p.key_for_test("ctrl-c", w, cx);
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("hello")
            );
        })?;
        let sigint = commands.try_recv()?;
        assert_eq!(sigint["op"], "input");
        assert_eq!(STANDARD.decode(sigint["data"].as_str().unwrap())?, b"\x03");
        assert!(commands.try_recv().is_err());
    }
    // Mouse drag selection (left-to-right and right-to-left) auto-copies exact cells on release,
    // and right-click opens the floating context menu even when MOUSE_MODE is enabled.
    let (row0_col0_left, row0_col4_right, row0_col6_left, row0_col10_right) =
        test.update_window(remote_window.into(), |root, _, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            let p = pane.read(cx);
            let origin = p.bounds_for_test().origin;
            let cell = p.cell_for_test();
            (
                origin + point(cell.width * 0.1, cell.height * 0.5),
                origin + point(cell.width * 4.9, cell.height * 0.5),
                origin + point(cell.width * 6.1, cell.height * 0.5),
                origin + point(cell.width * 10.9, cell.height * 0.5),
            )
        })?;
    test.update_window(remote_window.into(), |_, w, cx| {
        // Drag left-to-right across "hello" (cols 0..=4)
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col0_left,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: row0_col4_right,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: row0_col4_right,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("hello")
        );
        // Drag right-to-left across "world" (cols 10..=6) — must not drop start or end chars!
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col10_right,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: row0_col6_left,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: row0_col6_left,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("world")
        );
    })?;
    // Enable SGR mouse mode; right-click must open the GPUI PopupMenu, preserve selection,
    // and never send a mouse event to the remote application.
    let draw_remote = |test: &mut HeadlessAppContext| {
        test.run_until_parked();
        test.update_window(remote_window.into(), |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
        test.run_until_parked();
    };
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        pane.update(cx, |p, cx| p.feed(b"\x1b[?1000h\x1b[?1006h", cx));
        w.draw(cx).clear(cx);
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col6_left,
                button: MouseButton::Right,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(ws.read(cx).context_menu.is_some());
        assert!(ws.read(cx).page == Page::Terminal);
        assert_eq!(pane.read(cx).selected_text().as_deref(), Some("world"));
        w.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(ws.read(cx).context_menu.is_none());
        assert!(pane.read(cx).focus.is_focused(w));
    })?;
    let leaked_input: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter(|c| c["op"] == "input")
        .collect();
    assert!(
        leaked_input.is_empty(),
        "right-click in mouse mode must not send terminal input: {leaked_input:?}"
    );

    // Re-open the context menu, press Down + Enter to invoke Copy, and verify clipboard & focus.
    test.update_window(remote_window.into(), |_, w, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("stale".into()));
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col6_left,
                button: MouseButton::Right,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("down").unwrap(), cx);
        let enter = Keystroke::parse("enter").unwrap();
        w.dispatch_keystroke(enter.clone(), cx);
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: enter }), cx);
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(ws.read(cx).context_menu.is_none());
        assert!(pane.read(cx).focus.is_focused(w));
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("world")
        );
    })?;

    // OSC 52 from an inactive background pane must not clobber the clipboard; it queues
    // pending_copy for explicit Copy. OSC 52 from the active pane copies immediately.
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let bg = s.panes[&s.remote[&1]].clone();
            let fg = s.active().unwrap();
            cx.write_to_clipboard(ClipboardItem::new_string("keep-me".into()));
            bg.update(cx, |p, cx| {
                p.restoring = false;
                let osc52 = format!("\x1b]52;c;{}\x07", STANDARD.encode("from-bg"));
                p.feed(osc52.as_bytes(), cx);
                assert!(p.can_copy());
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("keep-me")
            );
            bg.update(cx, |p, cx| {
                assert!(p.copy(cx));
                assert!(!p.can_copy());
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("from-bg")
            );
            fg.update(cx, |p, cx| {
                let osc52 = format!("\x1b]52;c;{}\x07", STANDARD.encode("from-fg"));
                p.feed(osc52.as_bytes(), cx);
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("from-fg")
            );

            // Sticky upload toast stays until notice or error arrives for that pane.
            let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            fg.update(cx, |p, cx| p.paste_clipboard(cx));
            s.event(json!({"event":"notice","pane":2,"message":"Image attached"}), w, cx);
            let toast = s.toast.as_ref().expect("notice toast");
            assert_eq!(toast.message, "Image attached");
            assert!(!toast.sticky);

            fg.update(cx, |p, cx| p.paste_clipboard(cx));
            s.show_toast(Some(s.remote[&2]), "Uploading image…".into(), true, cx);
            s.event(json!({"event":"error","pane":2,"message":"Upload failed"}), w, cx);
            assert!(s.toast.is_none(), "error must clear sticky upload toast");
            s.message.clear();

            // Session picker (Choose & Switch) deduplicates open remote sessions, cleans up
            // repeated "name · name" titles, supports Up/Down + Enter + Escape, and creates via
            // a single New session action.
            assert_eq!(
                picker::split_session_title("gpui-enhancement · gpui-enhancement"),
                ("gpui-enhancement", None)
            );
            assert_eq!(
                picker::split_session_title("test · Main 114"),
                ("test", Some("Main 114"))
            );
            assert_eq!(
                picker::display_server("https://outpost.zoco.cc/"),
                "outpost.zoco.cc"
            );
            fg.update(cx, |p, _| {
                p.title = "test".into();
                p.server = Some("https://outpost.zoco.cc".into());
                p.session_key = Some("sess-open".into());
            });
            s.accounts = json!({
                "accounts": [
                    {"origin": "https://outpost.zoco.cc", "account": {"id": "a1"}, "canCreate": true},
                    {"origin": "http://localhost:6620", "account": {"id": "a2"}, "canCreate": true}
                ],
                "sessions": [
                    {"id": "sess-open", "title": "test · Main 114", "server": "https://outpost.zoco.cc", "detail": "claude · /work · running", "tool": "claude"},
                    {"id": "sess-other", "title": "gpui-enhancement · gpui-enhancement", "server": "http://localhost:6620", "detail": "antigravity · /repo · running", "tool": "antigravity"}
                ]
            });
            s.show(Page::Choose, w, cx);
            // Open remote pane 2 ("sess-open") is deduplicated into the single catalogue row;
            // open pane 1 ("test" on example.com, not in catalogue) stays reachable as fallback.
            let choose_items = s.picker_items(cx);
            assert_eq!(choose_items.len(), 3);
            assert!(matches!(
                &choose_items[0],
                picker::PickerItem::RemoteSession { id, open_pane, name, machine, .. }
                    if id == "sess-open" && open_pane.is_some() && name == "test" && machine.as_deref() == Some("Main 114")
            ));
            assert!(matches!(
                &choose_items[1],
                picker::PickerItem::RemoteSession { id, open_pane, name, machine, .. }
                    if id == "sess-other" && open_pane.is_none() && name == "gpui-enhancement" && machine.is_none()
            ));
            s.step_picker(1, cx);
            assert_eq!(s.picker_index, 1);
            s.step_picker(-1, cx);
            assert_eq!(s.picker_index, 0);
        });
    })?;
    draw_remote(&mut test);
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(remote_window.into())?
            .save(PathBuf::from(&dir).join("choose-session.png"))?;
    }
    test.update_window(remote_window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.dismiss_page(w, cx);
            assert!(s.page == Page::Terminal);

            // Verify Find uses its own input state independent of the session picker query.
            s.show(Page::Find, w, cx);
            assert!(s.find_query.read(cx).focus_handle(cx).is_focused(w));
            s.dismiss_page(w, cx);
            assert!(s.page == Page::Terminal);

            // Verify Write-a-message shortcut reaches Page::Compose on all platforms.
            let compose_key = if cfg!(target_os = "macos") {
                "cmd-enter"
            } else {
                "ctrl-shift-enter"
            };
            s.shortcuts(
                &KeyDownEvent {
                    keystroke: Keystroke::parse(compose_key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            assert!(s.page == Page::Compose);
            s.dismiss_page(w, cx);
            assert!(s.page == Page::Terminal);

            s.show(Page::Switch, w, cx);
            // Switch lists 2 open panes + only the 1 non-open catalogue session (sess-other).
            assert_eq!(s.picker_items(cx).len(), 3);
            s.open_create_session(w, cx);
            assert!(s.page == Page::Create);
            assert_eq!(s.origin, "https://outpost.zoco.cc");
            s.show(Page::Terminal, w, cx);
        });
    })?;
    draw_remote(&mut test);
    while commands.try_recv().is_ok() {}

    test.update_window(window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(2, false)]);
    test.update_window(remote_window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(2, true)], "a hidden tab must stay unread");
    test.update_window(remote_window.into(), |_, w, _| w.remove_window())?;
    test.run_until_parked();

    // Verify startup cloak prevents Page::Home from flashing while waiting for helper prefs,
    // and lifts cleanly on either "prefs" or a helper startup "error".
    {
        let saved_prefs = test.update(|cx| cx.global::<crate::hub::Hub>().prefs.clone());
        let (cloak_bridge, _) = Bridge::recording();
        test.update(|cx| {
            let hub = cx.global_mut::<crate::hub::Hub>();
            hub.bridge = Some(cloak_bridge);
            hub.prefs = Value::Null;
        });
        let cloak_win = test.open_window(size(px(700.), px(500.)), |w, cx| {
            cx.new(|cx| Workspace::new(true, w, cx))
        })?;
        test.update_window(cloak_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            assert!(ws.read(cx).startup_cloak);
            assert!(ws.read(cx).startup_local);
            assert!(ws.read(cx).tabs.is_empty());
            w.draw(cx).clear(cx);
            let mut prefs_event = saved_prefs.clone();
            prefs_event["event"] = json!("prefs");
            ws.update(cx, |s, cx| s.event(prefs_event, w, cx));
            assert!(!ws.read(cx).startup_cloak);
            assert!(!ws.read(cx).startup_local);
            assert!(ws.read(cx).page == Page::Terminal);
            assert_eq!(ws.read(cx).tabs.len(), 1);
        })?;
        test.update_window(cloak_win.into(), |_, w, _| w.remove_window())?;
        test.run_until_parked();

        // If the helper errors before sending prefs, the cloak lifts, the fallback shell opens,
        // and the error banner stays visible.
        let err_win = test.open_window(size(px(700.), px(500.)), |w, cx| {
            cx.new(|cx| Workspace::new(true, w, cx))
        })?;
        test.update_window(err_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            assert!(ws.read(cx).startup_cloak);
            ws.update(cx, |s, cx| {
                s.event(
                    json!({"event":"error","message":"helper crashed"}),
                    w,
                    cx,
                )
            });
            assert!(!ws.read(cx).startup_cloak);
            assert!(ws.read(cx).page == Page::Terminal);
            assert_eq!(ws.read(cx).tabs.len(), 1);
            assert_eq!(ws.read(cx).message, "helper crashed");
        })?;
        test.update_window(err_win.into(), |_, w, _| w.remove_window())?;
        test.update(|cx| {
            let hub = cx.global_mut::<crate::hub::Hub>();
            hub.bridge = None;
            hub.prefs = saved_prefs;
        });
        test.run_until_parked();
    }
    // Open the menu from the real + target. Dismissing it must leave the workspace alone.
    let x = if cfg!(target_os = "macos") { 132. } else { 62. };
    let menu_open = |test: &mut HeadlessAppContext| {
        test.update_window(window.into(), |root, _, cx| {
            let s = root.downcast::<Workspace>().unwrap();
            assert!(s.read(cx).tabs.is_empty());
            s.read(cx).new_tab_menu_open
        })
        .unwrap()
    };
    click(&mut test, x, 20.)?;
    draw(&mut test);
    assert!(menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    click(&mut test, 950., 300.)?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    test.update_window(window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx)
    })?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    click(&mut test, x + 45., 99.)?;
    draw(&mut test);
    test.update_window(window.into(), |root,w,cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s,cx| {
            assert!(s.page == Page::Home && !s.new_tab_menu_open && s.tabs.is_empty());
            assert!(s.address.read(cx).focus_handle(cx).is_focused(w));
            s.accounts=json!({"accounts":[{"origin":"https://example.com","account":{"id":"test"},"canCreate":true}]});
            cx.notify();
        })
    })?;
    click(&mut test, x, 20.)?;
    draw(&mut test);
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.advance_clock(gpui::components::ANIM_FAST);
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(dir).join("new-tab-menu.png"))?;
    }
    click(&mut test, x + 45., 99.)?;
    draw(&mut test);
    test.update_window(window.into(), |root, _, cx| {
        let s = root.downcast::<Workspace>().unwrap();
        assert!(
            s.read(cx).page == Page::Choose
                && !s.read(cx).new_tab_menu_open
                && s.read(cx).tabs.is_empty()
        );
    })?;
    click(&mut test, x, 20.)?;
    draw(&mut test);
    test.update_window(window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("down").unwrap(), cx);
        let enter = Keystroke::parse("enter").unwrap();
        w.dispatch_keystroke(enter.clone(), cx);
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: enter }), cx);
    })?;
    draw(&mut test);
    let p = test
        .update_window(window.into(), |root, _, cx| {
            root.downcast::<Workspace>().unwrap().read(cx).active()
        })?
        .expect("New terminal button");
    test.update_window(window.into(), |_, w, cx| {
        let cmd = if cfg!(windows) {
            "echo NATIVE-PTY-42"
        } else {
            "printf 'NATIVE-PTY-%d\\n' $((6*7))"
        };
        p.update(cx, |pane, cx| {
            pane.replace_text_in_range(None, cmd, w, cx);
            pane.key_for_test("enter", w, cx);
        });
    })?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        draw(&mut test);
        if test.update(|cx| p.read(cx).screen_text().contains("NATIVE-PTY-42")) {
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "Shell output did not reach the Alacritty grid"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    let check_startup_size =
        |test: &mut HeadlessAppContext, pane: &Entity<Pane>| -> anyhow::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                draw(test);
                if test.update(|cx| {
                    let pane = pane.read(cx);
                    pane.measured_size().is_some_and(|(cols, rows)| {
                        (cols, rows) != (80, 24)
                            && pane
                                .screen_text()
                                .contains(&format!("INITIAL-SIZE={rows} {cols}"))
                    })
                }) {
                    return Ok(());
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "The shell did not start at the measured pane size"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
    #[cfg(unix)]
    check_startup_size(&mut test, &p)?;
    #[cfg(target_os = "macos")]
    {
        // Use a real raw-mode reader. An image-only Command-V must leave its first
        // byte available for the foreground program's own Control-V binding.
        let wait_for_output = |test: &mut HeadlessAppContext, marker: &str| -> anyhow::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                draw(test);
                if test.update(|cx| p.read(cx).screen_text().contains(marker)) {
                    return Ok(());
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "Missing local PTY output: {marker}"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        test.update_window(window.into(), |_, w, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(
                r#"stty raw -echo; printf 'READER-%s\r\n' READY; v=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d ' '); stty sane; printf 'LOCAL-PASTE=%s\n' "$v""#.to_string()
            ));
            p.update(cx, |pane, cx| {
                pane.key_for_test("cmd-v", w, cx);
                pane.key_for_test("enter", w, cx);
            });
        })?;
        wait_for_output(&mut test, "READER-READY")?;
        test.update_window(window.into(), |_, w, cx| {
            let image = gpui::Image::from_bytes(
                gpui::ImageFormat::Png,
                include_bytes!("../../public/outpost-256.png").to_vec(),
            );
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            p.update(cx, |pane, cx| {
                pane.key_for_test("cmd-v", w, cx);
                pane.key_for_test("ctrl-v", w, cx);
            });
        })?;
        wait_for_output(&mut test, "LOCAL-PASTE=22")?;
    }
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.split(Axis::Across, w, cx))
    })?;
    draw(&mut test);
    assert!(test.update_window(window.into(), |root, _, cx| {
        root.downcast::<Workspace>().unwrap().read(cx).panes.len() == 2
    })?);
    #[cfg(unix)]
    {
        let split_pane = test.update_window(window.into(), |root, _, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap()
        })?;
        check_startup_size(&mut test, &split_pane)?;
    }
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(dir).join("split.png"))?;
    }
    // Exercise the same capture, geometry and release handlers as a physical drag.
    let gesture = |test: &mut HeadlessAppContext,
                   handle: AnyWindowHandle,
                   start: Point<Pixels>,
                   end: Point<Pixels>,
                   cancel: bool|
     -> anyhow::Result<()> {
        test.update_window(handle, |_, w, cx| {
            w.draw(cx).clear(cx);
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: start,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: end,
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Default::default(),
                }),
                cx,
            );
            // A hover normally lasts across frames; insertion may change tab
            // widths before the mouse-up reaches its original window.
            w.draw(cx).clear(cx);
            for other in cx.windows().into_iter().filter(|h| *h != handle) {
                let _ = cx.update_window(other, |_, w, cx| w.draw(cx).clear(cx));
            }
            if cancel {
                w.dispatch_event(
                    PlatformInput::KeyDown(KeyDownEvent {
                        keystroke: Keystroke::parse("escape").unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    }),
                    cx,
                );
            }
            w.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    position: end,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        Ok(())
    };
    let header = test.update_window(window.into(), |root, _, cx| {
        let s = root.downcast::<Workspace>().unwrap();
        let s = s.read(cx);
        let first = s.tabs[0].layout.first();
        s.watches[&first].1.bounds().unwrap().origin + point(px(40.), px(12.))
    })?;
    let outside = point(px(1160.), px(220.));
    gesture(&mut test, window.into(), header, outside, true)?;
    assert_eq!(
        test.update(|cx| cx.windows().len()),
        1,
        "Escape must cancel a tear-off"
    );
    gesture(&mut test, window.into(), header, outside, false)?;
    draw(&mut test);
    let detached = test
        .update(|cx| cx.windows().into_iter().find(|h| *h != window.into()))
        .expect("off-window release creates window");
    let target = test.update_window(window.into(), |_, w, cx| {
        drag::to_desktop(w, point(px(50.), px(360.)), cx)
    })?;
    let (handle, drop) = test.update_window(detached, |root, w, cx| {
        w.draw(cx).clear(cx);
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert!(s.panes.values().any(|v| v == &p), "the original PTY moved");
        (
            s.drag.strip.bounds_for_item(0).unwrap().center(),
            drag::from_desktop(w, target, cx),
        )
    })?;
    gesture(&mut test, detached, handle, drop, false)?;
    draw(&mut test);
    assert_eq!(
        test.update(|cx| cx.windows().len()),
        1,
        "docking consumes the empty source window"
    );
    assert!(test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        s.tabs.len() == 1 && s.panes.len() == 2 && s.active().as_ref() == Some(&p)
    })?);
    assert!(test.update(|cx| p.read(cx).screen_text().contains("NATIVE-PTY-42")));
    // Pull a pane out of a group onto its own tab, then reorder the tabs.
    let (pane_header, bar_end) = test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        (
            s.watches[&s.tabs[0].active].1.bounds().unwrap().origin + point(px(35.), px(11.)),
            s.drag.empty_bar.bounds().unwrap().center(),
        )
    })?;
    gesture(&mut test, window.into(), pane_header, bar_end, false)?;
    draw(&mut test);
    let (tab_start, before, stable_ids) = test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert_eq!(s.tabs.len(), 2, "the pane was promoted to a tab");
        (
            s.drag.strip.bounds_for_item(1).unwrap().center(),
            s.drag.strip.bounds_for_item(0).unwrap().origin + point(px(8.), px(10.)),
            [s.tabs[0].id, s.tabs[1].id],
        )
    })?;
    gesture(&mut test, window.into(), tab_start, before, false)?;
    draw(&mut test);
    test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert_eq!([s.tabs[0].id, s.tabs[1].id], [stable_ids[1], stable_ids[0]]);
        assert_eq!(s.active().as_ref(), Some(&p));
    })?;
    // Move a nested layout as one tab, hover another window, cancel, then dock.
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.split(Axis::Down, w, cx));
    })?;
    draw(&mut test);
    let start = test.update_window(window.into(), |root, _, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .drag
            .strip
            .bounds_for_item(0)
            .unwrap()
            .center()
    })?;
    gesture(&mut test, window.into(), start, outside, false)?;
    draw(&mut test);
    let detached = test
        .update(|cx| cx.windows().into_iter().find(|h| *h != window.into()))
        .expect("nested tab detached");
    let tab_bar = test.update_window(window.into(), |root, w, cx| {
        let local = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .drag
            .empty_bar
            .bounds()
            .unwrap()
            .center();
        drag::to_desktop(w, local, cx)
    })?;
    let (start, end) = test.update_window(detached, |root, w, cx| {
        w.draw(cx).clear(cx);
        let root = root.downcast::<Workspace>().unwrap();
        let s = root.read(cx);
        assert_eq!(s.panes.len(), 2);
        (
            s.drag.strip.bounds_for_item(0).unwrap().center(),
            drag::from_desktop(w, tab_bar, cx),
        )
    })?;
    gesture(&mut test, detached, start, end, true)?;
    assert_eq!(test.update(|cx| cx.windows().len()), 2);
    gesture(&mut test, detached, start, end, false)?;
    draw(&mut test);
    assert_eq!(test.update(|cx| cx.windows().len()), 1);
    test.update_window(window.into(), |root, _, cx| {
        let root = root.downcast::<Workspace>().unwrap();
        let s = root.read(cx);
        assert_eq!(s.tabs.len(), 2);
        assert_eq!(s.panes.len(), 3);
        assert!(matches!(
            s.tabs[s.current].layout,
            Layout::Split {
                axis: Axis::Down,
                ..
            }
        ));
        assert!(s.panes.values().any(|v| v == &p));
        assert!(p.read(cx).screen_text().contains("NATIVE-PTY-42"));
    })?;
    let mut prompts = gpui::TestApp::with_text_system_and_assets(
        gpui_platform::current_platform(true).text_system(),
        Arc::new(gpui::icons::LucideAssetSource::new()),
    );
    prompts.update(init_test);
    let mut workspace = prompts.open_window(|w, cx| Workspace::new(false, w, cx));
    let (left, right) = workspace.update(|s, w, cx| {
        s.local(None, w, cx);
        let left = s.tabs[s.current].active;
        s.split(Axis::Across, w, cx);
        (left, s.tabs[s.current].active)
    });
    let header_control =
        |workspace: &mut gpui::TestAppWindow<Workspace>, pane: Id, from_right: f32| {
            workspace.draw();
            workspace.read(|s, _| {
                let bounds = s.watches[&pane].1.bounds().unwrap();
                point(bounds.right() - px(from_right), bounds.top() + px(14.))
            })
        };
    let title = header_control(&mut workspace, left, 130.);
    workspace.simulate_click(title, MouseButton::Left);
    workspace.update(|s, w, cx| assert!(s.panes[&left].read(cx).focus.is_focused(w)));
    let tab = workspace.read(|s, _| s.drag.strip.bounds_for_item(0).unwrap().center());
    workspace.simulate_click(tab, MouseButton::Left);
    workspace.update(|s, w, cx| assert!(s.panes[&left].read(cx).focus.is_focused(w)));
    let zoom = header_control(&mut workspace, left, 65.);
    workspace.simulate_click(zoom, MouseButton::Left);
    workspace.read(|s, _| {
        assert!(s.tabs[0].zoom);
        assert_eq!(s.tabs[0].active, left);
        assert!(s.drag.gesture.is_none());
    });
    let restore = header_control(&mut workspace, left, 65.);
    workspace.simulate_click(restore, MouseButton::Left);
    assert!(!workspace.read(|s, _| s.tabs[0].zoom));
    let options = header_control(&mut workspace, right, 40.);
    workspace.simulate_click(options, MouseButton::Left);
    assert_eq!(workspace.read(|s, _| s.pane_menu), Some(right));
    workspace.draw();
    workspace.simulate_keystroke("escape");
    assert_eq!(workspace.read(|s, _| s.pane_menu), None);

    // Closing an inactive pane must neither arm a drag nor close the selected sibling.
    let close = header_control(&mut workspace, left, 15.);
    workspace.simulate_mouse_down(close, MouseButton::Left);
    workspace.read(|s, _| {
        assert!(s.drag.gesture.is_none());
        assert_eq!(s.tabs[0].active, right);
    });
    workspace.simulate_mouse_up(close, MouseButton::Left);
    assert!(prompts.has_pending_prompt());
    prompts.simulate_prompt_answer("Cancel");
    prompts.run_until_parked();
    assert_eq!(workspace.read(|s, _| s.panes.len()), 2);
    workspace.update(|s, w, cx| assert!(s.panes[&right].read(cx).focus.is_focused(w)));
    workspace.draw();
    workspace.simulate_click(close, MouseButton::Left);
    prompts.simulate_prompt_answer("Close pane");
    prompts.run_until_parked();
    workspace.update(|s, w, cx| {
        assert!(matches!(s.tabs[0].layout, Layout::Pane(id) if id == right));
        assert_eq!(s.tabs[0].active, right);
        assert!(!s.request_window_close(w, cx));
    });
    prompts.simulate_prompt_answer("Cancel");
    prompts.run_until_parked();
    let arrival = workspace.update(|s, w, cx| {
        assert_eq!(s.panes.len(), 1);
        assert!(!s.close_pending);
        assert!(!s.request_window_close(w, cx));
        s.local(None, w, cx);
        assert!(!s.request_window_close(w, cx));
        s.tabs[s.current].active
    });
    prompts.simulate_prompt_answer("Close window");
    prompts.run_until_parked();
    assert!(!prompts.has_pending_prompt());
    workspace.update(|s, w, cx| {
        assert_eq!(s.panes.keys().copied().collect::<Vec<_>>(), vec![arrival]);
        s.close(arrival, w, cx);
    });
    prompts.simulate_prompt_answer("Close pane");
    prompts.run_until_parked();
    assert!(prompts.read(|cx| cx.windows().is_empty()));
    Ok(())
}

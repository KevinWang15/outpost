mod create;
mod drag;
pub(crate) mod files;
mod find;
mod panes;
mod picker;
mod settings;
use crate::{
    agent_mark::AgentMark,
    bridge::Bridge,
    layout::{Axis, Id, Layout, Tab, next_id},
    terminal::{ConnectionState, Pane, PaneChanged, SearchOptions},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use create::CreateForm;
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
const TAB_IDEAL_W: f32 = 210.;
const TAB_MAX_W: f32 = 240.;
const TAB_MIN_W: f32 = 108.;
const TAB_GAP: f32 = 2.;
const COMPACT_BAR_WIDTH: f32 = 760.;

#[derive(Clone, Copy, Debug)]
struct ChromeLayout {
    compact_bar: bool,
    overflowing: bool,
    show_overflow_menu: bool,
    drag_min: f32,
    est_max_scroll_x: f32,
}

fn compute_chrome_layout(
    viewport_w: f32,
    slot_count: usize,
    is_macos: bool,
    is_windows: bool,
) -> ChromeLayout {
    let compact_bar = viewport_w < COMPACT_BAR_WIDTH;
    let drag_min = if compact_bar { 56. } else { 80. };
    let left_pad = if is_macos { 78. } else { 8. };
    let right_edge = if is_windows { 138. } else { 8. };
    let right_tools = if compact_bar { 0. } else { 30. * 3. + 4. * 3. };
    // Home (30) + gaps around strip/actions/drag + '+' (30) + optional '⌄' when compact (2+26).
    let actions_base = if compact_bar { 30. + 2. + 26. } else { 30. };
    let fixed_without_arrows =
        left_pad + 30. + 4. + 4. + actions_base + 4. + drag_min + 4. + right_tools + right_edge;
    let avail_without_arrows = (viewport_w - fixed_without_arrows).max(0.);
    let min_tabs_total = if slot_count == 0 {
        0.
    } else {
        slot_count as f32 * TAB_MIN_W + (slot_count - 1) as f32 * TAB_GAP
    };
    let overflowing = min_tabs_total > avail_without_arrows + 0.5;
    let show_overflow_menu = compact_bar || overflowing;
    let extra_when_overflowing = if overflowing {
        // ◀ (24 + 2) + ▶ (2 + 24) + optional '⌄' appearing on wide bars (2 + 26).
        52. + if compact_bar { 0. } else { 28. }
    } else {
        0.
    };
    let avail_strip_w = (avail_without_arrows - extra_when_overflowing).max(0.);
    let est_max_scroll_x = if overflowing {
        (min_tabs_total - avail_strip_w).max(0.)
    } else {
        0.
    };
    ChromeLayout {
        compact_bar,
        overflowing,
        show_overflow_menu,
        drag_min,
        est_max_scroll_x,
    }
}

fn show_tab_divider(
    current_id: Id,
    next_id: Option<Id>,
    active_tab_id: Option<Id>,
    hovered_tab_id: Option<Id>,
) -> bool {
    let Some(next_id) = next_id else {
        return false;
    };
    let is_highlighted = |id| active_tab_id == Some(id) || hovered_tab_id == Some(id);
    !is_highlighted(current_id) && !is_highlighted(next_id)
}
#[derive(Clone, Copy, PartialEq)]
enum Page {
    Terminal,
    Home,
    Switch,
    Choose,
    Settings,
    Create,
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
    bar_menu_open: bool,
    strip_scroll_anim: Option<(std::time::Instant, f32, f32)>,
    pane_menu: Option<Id>,
    context_menu: Option<(Id, Point<Pixels>)>,
    tab_menu: Option<(Id, Point<Pixels>)>,
    tab_rename: Option<Id>,
    hovered_tab: Option<Id>,
    find_open: bool,
    find_pane: Option<Id>,
    find_options: SearchOptions,
    find_focus: FocusHandle,
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
    name: Entity<InputState>,
    tab_rename_input: Entity<InputState>,
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
    create: CreateForm,
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Destination {
    Split(Id, Axis, bool),
    Before(Id),
    Tab,
}
#[derive(Clone, Copy)]
enum CloseScope {
    Window,
    Tab(Id),
    OtherTabs(Id),
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
        .h(px(38.))
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
        .text_color(rgba(0xffffffa6))
        .cursor_pointer()
        .hover(|s| s.bg(rgba(0xffffff18)).text_color(rgb(0xf0f0f0)))
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
                .size(ComponentSize::Sm)
                .placeholder("Find…")
                .leading_icon(LucideIcon::Search)
                .clearable(true)
        });
        cx.subscribe(&find_query, |s: &mut Self, _, event: &InputEvent, cx| {
            match event {
                InputEvent::CommittedChange(_) => {
                    if s.find_open {
                        s.sync_find(false, cx);
                    }
                }
                InputEvent::Submit(_) => {
                    if s.find_open {
                        s.step_find(true, cx);
                    }
                }
                _ => cx.notify(),
            }
        })
        .detach();
        let history_input = entry("Lines", cx);
        cx.subscribe(&history_input, |s: &mut Self, _, event: &InputEvent, cx| {
            if let InputEvent::Submit(_) = event {
                s.save_history_limit(cx);
            }
        })
        .detach();
        let tab_rename_input = entry("Custom tab name", cx);
        cx.subscribe_in(
            &tab_rename_input,
            w,
            |s: &mut Self, _, event: &InputEvent, w, cx| {
                if let InputEvent::Submit(_) = event {
                    s.commit_tab_rename(w, cx);
                }
            },
        )
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
                s.set_bar_menu(false, cx);
                s.pane_menu = None;
                s.context_menu = None;
                s.tab_menu = None;
                s.hovered_tab = None;
                s.cancel_drag(cx);
            } else {
                s.active_order = next_id();
                for pane in s.panes.values() {
                    pane.read(cx).command("resume", json!({}))
                }
            }
            cx.notify();
        })
        .detach();
        let weak = cx.weak_entity();
        w.on_window_should_close(cx, move |w, cx| {
            weak.update(cx, |s, cx| s.request_window_close(w, cx))
                .unwrap_or(true)
        });
        let focus = cx.focus_handle();
        let find_focus = cx.focus_handle();
        focus.focus(w, cx);
        cx.on_focus_lost(w, |s, w, cx| s.restore_focus(w, cx))
            .detach();
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
            bar_menu_open: false,
            strip_scroll_anim: None,
            pane_menu: None,
            context_menu: None,
            tab_menu: None,
            tab_rename: None,
            hovered_tab: None,
            find_open: false,
            find_pane: None,
            find_options: SearchOptions::default(),
            find_focus,
            toast: None,
            close_pending: false,
            bridge,
            panes: Default::default(),
            remote: Default::default(),
            tabs: vec![],
            current: 0,
            page: Page::Home,
            focus,
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
            name: entry("Refactor billing", cx),
            tab_rename_input,
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
            create: CreateForm::new(cx),
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
        self.bar_menu_open = false;
        self.pane_menu = None;
        self.context_menu = None;
        self.tab_menu = None;
        self.tab_rename = None;
        self.files_menu = None;
        self.preview_id = None;
        self.preview = None;
        self.create.close_all(cx);
        if self.page != Page::Terminal && self.find_open {
            self.find_open = false;
            self.clear_find_highlights(cx);
            self.find_query
                .update(cx, |input, cx| input.set_invalid(false, cx));
        }
        match self.page {
            Page::Terminal => {
                if self.find_open {
                    self.sync_find(true, cx);
                }
                if let Some(p) = self.active() {
                    p.update(cx, |p, cx| p.focus_terminal(w, cx))
                }
            }
            Page::Settings => {
                self.sync_history_input(cx);
                self.focus.focus(w, cx);
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
            self.strip_scroll_anim = None;
            self.drag.strip.scroll_to_item(i);
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
                let changed = t.active != id;
                t.active = id;
                if changed && s.find_open && s.page == Page::Terminal {
                    s.sync_find(true, cx);
                }
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
    fn close_other_tabs(&mut self, keep_tab_id: Id, w: &mut Window, cx: &mut Context<Self>) {
        if self.tabs.iter().any(|t| t.id == keep_tab_id) {
            self.request_close(CloseScope::OtherTabs(keep_tab_id), w, cx);
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
            CloseScope::OtherTabs(keep) => self
                .tabs
                .iter()
                .any(|t| t.id != keep && t.layout.contains(id)),
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
            CloseScope::OtherTabs(_) => (
                format!("Close the other tabs ({count} {noun})?"),
                "Close other tabs",
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
            if self.tab_menu.is_some_and(|(t, _)| t == tab.id) {
                self.tab_menu = None;
            }
            if self.tab_rename == Some(tab.id) {
                self.tab_rename = None;
            }
            if self.hovered_tab == Some(tab.id) {
                self.hovered_tab = None;
            }
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
    fn tab_drag_item(&self, tab_id: Id, cx: &App) -> Option<DragItem> {
        let tab = self.tabs.iter().find(|t| t.id == tab_id)?;
        let pane = self.panes.get(&tab.active)?.read(cx);
        let status = panes::pane_activity_state(panes::tab_representative(tab, &self.panes, cx));
        Some(DragItem {
            pane: tab.active,
            window: self.id,
            whole: true,
            label: DragLabel::new(pane.title.clone(), pane.mark, status),
        })
    }
    fn selected_item(&self, whole: bool, cx: &App) -> Option<DragItem> {
        let tab = self.tabs.get(self.current)?;
        let pane = self.panes.get(&tab.active)?.read(cx);
        let status = if whole {
            panes::pane_activity_state(panes::tab_representative(tab, &self.panes, cx))
        } else {
            panes::pane_activity_state(pane)
        };
        Some(DragItem {
            pane: tab.active,
            window: self.id,
            whole,
            label: DragLabel::new(pane.title.clone(), pane.mark, status),
        })
    }
    fn detach(&mut self, whole: bool, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.selected_item(whole, cx) {
            self.detach_item(&item, None, w, cx)
        }
    }
    fn detach_tab(&mut self, tab_id: Id, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(item) = self.tab_drag_item(tab_id, cx) {
            self.detach_item(&item, None, w, cx);
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
    fn restart_local_pane(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        let Some(old) = self.panes.get(&id).cloned() else {
            return;
        };
        match old.update(cx, |p, cx| p.restarted_local(w, cx)) {
            Ok(pane) => {
                self.watch(id, &pane, w, cx);
                self.panes.insert(id, pane);
                self.select(id, w, cx);
            }
            Err(e) => {
                self.message = e.to_string();
                cx.notify();
            }
        }
    }
    fn reload_pane(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        if pane.read(cx).server.is_some() {
            pane.read(cx).command("reconnect", json!({}));
            if self
                .tabs
                .get(self.current)
                .is_some_and(|t| t.layout.contains(id))
            {
                self.show(Page::Terminal, w, cx);
            } else {
                cx.notify();
            }
            return;
        }
        confirm(
            "Restart this local terminal?",
            "Restarting ends the current shell and discards its draft.",
            w,
            cx,
            move |s, w, cx| s.restart_local_pane(id, w, cx),
        );
    }
    fn reload_selected(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.tabs.get(self.current).map(|t| t.active) {
            self.reload_pane(id, w, cx);
        }
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
        if self.find_pane == Some(id) {
            self.find_pane = None;
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
                let removed_tab = self.tabs.remove(i).id;
                if self.tab_menu.is_some_and(|(t, _)| t == removed_tab) {
                    self.tab_menu = None;
                }
                if self.tab_rename == Some(removed_tab) {
                    self.tab_rename = None;
                }
                if self.hovered_tab == Some(removed_tab) {
                    self.hovered_tab = None;
                }
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
                if self.page == Page::Create {
                    if !items(&self.accounts["accounts"]).iter().any(|a| {
                        a["origin"] == self.origin
                            && a["account"]["id"] == self.account_id
                            && a["canCreate"] == true
                    }) {
                        self.creating = false;
                        self.show(Page::Home, w, cx);
                        self.message = "Choose a signed-in account to create a session.".into();
                    } else {
                        self.sync_server_select(cx);
                    }
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
                self.message = error_message;
                if self.page == Page::Create {
                    self.sync_machine_select(cx);
                    self.sync_tool_select(cx);
                }
            }
            "targets" if self.origin == e["origin"] && self.account_id == e["accountId"] => {
                self.targets = e["targets"].clone();
                let first = items(&self.targets)
                    .first()
                    .map(|t| strval(t, "id"))
                    .filter(|id| !id.is_empty());
                if self.target.is_empty()
                    && let Some(id) = first
                {
                    self.select_target(id, cx);
                } else {
                    self.sync_machine_select(cx);
                }
            }
            "options"
                if self.origin == e["origin"]
                    && self.account_id == e["accountId"]
                    && self.target == e["target"] =>
            {
                let tools: Vec<&str> = items(&e["tools"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                if self.tool.is_empty() || !tools.contains(&self.tool.as_str()) {
                    self.tool = tools.first().copied().unwrap_or("").into();
                }
                self.options = e;
                self.sync_tool_select(cx);
            }
            "directories" => {
                self.handle_directory_suggestions(e);
                return;
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
                                let conn_kind = state["kind"].as_str().unwrap_or("");
                                p.connection = match conn_kind {
                                    "connected" => ConnectionState::Connected,
                                    "reconnecting" => ConnectionState::Reconnecting,
                                    "closed" => ConnectionState::Closed,
                                    _ => ConnectionState::Connecting,
                                };
                                p.restoring = p.connection != ConnectionState::Connected;
                                if p.connection == ConnectionState::Connected {
                                    p.grid_visible = true;
                                    p.command("files", json!({}));
                                    p.status.clear();
                                } else {
                                    p.activity.clear();
                                    p.activity_detail = None;
                                    p.status = state["message"]
                                        .as_str()
                                        .filter(|m| !m.is_empty())
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| match p.connection {
                                            ConnectionState::Connecting => "Connecting…".into(),
                                            ConnectionState::Reconnecting => "Reconnecting…".into(),
                                            ConnectionState::Closed => "Disconnected".into(),
                                            ConnectionState::Connected => String::new(),
                                        });
                                }
                            }
                            "session" => {
                                p.title = strval(&e, "title");
                                p.mark = AgentMark::get(e["tool"].as_str());
                            }
                            "deliveries" => p.waiting = e["waiting"].as_u64().unwrap_or(0),
                            "activity" => {
                                p.activity = strval(&e["activity"], "state");
                                p.activity_detail = e["activity"]["detail"]
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned);
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
        self.switch_create_server(origin, account_id, cx);
        self.show(Page::Create, w, cx)
    }
    fn select_target(&mut self, id: String, cx: &mut Context<Self>) {
        self.target = id.clone();
        self.options = Value::Null;
        self.tool.clear();
        self.message.clear();
        self.create
            .cancel_directory_lookups(self.target.is_empty(), cx);
        self.sync_machine_select(cx);
        self.sync_tool_select(cx);
        self.call(json!({"op":"options","origin":self.origin,"accountId":self.account_id,"target":id}));
    }
    fn creation_ready(&self) -> bool {
        !self.creating
            && self.options.is_object()
            && !self.tool.is_empty()
            && items(&self.options["missing"]).is_empty()
    }
    fn submit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        match self.page {
            Page::Home => {
                self.call(json!({"op":"login","origin":self.address.read(cx).value().trim()}))
            }
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
            Page::Create => self.submit_create(cx),
            Page::Switch | Page::Choose => {
                let index = self.picker_index;
                self.activate_picker_item(index, w, cx);
            }
            _ => {}
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
    fn any_popup_open(&self) -> bool {
        self.new_tab_menu_open
            || self.bar_menu_open
            || self.pane_menu.is_some()
            || self.context_menu.is_some()
            || self.tab_menu.is_some()
            || self.tab_rename.is_some()
            || self.files_menu.is_some()
            || self.preview_id.is_some()
    }
    fn restore_focus(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Terminal && self.find_open && !self.any_popup_open() {
            self.find_query.read(cx).focus_handle(cx).focus(w, cx);
        } else if self.page == Page::Terminal
            && !self.any_popup_open()
            && let Some(p) = self.active()
        {
            p.update(cx, |p, cx| p.focus_terminal(w, cx));
        } else {
            self.focus.focus(w, cx);
        }
    }
    fn cycle_tab(&mut self, delta: isize, w: &mut Window, cx: &mut Context<Self>) {
        let n = self.tabs.len();
        if n == 0 {
            return;
        }
        let next = (self.current as isize + delta).rem_euclid(n as isize) as usize;
        self.select(self.tabs[next].active, w, cx);
    }
    fn select_tab_index(&mut self, one_based: usize, w: &mut Window, cx: &mut Context<Self>) {
        let target = if one_based == 9 {
            self.tabs.last()
        } else {
            one_based.checked_sub(1).and_then(|i| self.tabs.get(i))
        };
        if let Some(t) = target {
            self.select(t.active, w, cx);
        }
    }
    fn move_tab_by_id(&mut self, tab_id: Id, delta: isize, cx: &mut Context<Self>) {
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
    fn move_tab(&mut self, delta: isize, cx: &mut Context<Self>) {
        if let Some(id) = self.tabs.get(self.current).map(|t| t.id) {
            self.move_tab_by_id(id, delta, cx);
        }
    }
    fn focus_pane_delta(&mut self, delta: isize, w: &mut Window, cx: &mut Context<Self>) {
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
    fn adjust_font_size(&mut self, delta: Option<f32>, cx: &mut Context<Self>) {
        let next = match delta {
            Some(d) => ((self.fontsize() + d) * 2.0).round() / 2.0,
            None => settings::DEFAULT_FONT_SIZE,
        }
        .clamp(settings::MIN_FONT_SIZE, settings::MAX_FONT_SIZE);
        self.prefs["fontSize"] = json!(next);
        self.settings(cx);
        self.show_toast(None, format!("Text size: {next:.1} px"), false, cx);
    }
    fn open_sessions(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.split_at = None;
        if items(&self.accounts["accounts"]).is_empty() {
            self.show(Page::Home, w, cx);
        } else {
            self.catalogue(w, cx);
        }
    }
    fn close_focused_pane(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.page, Page::Terminal | Page::Compose)
            && let Some(t) = self.tabs.get(self.current)
        {
            self.close(t.active, w, cx);
        }
    }
    fn close_current_tab(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.page, Page::Terminal | Page::Compose)
            && let Some(t) = self.tabs.get(self.current)
        {
            self.close_tab(t.active, w, cx);
        }
    }
    fn close_current_window(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.request_window_close(w, cx) {
            w.remove_window();
        }
    }
    fn shortcuts(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        if self.tab_menu.is_some() {
            if e.keystroke.key == "escape" && !e.keystroke.modifiers.modified() {
                self.tab_menu = None;
                self.restore_focus(w, cx);
                cx.notify();
                w.prevent_default();
                cx.stop_propagation();
            }
            return;
        }
        if self.new_tab_menu_open
            || self.bar_menu_open
            || self.pane_menu.is_some()
            || self.context_menu.is_some()
            || self.file_key(e, w, cx)
        {
            return;
        }
        if self.tab_rename.is_some() {
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
        let find_active = self.find_open && self.page == Page::Terminal;
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
            && !self.find_query.read(cx).committed_value().is_empty()
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
            self.focus_pane_delta(if matches!(key, "right" | "down") { 1 } else { -1 }, w, cx);
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
    fn set_new_tab_menu(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.new_tab_menu_open != open {
            self.new_tab_menu_open = open;
            if open {
                self.bar_menu_open = false;
                self.pane_menu = None;
                self.context_menu = None;
                self.tab_menu = None;
                self.files_menu = None;
            }
            cx.notify();
        }
    }
    fn set_bar_menu(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.bar_menu_open != open {
            self.bar_menu_open = open;
            if open {
                self.new_tab_menu_open = false;
                self.pane_menu = None;
                self.context_menu = None;
                self.tab_menu = None;
                self.files_menu = None;
            }
            cx.notify();
        }
    }
    fn scroll_tab_strip(
        &mut self,
        direction: f32,
        fallback_max_x: f32,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let strip_w = f32::from(self.drag.strip.bounds().size.width);
        let step = (strip_w * 0.72).clamp(TAB_MIN_W + 12., 260.);
        let measured_max = f32::from(self.drag.strip.max_offset().x);
        let max_x = if measured_max > 0.5 {
            measured_max
        } else {
            fallback_max_x
        };
        if max_x <= 0.5 {
            self.strip_scroll_anim = None;
            self.drag.strip.set_offset(Point::default());
            cx.notify();
            return;
        }
        let current_x = f32::from(self.drag.strip.offset().x);
        let base_x = self
            .strip_scroll_anim
            .map_or(current_x, |(_, _, target_x)| target_x);
        let target_x = (base_x + direction * step).clamp(-max_x, 0.);
        if (target_x - current_x).abs() < 0.5 {
            self.strip_scroll_anim = None;
            self.drag.strip.set_offset(point(px(target_x), px(0.)));
            cx.notify();
            return;
        }
        self.strip_scroll_anim = Some((std::time::Instant::now(), current_x, target_x));
        self.step_strip_scroll(w, cx);
    }
    fn step_strip_scroll(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some((start, from_x, to_x)) = self.strip_scroll_anim else {
            return;
        };
        const DURATION_SECS: f32 = 0.14;
        let t = (start.elapsed().as_secs_f32() / DURATION_SECS).clamp(0., 1.);
        let eased = 1. - (1. - t).powi(3);
        let next_x = from_x + (to_x - from_x) * eased;
        let max_x = f32::from(self.drag.strip.max_offset().x);
        let clamped_x = if max_x > 0.5 {
            next_x.clamp(-max_x, 0.)
        } else {
            next_x.min(0.)
        };
        self.drag.strip.set_offset(point(px(clamped_x), px(0.)));
        cx.notify();
        if t >= 1. {
            self.strip_scroll_anim = None;
            return;
        }
        let weak = cx.weak_entity();
        w.on_next_frame(move |w, cx| {
            let _ = weak.update(cx, |s, cx| s.step_strip_scroll(w, cx));
        });
    }
    fn bar_overflow_menu(
        &self,
        compact_bar: bool,
        overflowing: bool,
        cx: &Context<Self>,
    ) -> impl IntoElement + use<> {
        let open = self.bar_menu_open;
        let toggle = || cx.listener(move |s, _: &MouseDownEvent, _, cx| s.set_bar_menu(!open, cx));
        let tooltip = if compact_bar {
            "Open tabs and actions"
        } else {
            "All open tabs"
        };
        let trigger = div()
            .on_mouse_down(MouseButton::Left, toggle())
            .child(
                gpui::components::Button::icon("bar-overflow", LucideIcon::ChevronDown)
                    .ghost()
                    .size(ComponentSize::Sm)
                    .w(px(26.))
                    .h(px(30.))
                    .text_color(if open {
                        rgba(0xf0f0f0ff)
                    } else {
                        rgba(0xffffffa6)
                    })
                    .hover_bg(rgba(0xffffff18).into())
                    .when(open, |button| button.bg(rgba(0xffffff18)))
                    .when(!open, move |button| button.tooltip_text(tooltip))
                    .on_click(cx.listener(move |s, e: &ClickEvent, _, cx| {
                        if !matches!(e, ClickEvent::Mouse(_)) {
                            s.set_bar_menu(!open, cx);
                        }
                    })),
            );
        let mut menu = dropdown_menu("bar-overflow-menu", open)
            .trigger(trigger)
            .min_width(px(230.))
            .max_width(px(300.))
            .max_height(px(360.))
            .on_close(cx.listener(|s, _, _, cx| s.set_bar_menu(false, cx)));
        let show_tabs = !self.tabs.is_empty() && (overflowing || compact_bar);
        if show_tabs {
            menu = menu.entry(MenuEntry::Label(
                format!("Open tabs ({})", self.tabs.len()).into(),
            ));
            let active_tab_idx = (self.page == Page::Terminal).then_some(self.current);
            for (i, tab) in self.tabs.iter().enumerate() {
                let id = tab.active;
                let title = if tab.name.is_empty() {
                    self.panes[&id].read(cx).title.clone()
                } else {
                    tab.name.clone()
                };
                menu = menu.entry(MenuEntry::checkbox_item(
                    title,
                    active_tab_idx == Some(i),
                    cx.listener(move |s, _, w, cx| s.select(id, w, cx)),
                ));
            }
        }
        if compact_bar {
            if show_tabs {
                menu = menu.entry(MenuEntry::Separator);
            }
            let (switch_sc, split_r_sc, split_d_sc, settings_sc) = if cfg!(target_os = "macos") {
                ("⌘P", "⌘D", "⇧⌘D", "⌘,")
            } else {
                ("Ctrl+Shift+P", "Ctrl+Shift+D", "Ctrl+Alt+D", "Ctrl+,")
            };
            menu = menu.entry(
                MenuEntry::item_with_icon(
                    "Switch session…",
                    LucideIcon::Search,
                    cx.listener(|s, _, w, cx| s.show(Page::Switch, w, cx)),
                )
                .with_shortcut(switch_sc),
            );
            if self.page == Page::Terminal {
                menu = menu
                    .entry(
                        MenuEntry::item_with_icon(
                            "Split right",
                            LucideIcon::Columns2,
                            cx.listener(|s, _, w, cx| s.split(Axis::Across, w, cx)),
                        )
                        .with_shortcut(split_r_sc),
                    )
                    .entry(
                        MenuEntry::item_with_icon(
                            "Split down",
                            LucideIcon::Rows2,
                            cx.listener(|s, _, w, cx| s.split(Axis::Down, w, cx)),
                        )
                        .with_shortcut(split_d_sc),
                    );
            }
            menu = menu.entry(
                MenuEntry::item_with_icon(
                    "Settings",
                    LucideIcon::Settings,
                    cx.listener(|s, _, w, cx| s.show(Page::Settings, w, cx)),
                )
                .with_shortcut(settings_sc),
            );
        }
        menu
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
                    .text_color(if open {
                        rgba(0xf0f0f0ff)
                    } else {
                        rgba(0xffffffa6)
                    })
                    .hover_bg(rgba(0xffffff18).into())
                    .when(open, |button| button.bg(rgba(0xffffff18)))
                    .when(!open, |button| {
                        button.tooltip_text(if cfg!(target_os = "macos") {
                            "New terminal (⌘T)"
                        } else {
                            "New terminal (Ctrl+Shift+T)"
                        })
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
            menu.entry(
                MenuEntry::item_with_icon(
                    "Outpost session…",
                    LucideIcon::Server,
                    cx.listener(|s, _, w, cx| {
                        s.split_at = None;
                        s.catalogue(w, cx)
                    }),
                )
                .with_shortcut(if cfg!(target_os = "macos") {
                    "⇧⌘O"
                } else {
                    "Ctrl+Shift+O"
                }),
            )
        }
    }
    fn chrome(&self, w: &Window, cx: &mut Context<Self>) -> Div {
        let slots = self.strip_slots();
        let active_tab_idx = (self.page == Page::Terminal).then_some(self.current);
        let active_tab_id = active_tab_idx
            .and_then(|idx| self.tabs.get(idx))
            .map(|t| t.id);
        let hairline = rgba(0xffffff1a);
        let layout = compute_chrome_layout(
            f32::from(w.viewport_size().width),
            slots.len(),
            cfg!(target_os = "macos"),
            cfg!(windows),
        );
        if !layout.overflowing && f32::from(self.drag.strip.offset().x) != 0. {
            self.drag.strip.set_offset(Point::default());
        }
        let offset_x = f32::from(self.drag.strip.offset().x);
        let measured_max_x = f32::from(self.drag.strip.max_offset().x);
        let max_scroll_x = if measured_max_x > 0.5 {
            measured_max_x
        } else {
            layout.est_max_scroll_x
        };
        let can_scroll_left = layout.overflowing && offset_x < -0.5;
        let can_scroll_right = layout.overflowing && offset_x > -(max_scroll_x - 0.5);
        let mut strip = row()
            .size_full()
            .items_end()
            .gap(px(TAB_GAP))
            .id("tabs")
            .hide_scrollbar()
            .track_scroll(&self.drag.strip)
            .overflow_x_scroll();
        for (pos, &slot) in slots.iter().enumerate() {
            let Some(i) = slot else {
                let preview = self.drag.preview.as_ref().expect("preview slot");
                strip = strip.child(
                    row()
                        .h(px(36.))
                        .pb(px(1.))
                        .min_w(px(TAB_MIN_W))
                        .w(px(TAB_IDEAL_W))
                        .max_w(px(TAB_MAX_W))
                        .pl(px(8.))
                        .pr(px(29.))
                        .items_center()
                        .rounded_t(px(7.))
                        .bg(rgb(0x151515))
                        .border_t_1()
                        .border_l_1()
                        .border_r_1()
                        .border_color(rgba(0xffffff38))
                        .text_color(rgb(0xf0f0f0))
                        .font_weight(FontWeight::MEDIUM)
                        .child(preview.label.tab_content()),
                );
                continue;
            };
            let tab = &self.tabs[i];
            let tab_id = tab.id;
            let id = tab.active;
            let active = active_tab_idx == Some(i);
            let hovered = !active && self.hovered_tab == Some(tab_id);
            let next_tab_id = slots
                .get(pos + 1)
                .and_then(|next| *next)
                .map(|next_i| self.tabs[next_i].id);
            let show_divider =
                show_tab_divider(tab_id, next_tab_id, active_tab_id, self.hovered_tab);
            let title = if tab.name.is_empty() {
                self.panes[&id].read(cx).title.clone()
            } else {
                tab.name.clone()
            };
            let rep = panes::tab_representative(tab, &self.panes, cx);
            let status_tip = panes::pane_status_label(rep);
            let tab_status =
                panes::status_badge_with_emphasis(rep, px(16.), active).map(|badge| {
                    div()
                        .id(("tab-status", tab.id))
                        .flex_none()
                        .tooltip(move |w, cx| Tooltip::text(status_tip.clone(), w, cx))
                        .child(badge)
                });
            let tab_tip = title.clone();
            let handle = row()
                .id(("tab-handle", tab.id))
                .role(gpui::accesskit::Role::Tab)
                .aria_selected(active)
                .focusable()
                .tab_stop(i == self.current)
                .tooltip(move |w, cx| Tooltip::text(tab_tip.clone(), w, cx))
                .on_click(cx.listener(move |s, e: &ClickEvent, w, cx| {
                    if !matches!(e, ClickEvent::Mouse(_)) {
                        s.select(id, w, cx);
                    }
                }))
                .flex_1()
                .min_w_0()
                .h_full()
                .pl(px(8.))
                .gap(px(5.))
                .cursor_pointer()
                .aria_label(format!("Select or drag tab {title}"))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, e: &MouseDownEvent, w, cx| {
                        w.prevent_default();
                        s.strip_scroll_anim = None;
                        if e.click_count == 2 {
                            s.cancel_drag(cx);
                            s.open_tab_rename(tab_id, w, cx);
                        } else {
                            s.arm(id, true, e.position, w, cx);
                        }
                    }),
                )
                .children(tab_status)
                .children(self.panes[&id].read(cx).mark.map(|m| m.icon(14.)))
                .child(div().flex_1().min_w_0().truncate().child(title.clone()))
                .when(!matches!(tab.layout, Layout::Pane(_)), |e| {
                    e.child(text(
                        self.panes
                            .keys()
                            .filter(|id| tab.layout.contains(**id))
                            .count()
                            .to_string(),
                        10.,
                        if active { MUTED } else { 0x6a6a6a },
                    ))
                });
            let tab = row()
                .id(("tab", tab.id))
                .relative()
                .min_w(px(TAB_MIN_W))
                .w(px(TAB_IDEAL_W))
                .max_w(px(TAB_MAX_W))
                .pr(px(5.))
                .gap(px(2.))
                .rounded_t(px(7.))
                .border_t_1()
                .border_l_1()
                .border_r_1()
                .cursor_pointer()
                .hover_listener_mode(HoverListenerMode::InputModalityIndependent)
                .on_hover(cx.listener(move |s, &is_hovered, _, cx| {
                    if is_hovered {
                        if s.hovered_tab != Some(tab_id) {
                            s.hovered_tab = Some(tab_id);
                            cx.notify();
                        }
                    } else if s.hovered_tab == Some(tab_id) {
                        s.hovered_tab = None;
                        cx.notify();
                    }
                }))
                .when(active, |e| {
                    // Span the bottom 1px hairline with opaque BG while matching inactive content height (34px).
                    e.h(px(36.))
                        .pb(px(1.))
                        .bg(rgb(BG))
                        .border_color(rgba(0xffffff22))
                        .text_color(rgb(0xf0f0f0))
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!active, |e| {
                    // Stop cleanly above the 1px titlebar hairline so translucent hover fill/borders never double-paint it.
                    e.h(px(35.))
                        .mb(px(1.))
                        .when(hovered, |s| {
                            s.bg(rgba(0xffffff16))
                                .border_color(rgba(0xffffff10))
                                .text_color(rgba(0xffffffcc))
                        })
                        .when(!hovered, |s| {
                            s.border_color(rgba(0x00000000))
                                .text_color(rgba(0xffffff80))
                        })
                        .when(show_divider, |s| {
                            s.child(
                                div()
                                    .absolute()
                                    .right(px(-2.))
                                    .top(px(9.))
                                    .bottom(px(9.))
                                    .w(px(1.))
                                    .bg(rgba(0xffffff18)),
                            )
                        })
                })
                .child(handle)
                .child(
                    panes::header_button(
                        ("tab-close", tab.id),
                        LucideIcon::X,
                        "Close tab",
                        true,
                        cx.listener(move |s, _, w, cx| s.close_tab(id, w, cx)),
                    )
                    .size(px(22.))
                    .text_color(if active {
                        rgba(0xffffff99)
                    } else {
                        rgba(0xffffff66)
                    }),
                )
                .on_mouse_up(
                    MouseButton::Middle,
                    cx.listener(move |s, _, w, cx| s.close_tab(id, w, cx)),
                )
                .on_mouse_down(
                    MouseButton::Right,
                    cx.listener(move |s, e: &MouseDownEvent, w, cx| {
                        w.prevent_default();
                        cx.stop_propagation();
                        s.open_tab_menu(tab_id, e.position, cx);
                    }),
                );
            strip = strip.child(tab)
        }
        let scroll_btn = |id: &'static str,
                          glyph: LucideIcon,
                          tip: &'static str,
                          enabled: bool,
                          direction: f32| {
            let fallback_max = layout.est_max_scroll_x;
            div()
                .id(id)
                .role(gpui::accesskit::Role::Button)
                .aria_label(tip)
                .w(px(24.))
                .h(px(30.))
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .text_color(if enabled {
                    rgba(0xffffffa6)
                } else {
                    rgba(0xffffff3d)
                })
                .when(enabled, |e| {
                    e.cursor_pointer()
                        .hover(|s| s.bg(rgba(0xffffff18)).text_color(rgb(0xf0f0f0)))
                        .tooltip(move |w, cx| Tooltip::text(tip, w, cx))
                        .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
                        .on_click(cx.listener(move |s, _, w, cx| {
                            s.scroll_tab_strip(direction, fallback_max, w, cx)
                        }))
                })
                .child(lucide_icon(glyph).size(px(14.)))
        };
        let strip_region = div()
            .relative()
            .flex_shrink_1()
            .min_w_0()
            .h_full()
            .overflow_hidden()
            .child(strip)
            .when(can_scroll_left, |e| {
                e.child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom(px(1.))
                        .w(px(18.))
                        .bg(linear_gradient(
                            90.,
                            linear_color_stop(rgba(0x1b1b1cc8), 0.),
                            linear_color_stop(rgba(0x1b1b1c00), 1.),
                        )),
                )
            })
            .when(can_scroll_right, |e| {
                e.child(
                    div()
                        .absolute()
                        .right_0()
                        .top_0()
                        .bottom(px(1.))
                        .w(px(18.))
                        .bg(linear_gradient(
                            270.,
                            linear_color_stop(rgba(0x1b1b1cc8), 0.),
                            linear_color_stop(rgba(0x1b1b1c00), 1.),
                        )),
                )
            });
        let tab_cluster = row()
            .h_full()
            .flex_shrink_1()
            .min_w_0()
            .gap(px(2.))
            .when(layout.overflowing, |e| {
                e.child(scroll_btn(
                    "tabs-scroll-left",
                    LucideIcon::ChevronLeft,
                    "Scroll tabs left",
                    can_scroll_left,
                    1.,
                ))
            })
            .child(strip_region)
            .when(layout.overflowing, |e| {
                e.child(scroll_btn(
                    "tabs-scroll-right",
                    LucideIcon::ChevronRight,
                    "Scroll tabs right",
                    can_scroll_right,
                    -1.,
                ))
            });
        let tab_actions = row()
            .flex_none()
            .gap(px(2.))
            .child(self.new_tab_menu(cx))
            .when(layout.show_overflow_menu, |e| {
                e.child(self.bar_overflow_menu(layout.compact_bar, layout.overflowing, cx))
            });
        let window_active = w.is_window_active();
        let glass_tint = if window_active {
            rgba(0x1b1b1ba3)
        } else {
            rgba(0x1b1b1bc4)
        };
        row()
            .relative()
            .w_full()
            .h(px(40.))
            .flex_none()
            .px(px(8.))
            .when(cfg!(target_os = "macos"), |e| e.pl(px(78.)))
            .gap(px(4.))
            .bg(glass_tint)
            // Drawn behind the tab strip so the solid active tab seamlessly covers it.
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(px(1.))
                    .bg(hairline),
            )
            .child(
                div()
                    .id("home")
                    .size(px(30.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(5.))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgba(0xffffff16)))
                    .child(img(self.logo.clone()).size(px(20.)))
                    .on_click(cx.listener(|s, _, w, cx| {
                        s.split_at = None;
                        s.show(Page::Home, w, cx)
                    })),
            )
            .when(!self.startup_cloak, |bar| {
                bar.child(tab_cluster).child(tab_actions)
            })
            .child(snapshot_source(
                &self.drag.empty_bar,
                div()
                    .id("window-drag-area")
                    .flex_1()
                    .min_w(px(layout.drag_min))
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
            .when(!self.startup_cloak && !layout.compact_bar, |bar| {
                let mac = cfg!(target_os = "macos");
                let switch_tip = if mac {
                    "Switch session (⌘P)"
                } else {
                    "Switch session (Ctrl+Shift+P)"
                };
                let split_tip = if mac {
                    "Split side by side (⌘D) · Right-click to split down"
                } else {
                    "Split side by side (Ctrl+Shift+D) · Right-click to split down"
                };
                let settings_tip = if mac {
                    "Settings (⌘,)"
                } else {
                    "Settings (Ctrl+,)"
                };
                bar.child(
                    icon("switch", LucideIcon::Search, cx, |s, w, cx| {
                        s.show(Page::Switch, w, cx)
                    })
                    .tooltip(move |w, cx| Tooltip::text(switch_tip, w, cx)),
                )
                .child(if self.page == Page::Terminal {
                    icon("split", LucideIcon::Columns2, cx, |s, w, cx| {
                        s.split(Axis::Across, w, cx)
                    })
                    .tooltip(move |w, cx| Tooltip::text(split_tip, w, cx))
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
                        .text_color(rgba(0xffffffa6))
                        .opacity(0.35)
                        .child(lucide_icon(LucideIcon::Columns2).size(px(17.)))
                        .into_any_element()
                })
                .child(
                    icon("settings", LucideIcon::Settings, cx, |s, w, cx| {
                        s.show(Page::Settings, w, cx)
                    })
                    .tooltip(move |w, cx| Tooltip::text(settings_tip, w, cx)),
                )
            })
            .when(cfg!(windows), |bar| {
                // Win32 handles clicks, Snap Layouts, and the normal close request through these hitboxes.
                let caption_fg = if window_active {
                    rgba(0xffffffa6)
                } else {
                    rgba(0xffffff66)
                };
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
                        .text_color(caption_fg)
                        .hover(move |s| {
                            if area == WindowControlArea::Close {
                                s.bg(rgb(0xc42b1c)).text_color(rgb(0xffffff))
                            } else {
                                s.bg(rgba(0xffffff18)).text_color(rgb(0xf0f0f0))
                            }
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
    fn pane_status_overlay(
        &self,
        id: Id,
        pane: &Pane,
        cx: &Context<Self>,
    ) -> Option<AnyElement> {
        if pane.status.is_empty() {
            return None;
        }
        let remote = pane.server.is_some();
        let pending = remote
            && matches!(
                pane.connection,
                ConnectionState::Connecting | ConnectionState::Reconnecting
            );
        let icon = if pending {
            activity_badge(ActivityState::Pending)
                .size(px(17.))
                .color(rgb(0x9a9a9a))
                .into_any_element()
        } else {
            lucide_icon(if remote {
                LucideIcon::WifiOff
            } else {
                LucideIcon::CircleX
            })
            .size(px(17.))
            .text_color(rgb(0xf87171))
            .into_any_element()
        };
        let mut actions = row().items_center().justify_center().gap(px(8.));
        if remote {
            actions = actions.child(
                button(
                    ("pane-reconnect", id),
                    !pending,
                    cx,
                    move |s, _, cx| {
                        if let Some(pane) = s.panes.get(&id) {
                            pane.read(cx).command("reconnect", json!({}))
                        }
                    },
                )
                .child(
                    row()
                        .gap(px(6.))
                        .child(lucide_icon(LucideIcon::RotateCw).size(px(13.5)))
                        .child("Reconnect"),
                ),
            );
            if !pending {
                actions = actions.child(
                    button(("pane-status-close", id), false, cx, move |s, w, cx| {
                        s.close(id, w, cx)
                    })
                    .child("Close"),
                );
            }
        } else {
            actions = actions
                .child(
                    button(
                        ("pane-restart", id),
                        true,
                        cx,
                        move |s, w, cx| s.restart_local_pane(id, w, cx),
                    )
                    .child(
                        row()
                            .gap(px(6.))
                            .child(lucide_icon(LucideIcon::RotateCw).size(px(13.5)))
                            .child("Restart"),
                    ),
                )
                .child(
                    button(("pane-status-close", id), false, cx, move |s, w, cx| {
                        s.close(id, w, cx)
                    })
                    .child("Close"),
                );
        }
        Some(
            div()
                .id(("pane-status-overlay", id))
                .absolute()
                .inset_0()
                .occlude()
                .backdrop_blur(px(6.))
                .bg(rgba(0x0c0c0c96))
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .px(px(24.))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| {
                        if s.tabs.get(s.current).is_some_and(|t| t.active != id) {
                            s.select(id, w, cx);
                        }
                    }),
                )
                .child(
                    col()
                        .items_center()
                        .gap(px(14.))
                        .max_w(px(420.))
                        .child(
                            row()
                                .items_center()
                                .justify_center()
                                .gap(px(8.))
                                .child(div().flex_none().child(icon))
                                .child(
                                    div()
                                        .min_w_0()
                                        .text_center()
                                        .text_size(px(14.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(rgb(if pending { 0xd4d4d4 } else { 0xf0f0f0 }))
                                        .child(pane.status.clone()),
                                ),
                        )
                        .child(actions),
                )
                .into_any_element(),
        )
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
                let status = self.pane_status_overlay(id, pane, cx);
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
                let find_bar = active.then(|| self.find_overlay(id, pane, cx)).flatten();
                let badge_top = if find_bar.is_some() { px(50.) } else { px(6.) };
                let surface = col()
                    .relative()
                    .pt(px(5.))
                    .pb(px(5.))
                    .pl(px(5.))
                    .flex_1()
                    .overflow_hidden()
                    .child(p)
                    .when(!active, |e| {
                        e.child(div().absolute().inset_0().bg(rgba(0x00000052)))
                    })
                    .children(status)
                    .children(
                        badge.map(|badge| {
                            div().absolute().top(badge_top).right(px(16.)).child(badge)
                        }),
                    )
                    .children(find_bar);
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
                content = content.child(self.create_view(cx));
            }
            Page::Compose => {}
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
        if self.find_open && self.page == Page::Terminal {
            if let Some(p) = self.active() {
                p.update(cx, |p, _| {
                    p.refresh_search_if_dirty();
                });
            } else {
                self.find_open = false;
                self.find_pane = None;
            }
        }
        self.drag.rendered_tabs = self
            .strip_slots()
            .into_iter()
            .map(|slot| slot.map(|i| self.tabs[i].id))
            .collect();
        let body = if self.startup_cloak {
            self.startup_cloak_view()
        } else if matches!(
            self.page,
            Page::Terminal | Page::Compose | Page::Choose | Page::Switch
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
            .text_color(rgb(TEXT))
            .text_size(px(13.))
            .child(self.chrome(w, cx))
            .child(
                col()
                    .relative()
                    .flex_1()
                    .overflow_hidden()
                    .bg(rgb(BG))
                    .child(body)
                    .children(self.picker_overlay(cx)),
            )
            .child(self.context_menu_overlay(cx))
            .child(self.tab_context_menu_overlay(cx))
            .children(self.tab_rename_overlay(cx))
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
                        .bg(rgb(BG))
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
            .on_action(cx.listener(|s, _: &crate::menu::OpenSessions, w, cx| {
                s.open_sessions(w, cx)
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SwitchSession, w, cx| {
                s.show(Page::Switch, w, cx)
            }))
            .on_action(
                cx.listener(|s, _: &crate::menu::Settings, w, cx| s.show(Page::Settings, w, cx)),
            )
            .on_action(cx.listener(|s, _: &crate::menu::CloseTerminal, w, cx| {
                s.close_focused_pane(w, cx)
            }))
            .on_action(cx.listener(|s, _: &crate::menu::CloseTab, w, cx| {
                s.close_current_tab(w, cx)
            }))
            .on_action(cx.listener(|s, _: &crate::menu::CloseWindow, w, cx| {
                s.close_current_window(w, cx)
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
                    s.open_find(w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ComposeMessage, w, cx| {
                if s.active().is_some() {
                    s.show(Page::Compose, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ClearScreen, _, cx| {
                if s.page == Page::Terminal
                    && let Some(p) = s.active()
                {
                    p.update(cx, |p, cx| p.clear_screen(true, cx));
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SplitColumns, w, cx| {
                if s.page == Page::Terminal && !s.tabs.is_empty() {
                    s.split(Axis::Across, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SplitRows, w, cx| {
                if s.page == Page::Terminal && !s.tabs.is_empty() {
                    s.split(Axis::Down, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ToggleZoom, w, cx| {
                if s.page == Page::Terminal
                    && let Some(t) = s.tabs.get(s.current)
                {
                    s.toggle_zoom(t.active, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::FocusNextPane, w, cx| {
                if s.page == Page::Terminal {
                    s.focus_pane_delta(1, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::FocusPrevPane, w, cx| {
                if s.page == Page::Terminal {
                    s.focus_pane_delta(-1, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::IncreaseFontSize, _, cx| {
                s.adjust_font_size(Some(1.0), cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::DecreaseFontSize, _, cx| {
                s.adjust_font_size(Some(-1.0), cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ResetFontSize, _, cx| {
                s.adjust_font_size(None, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::ReloadTerminal, w, cx| {
                if matches!(s.page, Page::Terminal | Page::Compose)
                    && !s.tabs.is_empty()
                {
                    s.reload_selected(w, cx);
                }
            }))
            .on_action(cx.listener(|_, _: &crate::menu::ToggleFullscreen, w, _| {
                w.toggle_fullscreen();
            }))
            .on_action(cx.listener(|s, _: &crate::menu::NextTab, w, cx| {
                s.cycle_tab(1, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::PrevTab, w, cx| {
                s.cycle_tab(-1, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::MoveTabLeft, _, cx| {
                s.move_tab(-1, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::MoveTabRight, _, cx| {
                s.move_tab(1, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab1, w, cx| {
                s.select_tab_index(1, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab2, w, cx| {
                s.select_tab_index(2, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab3, w, cx| {
                s.select_tab_index(3, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab4, w, cx| {
                s.select_tab_index(4, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab5, w, cx| {
                s.select_tab_index(5, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab6, w, cx| {
                s.select_tab_index(6, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab7, w, cx| {
                s.select_tab_index(7, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab8, w, cx| {
                s.select_tab_index(8, w, cx);
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SelectTab9, w, cx| {
                s.select_tab_index(9, w, cx);
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
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                let origin = "https://outpost.ke.wang";
                s.accounts = json!({
                    "accounts": [{
                        "origin": origin,
                        "account": {"id": "acct-1"},
                        "canCreate": true
                    }]
                });
                s.create_form(origin.into(), "acct-1".into(), w, cx);
                s.event(
                    json!({
                        "event": "targets",
                        "origin": origin,
                        "accountId": "acct-1",
                        "targets": [
                            {"id": "m1", "name": "gpui-enhancement"},
                            {"id": "m2", "name": "linux-build-box"}
                        ]
                    }),
                    w,
                    cx,
                );
                s.event(
                    json!({
                        "event": "options",
                        "origin": origin,
                        "accountId": "acct-1",
                        "target": "m1",
                        "tools": ["claude", "codex"],
                        "missing": []
                    }),
                    w,
                    cx,
                );
            });
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("create-session.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.create.open_tool_menu(w, cx));
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("create-session-open.png"))?;
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
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let origin = "https://example.com";
            s.create_form(origin.into(), "first".into(), w, cx);
            assert_eq!(commands.try_recv().unwrap()["accountId"], "first");
            // Receiving targets auto-selects the first machine and probes its coding tools.
            s.event(
                json!({
                    "event":"targets",
                    "origin":origin,
                    "accountId":"first",
                    "targets":[{"id":"machine","name":"dev-box"},{"id":"other","name":"gpu-box"}]
                }),
                w,
                cx,
            );
            assert_eq!(s.target, "machine");
            let probe = commands.try_recv().unwrap();
            assert_eq!(probe["op"], "options");
            assert_eq!(probe["target"], "machine");
            s.name.update(cx, |name, cx| name.set_value_silent("Review", cx));
            s.create.set_directory_silent("/work", cx);
            // Remote directory suggestions round-trip through PathInputState.
            s.create.open_directory_suggestions(cx);
            let mut options = json!({"event":"options","origin":origin,"accountId":"first","target":"machine","tools":["codex","claude"],"missing":["bash"]});
            s.event(options.clone(), w, cx);
            s.submit(w, cx);
            assert!(!s.creation_ready());
            assert!(commands.try_recv().is_err());
            // Core software ready, but no coding tools installed yet.
            s.event(json!({"event":"options","origin":origin,"accountId":"first","target":"machine","tools":[],"missing":[]}), w, cx);
            assert!(!s.creation_ready());
            options["missing"] = json!([]);
            s.event(options, w, cx);
            assert!(s.creation_ready());
            assert_eq!(s.tool, "codex");
            // Switching coding tool through the searchable ComboBox updates the selected tool.
            s.create.select_tool("claude", cx);
            // Custom program args, createDirectory, and env vars are validated and submitted.
            s.create.set_create_directory(true);
            s.create.set_args_silent("--verbose --model opus", cx);
            s.create.push_env("API_MODE", "fast", cx);
            s.create.push_env("API_MODE", "dup", cx);
            s.submit(w, cx);
            assert!(s.message.contains("Duplicate"));
            assert!(!s.creating);
        });
        w.draw(cx).clear(cx);
    })?;
    test.run_until_parked();
    // Drain the debounced directory lookup command if it fired and resolve it.
    std::thread::sleep(Duration::from_millis(260));
    test.run_until_parked();
    if let Ok(dir_cmd) = commands.try_recv() {
        assert_eq!(dir_cmd["op"], "directories");
        assert_eq!(dir_cmd["target"], "machine");
        assert_eq!(dir_cmd["path"], "/work");
        let req_id = dir_cmd["id"].as_u64().unwrap();
        test.update_window(remote_window.into(), |root, w, cx| {
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                s.event(
                    json!({
                        "event": "directories",
                        "id": req_id,
                        "origin": "https://example.com",
                        "accountId": "first",
                        "target": "machine",
                        "path": "/work",
                        "directories": ["/work/outpost/", "/work/gpui/"],
                        "truncated": false
                    }),
                    w,
                    cx,
                );
            });
        })?;
        test.run_until_parked();
        test.update_window(remote_window.into(), |root, _, cx| {
            let entries = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .create
                .directory_entries(cx);
            assert_eq!(entries, vec!["/work/outpost/", "/work/gpui/"]);
        })?;
    }
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let origin = "https://example.com";
            assert_eq!(s.tool, "claude");
            // Replace duplicate env with a valid unique variable and submit.
            s.create.set_directory_silent("/work/outpost/", cx);
            s.create = CreateForm::new(cx);
            s.create.cancel_directory_lookups(false, cx);
            s.create.set_directory_silent("/work/outpost/", cx);
            s.create.set_create_directory(true);
            s.create.set_args_silent("--verbose --model opus", cx);
            s.create.push_env("API_MODE", "fast", cx);
            s.create.push_env("EXTRA_FLAG", "1", cx);
            s.submit(w, cx);
            let created = commands.try_recv().unwrap();
            assert_eq!(created["op"], "create");
            assert_eq!(created["accountId"], "first");
            assert_eq!(created["input"]["tool"], "claude");
            assert_eq!(created["input"]["rootDir"], "/work/outpost/");
            assert_eq!(created["input"]["createDirectory"], true);
            assert_eq!(created["input"]["args"], "--verbose --model opus");
            assert_eq!(created["input"]["env"]["API_MODE"], "fast");
            assert_eq!(created["input"]["env"]["EXTRA_FLAG"], "1");
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
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
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
                assert_eq!(p.active_match_text().as_deref(), Some("FIRST-RETAINED-ROW"));
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
                assert!(p.active_match_text().is_none());
                p.find("row", false, cx);
                assert_eq!(p.active_match_text().as_deref(), Some("row"));
                p.clear_search(cx);
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
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
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

            // Verify animated tab activity badge states and status labels across lifecycle events.
            let p1 = s.remote[&1];
            let p2 = s.remote[&2];
            assert_eq!(
                panes::pane_activity_state(s.panes[&p1].read(cx)),
                Some(ActivityState::Pending)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p1].read(cx)),
                "Connecting…"
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Ready)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p2].read(cx)),
                "Connected"
            );
            for (state, detail, expected, label) in [
                ("working", None, ActivityState::Working, "Connected · Working"),
                (
                    "waiting",
                    Some("Approval requested"),
                    ActivityState::Attention,
                    "Connected · Waiting for you · Approval requested",
                ),
                ("finished", None, ActivityState::Attention, "Connected · Needs you"),
                ("error", None, ActivityState::Error, "Connected · Error"),
                ("idle", None, ActivityState::Idle, "Connected · Idle"),
                ("unknown", None, ActivityState::Unknown, "Connected · Unknown"),
            ] {
                s.event(
                    json!({"event":"activity","pane":2,"activity":{"state":state,"detail":detail}}),
                    w,
                    cx,
                );
                assert_eq!(
                    panes::pane_activity_state(s.panes[&p2].read(cx)),
                    Some(expected)
                );
                assert_eq!(panes::pane_status_label(s.panes[&p2].read(cx)), label);
            }
            // Terminal bell elevates an idle pane to Attention until cleared.
            s.panes[&p2].update(cx, |p, _| p.bell = true);
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Attention)
            );
            assert!(panes::pane_status_label(s.panes[&p2].read(cx)).contains("Bell rang"));
            s.panes[&p2].update(cx, |p, _| p.bell = false);
            // Disconnecting clears stale activity metadata.
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"reconnecting","message":"Retrying"}}),
                w,
                cx,
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Pending)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p2].read(cx)),
                "Reconnecting… · Retrying"
            );
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"closed"}}),
                w,
                cx,
            );
            assert_eq!(s.panes[&p2].read(cx).status, "Disconnected");
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"closed","message":"Session ended"}}),
                w,
                cx,
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Disconnected)
            );
        });
        // Render the full-pane blurred error overlay before restoring the connection.
        w.draw(cx).clear(cx);
        ws.update(cx, |s, cx| {
            // Restore pane 2 to connected + working for the remaining workspace assertions.
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"connected"}}),
                w,
                cx,
            );
            s.event(
                json!({"event":"activity","pane":2,"activity":{"state":"working"}}),
                w,
                cx,
            );
        });
        w.draw(cx).clear(cx);
    })?;
    let lists: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter(|c| c["op"] == "files")
        .map(|c| c["pane"].as_u64().unwrap())
        .collect();
    assert_eq!(lists, [2, 1, 2]);
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
                assert_eq!(p.select_active_match(cx).as_deref(), Some("hello"));
                p.clear_search(cx);
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
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            s.dismiss_page(w, cx);
            assert!(s.page == Page::Terminal);

            // Verify iTerm2-style floating Find overlay: live search, modes, navigation, Tab selection, and Esc dismiss.
            let find_pane = s.active().unwrap();
            find_pane.update(cx, |p, cx| {
                p.reset(60, 12);
                p.feed(b"alpha beta Alpha\r\nalphabet https://example.com/path done\r\n", cx);
                p.grid_visible = true;
            });
            s.open_find(w, cx);
            assert!(s.page == Page::Terminal);
            assert!(s.find_open);
            assert!(s.find_query.read(cx).focus_handle(cx).is_focused(w));

            // Incremental live search defaults to case-insensitive and anchors on the most recent match.
            s.find_query
                .update(cx, |input, cx| input.set_value("alpha", cx));
            s.sync_find(false, cx);
            let status = find_pane.read(cx).search_status();
            assert_eq!(status.total, 3);
            assert_eq!(status.active, Some(2));
            assert_eq!(
                find_pane.update(cx, |p, _| p.active_match_text()).as_deref(),
                Some("alpha")
            );

            // Stepping next wraps 3 -> 1, stepping previous returns to 3.
            s.step_find(true, cx);
            assert_eq!(find_pane.read(cx).search_status().active, Some(0));
            s.step_find(false, cx);
            assert_eq!(find_pane.read(cx).search_status().active, Some(2));

            // Toggle Match case: excludes "Alpha" (matches only lowercase "alpha" in "alpha" and "alphabet").
            s.toggle_find_case(w, cx);
            assert!(s.find_options.case_sensitive);
            assert_eq!(find_pane.read(cx).search_status().total, 2);

            // Toggle Whole word: excludes "alphabet" (matches only standalone lowercase "alpha").
            s.toggle_find_whole_word(w, cx);
            assert!(s.find_options.whole_word);
            assert_eq!(find_pane.read(cx).search_status().total, 1);

            // Reset case & whole word, enable regex and verify both invalid and valid patterns.
            s.toggle_find_case(w, cx);
            s.toggle_find_whole_word(w, cx);
            s.toggle_find_regex(w, cx);
            assert!(s.find_options.regex);
            s.find_query
                .update(cx, |input, cx| input.set_value("[unterminated", cx));
            s.sync_find(false, cx);
            assert!(find_pane.read(cx).search_status().invalid_regex);
            assert_eq!(find_pane.read(cx).search_status().total, 0);

            s.find_query
                .update(cx, |input, cx| input.set_value("https://[^ ]+", cx));
            s.sync_find(false, cx);
            assert!(!find_pane.read(cx).search_status().invalid_regex);
            assert_eq!(find_pane.read(cx).search_status().total, 1);

            // Tab while searching selects & copies the active match, and a second Tab extends to the next word.
            s.extend_find_selection(true, cx);
            assert_eq!(
                find_pane.read(cx).selected_text().as_deref(),
                Some("https://example.com/path")
            );
            s.extend_find_selection(true, cx);
            assert_eq!(
                find_pane.read(cx).selected_text().as_deref(),
                Some("https://example.com/path done")
            );

            // Live PTY output marks search dirty and refreshes match count cleanly.
            s.toggle_find_regex(w, cx);
            s.find_query
                .update(cx, |input, cx| input.set_value("beta", cx));
            s.sync_find(false, cx);
            assert_eq!(find_pane.read(cx).search_status().total, 1);
            find_pane.update(cx, |p, cx| {
                p.feed(b"another beta line\r\n", cx);
                assert!(p.refresh_search_if_dirty());
            });
            assert_eq!(find_pane.read(cx).search_status().total, 2);

            // Closing Find clears highlights, restores terminal focus, and remembers the last query.
            s.close_find(w, cx);
            assert!(!s.find_open);
            assert_eq!(find_pane.read(cx).search_status().total, 0);
            assert!(find_pane.read(cx).focus.is_focused(w));
            assert_eq!(s.find_query.read(cx).value(), "beta");
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

            // Verify Reload shortcut reconnects the focused remote pane.
            let reload_key = if cfg!(target_os = "macos") {
                "cmd-r"
            } else {
                "ctrl-shift-r"
            };
            s.shortcuts(
                &KeyDownEvent {
                    keystroke: Keystroke::parse(reload_key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );

            s.show(Page::Switch, w, cx);
            // Switch lists 2 open panes + only the 1 non-open catalogue session (sess-other).
            assert_eq!(s.picker_items(cx).len(), 3);
            s.open_create_session(w, cx);
            assert!(s.page == Page::Create);
            assert_eq!(s.origin, "https://outpost.zoco.cc");
            s.show(Page::Terminal, w, cx);
        });
        // Verify iTerm2-style overlay scrollbar: hover reveal, track jump, off-lane thumb drag,
        // Alt+click page scroll, keyboard scrollback shortcuts, and auto-hide in alt-screen.
        let scroll_pane = ws.read(cx).active().unwrap();
        scroll_pane.update(cx, |p, cx| {
            p.reset(60, 12);
            for i in 0..200 {
                p.feed(format!("scrollback line {i}\r\n").as_bytes(), cx);
            }
            p.grid_visible = true;
        });
        w.draw(cx).clear(cx);
        let hist = scroll_pane.read(cx).history_size_for_test();
        assert!(hist >= 180);
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), 0);
        let pb = scroll_pane.read(cx).bounds_for_test();
        let bar_x = pb.right() - px(4.);
        let mid_y = pb.top() + pb.size.height * 0.5;
        let top_y = pb.top() + px(8.);
        let bot_y = pb.bottom() - px(8.);

        // Hovering the right-edge lane expands the scrollbar; moving into text collapses it.
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(bar_x, mid_y),
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        );
        assert!(scroll_pane.read(cx).scrollbar_hovered_for_test());
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(20.), mid_y),
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        );
        assert!(!scroll_pane.read(cx).scrollbar_hovered_for_test());

        // Clicking top of track jumps straight to top of scrollback, then dragging horizontally
        // off-lane down to middle and bottom scrubs continuously without selecting terminal text.
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: point(bar_x, top_y),
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), hist);
        assert!(!scroll_pane.read(cx).has_selection());
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(10.), mid_y),
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        let mid_offset = scroll_pane.read(cx).display_offset_for_test();
        assert!(
            mid_offset > hist / 4 && mid_offset < hist * 3 / 4,
            "dragging thumb to middle must scrub mid-scrollback, got {mid_offset}/{hist}"
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(10.), bot_y),
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), 0);
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: point(pb.left() + px(10.), bot_y),
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert!(!scroll_pane.read(cx).has_selection());

        // Alt+click above thumb pages up cleanly.
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: point(bar_x, top_y),
                button: MouseButton::Left,
                modifiers: Modifiers::alt(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        let paged = scroll_pane.read(cx).display_offset_for_test();
        assert!(paged > 0 && paged < hist);

        // Keyboard scrollback shortcuts: Shift+Home -> top, Shift+End -> bottom, Shift+PageUp -> page up.
        scroll_pane.update(cx, |p, cx| {
            p.key_for_test("shift-home", w, cx);
            assert_eq!(p.display_offset_for_test(), hist);
            p.key_for_test("shift-end", w, cx);
            assert_eq!(p.display_offset_for_test(), 0);
            p.key_for_test("shift-pageup", w, cx);
            assert!(p.display_offset_for_test() > 0);
            p.key_for_test("shift-pagedown", w, cx);
            assert_eq!(p.display_offset_for_test(), 0);
            // Entering alt-screen hides the scrollbar cleanly.
            p.feed(b"\x1b[?1049h", cx);
        });
        w.draw(cx).clear(cx);
        assert!(!scroll_pane.read(cx).scrollbar_hovered_for_test());
        scroll_pane.update(cx, |p, cx| p.feed(b"\x1b[?1049l", cx));
    })?;
    draw_remote(&mut test);
    let mut saw_reconnect = false;
    while let Ok(cmd) = commands.try_recv() {
        if cmd["op"] == "reconnect" {
            saw_reconnect = true;
        }
    }
    assert!(saw_reconnect, "reload shortcut must send reconnect for remote pane");

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
            // Overflow the 700px (compact) title bar with 7 tabs and verify:
            // - compact bar keeps >= 56px window-drag area and generous scrollable tab strip
            // - opening tab 7 auto-scrolls the strip right on frame 0
            // - selecting tab 0 auto-scrolls the strip back to the start
            // - the overflow menu renders cleanly and tooltips stay neutral monochrome.
            let first_pane = ws.read(cx).tabs[0].active;
            ws.update(cx, |s, cx| {
                for _ in 0..6 {
                    s.local(None, w, cx);
                }
            });
            w.draw(cx).clear(cx);
            let drag_bar = ws
                .read(cx)
                .drag
                .empty_bar
                .bounds()
                .expect("window drag area laid out");
            assert!(
                drag_bar.size.width >= px(55.5),
                "compact window-drag-area must keep >= 56px even with overflowing tabs, got {:?}",
                drag_bar.size.width
            );
            let strip_bounds = ws.read(cx).drag.strip.bounds();
            assert!(
                strip_bounds.size.width >= px(240.),
                "compact bar should preserve roomy tab strip, got {:?}",
                strip_bounds.size.width
            );
            assert!(
                ws.read(cx).drag.strip.max_offset().x > px(0.),
                "7 tabs on 700px window should overflow horizontally"
            );
            assert!(
                ws.read(cx).drag.strip.offset().x < px(0.),
                "active last tab should auto-scroll into view on frame 0, got {:?}",
                ws.read(cx).drag.strip.offset().x
            );
            ws.update(cx, |s, cx| s.select(first_pane, w, cx));
            w.draw(cx).clear(cx);
            assert_eq!(
                ws.read(cx).drag.strip.offset().x,
                px(0.),
                "selecting first tab must scroll strip back to 0"
            );
            ws.update(cx, |s, cx| s.set_bar_menu(true, cx));
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).bar_menu_open);
            ws.update(cx, |s, cx| s.set_bar_menu(false, cx));
            let theme = cx.theme();
            assert!(
                theme.tooltip_bg.s < 0.01 && theme.tooltip_border.s < 0.01,
                "tooltip colors must stay neutral monochrome, got bg={:?} border={:?}",
                theme.tooltip_bg,
                theme.tooltip_border
            );
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
    // Verify keyboard shortcuts work reliably across focus loss, Windows shifted keys,
    // tab/pane navigation, font sizing, and close requests.
    {
        let sc_win = test.open_window(size(px(900.), px(600.)), |w, cx| {
            cx.new(|cx| Workspace::new(false, w, cx))
        })?;
        let dispatch_key = |w: &mut Window, cx: &mut App, keystroke: Keystroke, is_held: bool| {
            w.dispatch_event(
                PlatformInput::KeyDown(KeyDownEvent {
                    keystroke,
                    is_held,
                    prefer_character_input: false,
                }),
                cx,
            );
        };
        let mac = cfg!(target_os = "macos");
        let new_tab = Keystroke::parse(if mac { "cmd-t" } else { "ctrl-shift-t" }).unwrap();
        let split_col = Keystroke::parse(if mac { "cmd-d" } else { "ctrl-shift-d" }).unwrap();
        let split_row = Keystroke::parse(if mac { "cmd-shift-d" } else { "ctrl-alt-d" }).unwrap();
        let zoom_key =
            Keystroke::parse(if mac { "cmd-shift-enter" } else { "ctrl-alt-enter" }).unwrap();
        let pane_next =
            Keystroke::parse(if mac { "cmd-alt-right" } else { "ctrl-alt-right" }).unwrap();
        let pane_prev =
            Keystroke::parse(if mac { "cmd-alt-left" } else { "ctrl-alt-left" }).unwrap();
        let settings_key = Keystroke::parse(if mac { "cmd-," } else { "ctrl-," }).unwrap();
        let tab_1 = Keystroke::parse(if mac { "cmd-1" } else { "alt-1" }).unwrap();
        let tab_last = Keystroke::parse(if mac { "cmd-9" } else { "alt-9" }).unwrap();
        let font_up = Keystroke::parse(if mac { "cmd-=" } else { "ctrl-=" }).unwrap();
        let font_down = Keystroke::parse(if mac { "cmd--" } else { "ctrl--" }).unwrap();
        let font_reset = Keystroke::parse(if mac { "cmd-0" } else { "ctrl-0" }).unwrap();
        let close_pane = Keystroke::parse(if mac { "cmd-w" } else { "ctrl-shift-w" }).unwrap();
        let close_tab = Keystroke::parse(if mac { "cmd-alt-w" } else { "ctrl-alt-w" }).unwrap();

        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).page == Page::Home);
            // Shortcuts must work immediately on Page::Home without clicking first.
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 1);
            assert!(ws.read(cx).page == Page::Terminal);
            // Auto-repeat must not spawn extra tabs.
            dispatch_key(w, cx, new_tab.clone(), true);
            assert_eq!(ws.read(cx).tabs.len(), 1);

            // Simulate clicking a non-focusable area (blur) and verify shortcuts still work.
            w.draw(cx).clear(cx);
            w.blur(cx);
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 2);
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 3);
            let tab_ids: Vec<Id> = ws.read(cx).tabs.iter().map(|t| t.id).collect();

            // Tab switching: Alt+1 / Cmd+1 -> first, Alt+9 / Cmd+9 -> last, Ctrl+Tab, Ctrl+PageUp/Down.
            dispatch_key(w, cx, tab_1.clone(), false);
            assert_eq!(ws.read(cx).current, 0);
            dispatch_key(w, cx, tab_last.clone(), false);
            assert_eq!(ws.read(cx).current, 2);
            dispatch_key(w, cx, Keystroke::parse("ctrl-tab").unwrap(), false);
            assert_eq!(ws.read(cx).current, 0);
            dispatch_key(w, cx, Keystroke::parse("ctrl-shift-tab").unwrap(), false);
            assert_eq!(ws.read(cx).current, 2);
            dispatch_key(w, cx, Keystroke::parse("ctrl-pageup").unwrap(), false);
            assert_eq!(ws.read(cx).current, 1);
            dispatch_key(w, cx, Keystroke::parse("ctrl-pagedown").unwrap(), false);
            assert_eq!(ws.read(cx).current, 2);

            // Reorder active tab left and back right via Ctrl+Shift+PageUp / PageDown.
            dispatch_key(w, cx, Keystroke::parse("ctrl-shift-pageup").unwrap(), false);
            assert_eq!(ws.read(cx).current, 1);
            assert_eq!(ws.read(cx).tabs[1].id, tab_ids[2]);
            dispatch_key(w, cx, Keystroke::parse("ctrl-shift-pagedown").unwrap(), false);
            assert_eq!(ws.read(cx).current, 2);
            assert_eq!(ws.read(cx).tabs[2].id, tab_ids[2]);

            // Splits, pane cycling forward & backward, and zoom toggle.
            let initial_pane = ws.read(cx).tabs[2].active;
            dispatch_key(w, cx, split_col, false);
            let second_pane = ws.read(cx).tabs[2].active;
            assert_ne!(second_pane, initial_pane);
            dispatch_key(w, cx, split_row, false);
            let third_pane = ws.read(cx).tabs[2].active;
            assert_ne!(third_pane, second_pane);
            dispatch_key(w, cx, pane_prev, false);
            assert_eq!(ws.read(cx).tabs[2].active, second_pane);
            dispatch_key(w, cx, pane_next, false);
            assert_eq!(ws.read(cx).tabs[2].active, third_pane);
            dispatch_key(w, cx, zoom_key.clone(), false);
            assert!(ws.read(cx).tabs[2].zoom);
            dispatch_key(w, cx, zoom_key, false);
            assert!(!ws.read(cx).tabs[2].zoom);

            // Settings shortcut (Ctrl+, on Win/Linux, Cmd+, on macOS) + Windows shifted Ctrl+<.
            dispatch_key(w, cx, settings_key, false);
            assert!(ws.read(cx).page == Page::Settings);
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            assert!(ws.read(cx).page == Page::Terminal);
            if !mac {
                dispatch_key(
                    w,
                    cx,
                    Keystroke {
                        modifiers: Modifiers::control(),
                        key: "<".into(),
                        key_char: None,
                    },
                    false,
                );
                assert!(ws.read(cx).page == Page::Settings);
                dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            }

            // Font size shortcuts (+1, shifted +, -1, reset 0) and ensure Ctrl+_ is untouched.
            assert!((ws.read(cx).fontsize() - settings::DEFAULT_FONT_SIZE).abs() < 0.01);
            dispatch_key(w, cx, font_up, false);
            assert!((ws.read(cx).fontsize() - (settings::DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01);
            dispatch_key(
                w,
                cx,
                Keystroke {
                    modifiers: if mac {
                        Modifiers::command()
                    } else {
                        Modifiers::control()
                    },
                    key: "+".into(),
                    key_char: None,
                },
                false,
            );
            assert!((ws.read(cx).fontsize() - (settings::DEFAULT_FONT_SIZE + 2.0)).abs() < 0.01);
            dispatch_key(w, cx, font_down, false);
            assert!((ws.read(cx).fontsize() - (settings::DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01);
            if !mac {
                // Ctrl+_ (readline undo) must not be hijacked as font zoom out.
                dispatch_key(
                    w,
                    cx,
                    Keystroke {
                        modifiers: Modifiers::control(),
                        key: "_".into(),
                        key_char: None,
                    },
                    false,
                );
                assert!(
                    (ws.read(cx).fontsize() - (settings::DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01
                );
            }
            dispatch_key(w, cx, font_reset, false);
            assert!((ws.read(cx).fontsize() - settings::DEFAULT_FONT_SIZE).abs() < 0.01);

            // Close focused pane & close current tab shortcuts open close confirmation.
            assert!(!ws.read(cx).close_pending);
            dispatch_key(w, cx, close_pane, false);
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);
            dispatch_key(w, cx, close_tab, false);
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);

            // Tab right-click context menu must NEVER change the active tab or replace the pane's content.
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).current, 2);
            assert!(ws.read(cx).page == Page::Terminal);
            let first_tab_id = ws.read(cx).tabs[0].id;
            let active_tab_id = ws.read(cx).tabs[2].id;
            let first_tab_x = if mac { 160. } else { 90. };
            // Hovering an inactive tab tracks hovered_tab so dividers hide on both sides.
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(first_tab_x), px(20.)),
                    pressed_button: None,
                    modifiers: Default::default(),
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).hovered_tab, Some(first_tab_id));
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(first_tab_x), px(200.)),
                    pressed_button: None,
                    modifiers: Default::default(),
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).hovered_tab, None);
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: point(px(first_tab_x), px(20.)),
                    button: MouseButton::Right,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(
                ws.read(cx).tab_menu.map(|(id, _)| id),
                Some(first_tab_id),
                "right-clicking inactive tab must open context menu for that tab"
            );
            assert_eq!(
                ws.read(cx).current,
                2,
                "right-clicking an inactive tab must not switch the active tab"
            );
            assert!(
                ws.read(cx).page == Page::Terminal,
                "right-clicking a tab must never replace the terminal view"
            );
            // Escape closes the tab context menu and leaves the terminal active.
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).tab_menu.is_none());
            assert!(ws.read(cx).page == Page::Terminal);

            // Moving an inactive tab via tab menu keeps the current active tab selected.
            ws.update(cx, |s, cx| s.move_tab_by_id(first_tab_id, 1, cx));
            assert_eq!(ws.read(cx).tabs[1].id, first_tab_id);
            assert_eq!(ws.read(cx).tabs[ws.read(cx).current].id, active_tab_id);

            // Lightweight tab rename overlay keeps Page::Terminal intact and commits on Enter.
            ws.update(cx, |s, cx| s.open_tab_rename(first_tab_id, w, cx));
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).tab_rename, Some(first_tab_id));
            assert!(ws.read(cx).page == Page::Terminal);
            ws.update(cx, |s, cx| {
                s.tab_rename_input
                    .update(cx, |input, cx| input.set_value_silent("Build shell", cx));
            });
            dispatch_key(w, cx, Keystroke::parse("enter").unwrap(), false);
        })?;
        test.run_until_parked();
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            let active_tab_id = ws.read(cx).tabs[ws.read(cx).current].id;
            assert!(ws.read(cx).tab_rename.is_none());
            assert_eq!(ws.read(cx).tabs[1].name, "Build shell");
            assert!(ws.read(cx).page == Page::Terminal);

            // Close other tabs requests confirmation for all tabs except the chosen one.
            ws.update(cx, |s, cx| s.close_other_tabs(active_tab_id, w, cx));
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);
        })?;
        // Verify Escape also closes an open tab context menu after PopupMenu deferred focus settles.
        let first_tab_x = if mac { 160. } else { 90. };
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            let first_tab_id = ws.read(cx).tabs[0].id;
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: point(px(first_tab_x), px(20.)),
                    button: MouseButton::Right,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).tab_menu.map(|(id, _)| id), Some(first_tab_id));
        })?;
        test.run_until_parked();
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            w.draw(cx).clear(cx);
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).tab_menu.is_none());
            assert!(ws.read(cx).page == Page::Terminal);
        })?;
        test.update_window(sc_win.into(), |_, w, _| w.remove_window())?;
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

#[cfg(test)]
mod chrome_tests {
    use super::{compute_chrome_layout, find::format_find_counter, show_tab_divider};
    use crate::terminal::SearchStatus;

    #[::core::prelude::v1::test]
    fn find_counter_formats_empty_error_zero_normal_and_truncated() {
        assert_eq!(format_find_counter("", &SearchStatus::default()), None);
        assert_eq!(
            format_find_counter(
                "[bad",
                &SearchStatus {
                    invalid_regex: true,
                    ..Default::default()
                }
            ),
            Some(("Invalid regex".into(), true))
        );
        assert_eq!(
            format_find_counter("missing", &SearchStatus::default()),
            Some(("No results".into(), true))
        );
        assert_eq!(
            format_find_counter(
                "err",
                &SearchStatus {
                    total: 17,
                    active: Some(2),
                    ..Default::default()
                }
            ),
            Some(("3/17".into(), false))
        );
        assert_eq!(
            format_find_counter(
                "e",
                &SearchStatus {
                    total: 10_000,
                    active: Some(9_999),
                    truncated: true,
                    invalid_regex: false,
                }
            ),
            Some(("10000/10,000+".into(), false))
        );
    }

    #[::core::prelude::v1::test]
    fn tab_divider_hidden_around_active_hovered_and_preview_tabs() {
        // Two plain inactive neighbors show a divider.
        assert!(show_tab_divider(1, Some(2), Some(3), None));

        // Hidden on both sides of the active tab.
        assert!(!show_tab_divider(1, Some(2), Some(2), None));
        assert!(!show_tab_divider(2, Some(3), Some(2), None));

        // Hidden on both sides of a hovered inactive tab.
        assert!(!show_tab_divider(1, Some(2), Some(3), Some(2)));
        assert!(!show_tab_divider(2, Some(3), Some(4), Some(2)));

        // Hidden before a drag preview slot or after the final tab.
        assert!(!show_tab_divider(1, None, Some(3), None));
    }

    #[::core::prelude::v1::test]
    fn chrome_layout_adapts_cleanly_from_wide_to_crowded() {
        // Wide window with 3 tabs: full toolbar, no scroll arrows, no overflow menu.
        let wide = compute_chrome_layout(1100., 3, false, true);
        assert!(!wide.compact_bar);
        assert!(!wide.overflowing);
        assert!(!wide.show_overflow_menu);
        assert_eq!(wide.drag_min, 80.);

        // Wide window with 10 tabs: keeps full toolbar, adds scroll arrows & tab-list menu.
        let wide_many = compute_chrome_layout(1100., 10, false, true);
        assert!(!wide_many.compact_bar);
        assert!(wide_many.overflowing);
        assert!(wide_many.show_overflow_menu);
        assert!(wide_many.est_max_scroll_x > 0.);

        // Narrow 540px window with 2 tabs: compact toolbar collapses right actions into ⌄, tabs fit without arrows.
        let narrow_two = compute_chrome_layout(540., 2, false, true);
        assert!(narrow_two.compact_bar);
        assert!(!narrow_two.overflowing);
        assert!(narrow_two.show_overflow_menu);
        assert_eq!(narrow_two.drag_min, 56.);

        // Narrow 540px window with 4 tabs: compact toolbar + scroll arrows + positive estimated max scroll.
        let narrow_four = compute_chrome_layout(540., 4, false, true);
        assert!(narrow_four.compact_bar);
        assert!(narrow_four.overflowing);
        assert!(narrow_four.show_overflow_menu);
        assert!(narrow_four.est_max_scroll_x > 0.);
    }
}

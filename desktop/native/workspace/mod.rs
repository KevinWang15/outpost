mod chrome;
mod create;
mod drag;
mod events;
pub(crate) mod files;
mod find;
mod home;
mod panes;
mod picker;
mod settings;
mod shortcuts;
mod ui;
#[cfg(feature = "ui-tests")]
mod ui_tests;

#[cfg(feature = "ui-tests")]
pub use ui_tests::exercise_workspace;

use crate::{
    agent_mark::AgentMark,
    bridge::Bridge,
    layout::{Axis, Id, Layout, Tab, next_id},
    prefs::Preferences,
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
    sync::Arc,
};
use ui::{
    BG, MUTED, TEXT, agent_label, button, card, card_divider, col, confirm, control,
    control_with_icon, field, format_thousands, home_dir, icon, items, row, section, strval, text,
};

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

#[derive(Clone, Copy, Debug, PartialEq)]
enum OverlayMenu {
    NewTab,
    BarOverflow,
    Pane(Id),
    Context(Id, Point<Pixels>),
    Split(Id, Axis, Point<Pixels>),
    Tab(Id, Point<Pixels>),
    TabRename(Id),
    Files(Id),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum OpenTarget {
    NewTab,
    Split(Id, Axis),
}

struct ToastNotice {
    token: u64,
    pane: Option<Id>,
    message: String,
    sticky: bool,
}

struct FindState {
    open: bool,
    pane: Option<Id>,
    options: SearchOptions,
    focus: FocusHandle,
    query: Entity<InputState>,
}

struct PickerState {
    index: usize,
    scroll: ScrollHandle,
    refreshing: bool,
    query: Entity<InputState>,
}

#[derive(Default)]
struct FilesState {
    preview_id: Option<String>,
    preview: Option<Arc<Image>>,
}

type Transfer = (Tab, BTreeMap<Id, Entity<Pane>>, HashMap<u64, Id>);

#[derive(Clone, Copy)]
struct TransferRef {
    pane: Id,
    whole: bool,
}

#[derive(Clone)]
struct DragItem {
    pane: Id,
    window: u64,
    whole: bool,
    label: DragLabel,
}

impl DragItem {
    fn transfer_ref(&self) -> TransferRef {
        TransferRef {
            pane: self.pane,
            whole: self.whole,
        }
    }
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

pub struct Workspace {
    watches: HashMap<Id, ([Subscription; 6], SnapshotSource)>,
    drag: DragState,
    active_order: usize,
    handle: AnyWindowHandle,
    pub(crate) id: u64,
    bridge: Option<Bridge>,
    panes: BTreeMap<Id, Entity<Pane>>,
    pub(crate) remote: HashMap<u64, Id>,
    tabs: Vec<Tab>,
    current: usize,
    startup_local: bool,
    startup_cloak: bool,
    startup_hint: bool,
    overlay: Option<OverlayMenu>,
    strip_scroll_anim: Option<(std::time::Instant, f32, f32)>,
    hovered_tab: Option<Id>,
    find: FindState,
    toast: Option<ToastNotice>,
    close_pending: bool,
    page: Page,
    focus: FocusHandle,
    logo: Arc<Image>,
    message: String,
    accounts: Value,
    prefs: Preferences,
    address: Entity<InputState>,
    history_input: Entity<InputState>,
    tab_rename_input: Entity<InputState>,
    compose: Entity<TextBoxState>,
    split_at: Option<(Id, Axis)>,
    bounds: HashMap<Id, Bounds<Pixels>>,
    resizing: Option<(Id, Axis)>,
    create: CreateForm,
    picker: PickerState,
    files: FilesState,
    #[cfg(feature = "ui-tests")]
    status_overlay_bounds: Arc<std::sync::Mutex<HashMap<&'static str, Bounds<Pixels>>>>,
}

impl Workspace {
    pub fn new(local: bool, w: &mut Window, cx: &mut Context<Self>) -> Self {
        use crate::hub::Hub;
        let hub = cx.global::<Hub>();
        let message = hub.error.clone();
        let bridge = hub.bridge.clone();
        let hub_prefs = hub.prefs.clone();
        let accounts = hub.accounts.clone();
        let ready = hub_prefs.is_some() || bridge.is_none();
        let startup_local = local && !ready;
        let startup_cloak = local || (bridge.is_some() && hub_prefs.is_none());
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
        let picker_query = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("Search sessions, machines, or servers…")
                .leading_icon(LucideIcon::Search)
        });
        cx.subscribe_in(&picker_query, w, |s: &mut Self, _, event: &InputEvent, w, cx| {
            match event {
                InputEvent::Change(_) => {
                    s.picker.index = 0;
                    cx.notify();
                }
                InputEvent::Submit(_) if matches!(s.page, Page::Choose | Page::Switch) => {
                    let index = s.picker.index;
                    s.activate_picker_item(index, w, cx);
                }
                _ => cx.notify(),
            }
        })
        .detach();
        let address = entry("https://outpost.example.com", cx);
        cx.subscribe_in(&address, w, |s: &mut Self, _, event: &InputEvent, w, cx| {
            if matches!(event, InputEvent::Submit(_)) && s.page == Page::Home {
                s.submit(w, cx);
            }
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
                    if s.find.open {
                        s.sync_find(false, cx);
                    }
                }
                InputEvent::Submit(_) => {
                    if s.find.open {
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
                s.overlay = None;
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
        let create = CreateForm::new(w, cx);
        Self {
            watches: HashMap::new(),
            drag: DragState::default(),
            active_order: next_id(),
            handle: w.window_handle(),
            id: next_id() as u64,
            startup_local,
            startup_cloak,
            startup_hint: false,
            overlay: None,
            strip_scroll_anim: None,
            hovered_tab: None,
            find: FindState {
                open: false,
                pane: None,
                options: SearchOptions::default(),
                focus: find_focus,
                query: find_query,
            },
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
                include_bytes!("../../../public/outpost-256.png").to_vec(),
            )),
            message,
            accounts,
            prefs: hub_prefs.unwrap_or_default(),
            address,
            history_input,
            tab_rename_input,
            compose,
            split_at: None,
            bounds: Default::default(),
            resizing: None,
            create,
            picker: PickerState {
                index: 0,
                scroll: ScrollHandle::new(),
                refreshing: false,
                query: picker_query,
            },
            files: FilesState::default(),
            #[cfg(feature = "ui-tests")]
            status_overlay_bounds: Default::default(),
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

    fn sync_history_input(&mut self, cx: &mut Context<Self>) {
        let lines = self.prefs.scrollback_lines.to_string();
        self.history_input
            .update(cx, |input, cx| input.set_value_silent(lines, cx));
    }

    fn save_history_limit(&mut self, cx: &mut Context<Self>) {
        let value = self.history_input.read(cx).value().trim().parse::<usize>();
        if let Ok(lines) = value
            && lines <= crate::terminal::MAX_HISTORY
        {
            self.message.clear();
            self.prefs.scrollback_lines = lines;
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
        if !matches!(self.page, Page::Choose | Page::Create) {
            self.split_at = None;
        }
        self.message.clear();
        self.overlay = None;
        self.files.preview_id = None;
        self.files.preview = None;
        self.create.close_all(cx);
        if self.page != Page::Terminal && self.find.open {
            self.find.open = false;
            self.clear_find_highlights(cx);
            self.find
                .query
                .update(cx, |input, cx| input.set_invalid(false, cx));
        }
        match self.page {
            Page::Terminal => {
                if self.find.open {
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
                self.picker.index = 0;
                self.picker
                    .query
                    .update(cx, |s, cx| s.set_value_silent("", cx));
                self.picker.query.read(cx).focus_handle(cx).focus(w, cx)
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
            if let Some(pane) = self.panes.get(&id) {
                pane.update(cx, |p, _| p.touch_used());
            }
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
        let sound = self.prefs.sound;
        let history = self.prefs.history();
        p.update(cx, |p, _| {
            p.sound = sound;
            p.set_scrollback(history);
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
                if changed && s.find.open && s.page == Page::Terminal {
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
            if s.active().as_ref() == Some(&p) && s.files.preview_id.as_deref() == Some(&e.file) {
                s.files.preview = Some(e.image.clone());
                cx.notify();
            }
        });
        let open_session = cx.subscribe(p, move |s, p, e: &crate::terminal::PaneOpenSession, cx| {
            if !s.panes.contains_key(&id) {
                return;
            }
            let label = e.name.as_deref().unwrap_or(&e.session_id);
            s.show_toast(
                Some(id),
                format!("Opening \"{label}\" in Outpost…"),
                false,
                cx,
            );
            let pane_server = p.read(cx).server.clone();
            s.call(json!({
                "op": "openSession",
                "sessionId": e.session_id,
                "name": e.name,
                "origin": e.origin,
                "targetId": e.target_id,
                "hostname": e.hostname,
                "paneServer": pane_server,
            }));
        });
        self.watches.insert(
            id,
            (
                [sub, menu, paste_error, notice, ready, open_session],
                SnapshotSource::new(),
            ),
        );
    }

    fn local(&mut self, profile: Option<String>, w: &mut Window, cx: &mut Context<Self>) {
        let profile = self.prefs.local_profile(profile.as_deref());
        let executable = profile
            .filter(|s| !s.executable.is_empty())
            .map(|s| s.executable.clone())
            .unwrap_or_else(|| {
                std::env::var("SHELL").unwrap_or_else(|_| {
                    if cfg!(windows) {
                        "cmd.exe".into()
                    } else {
                        "/bin/sh".into()
                    }
                })
            });
        let args = profile.map(|s| s.args.clone()).unwrap_or_else(|| {
            if cfg!(windows) {
                vec![]
            } else {
                vec!["-l".into()]
            }
        });
        let pane = Pane::local(
            &executable,
            &args,
            &home_dir(),
            self.prefs.font_size,
            w,
            cx,
        );
        self.insert(pane, w, cx);
    }

    fn apply_open_target(&mut self, target: OpenTarget) {
        self.split_at = match target {
            OpenTarget::NewTab => None,
            OpenTarget::Split(pane, axis) if self.panes.contains_key(&pane) => Some((pane, axis)),
            OpenTarget::Split(..) => None,
        };
    }

    pub(super) fn open_local(
        &mut self,
        target: OpenTarget,
        profile: Option<String>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.apply_open_target(target);
        self.local(profile, w, cx);
    }

    pub(super) fn open_sessions_for(
        &mut self,
        target: OpenTarget,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if items(&self.accounts["accounts"]).is_empty() {
            self.split_at = None;
            self.show(Page::Home, w, cx);
            self.address.read(cx).focus_handle(cx).focus(w, cx);
        } else {
            self.apply_open_target(target);
            self.catalogue(w, cx);
        }
    }

    fn split_menu_anchor(&self, pane: Id, axis: Axis, w: &Window, cx: &App) -> Point<Pixels> {
        let bounds = self
            .watches
            .get(&pane)
            .and_then(|(_, snap)| snap.bounds())
            .or_else(|| self.panes.get(&pane).map(|p| p.read(cx).bounds()))
            .filter(|b| b.size.width > px(1.) && b.size.height > px(1.));
        if let Some(b) = bounds {
            match axis {
                Axis::Across => point(b.left() + b.size.width * 0.5 + px(12.), b.top() + px(36.)),
                Axis::Down => point(b.left() + px(24.), b.top() + b.size.height * 0.5 + px(12.)),
            }
        } else {
            let vp = w.viewport_size();
            point(
                (vp.width * 0.5 - px(120.)).max(px(16.)),
                (vp.height * 0.25).max(px(56.)),
            )
        }
    }

    pub(super) fn open_split_menu(
        &mut self,
        pane: Option<Id>,
        axis: Axis,
        position: Option<Point<Pixels>>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(target) = pane
            .filter(|id| self.panes.contains_key(id))
            .or_else(|| self.tabs.get(self.current).map(|t| t.active))
        else {
            return;
        };
        let pos = position.unwrap_or_else(|| self.split_menu_anchor(target, axis, w, cx));
        let already_splitting_target = self.page == Page::Terminal
            && matches!(self.overlay, Some(OverlayMenu::Split(p, _, _)) if p == target);
        if !already_splitting_target {
            self.select(target, w, cx);
        }
        self.overlay = Some(OverlayMenu::Split(target, axis, pos));
        cx.notify();
    }

    pub(super) fn close_split_menu(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.overlay, Some(OverlayMenu::Split(..))) {
            self.overlay = None;
            self.restore_focus(w, cx);
            cx.notify();
        }
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

    fn take_transfer(&mut self, target: TransferRef) -> Option<Transfer> {
        let i = self
            .tabs
            .iter()
            .position(|t| t.layout.contains(target.pane))?;
        let tab = if target.whole {
            let tab = self.tabs.remove(i);
            if matches!(
                self.overlay,
                Some(OverlayMenu::Tab(t, _) | OverlayMenu::TabRename(t)) if t == tab.id
            ) || matches!(
                self.overlay,
                Some(OverlayMenu::Split(p, _, _)) if tab.layout.contains(p)
            ) {
                self.overlay = None;
            }
            if self.split_at.is_some_and(|(p, _)| tab.layout.contains(p)) {
                self.split_at = None;
            }
            if self.hovered_tab == Some(tab.id) {
                self.hovered_tab = None;
            }
            if self.current > i {
                self.current -= 1
            }
            self.current = self.current.min(self.tabs.len().saturating_sub(1));
            self.prune_bounds();
            tab
        } else {
            self.remove_leaf(target.pane);
            Tab::single(target.pane)
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

    fn tab_transfer_ref(&self, tab_id: Id) -> Option<TransferRef> {
        let tab = self.tabs.iter().find(|t| t.id == tab_id)?;
        self.panes.contains_key(&tab.active).then_some(TransferRef {
            pane: tab.active,
            whole: true,
        })
    }

    fn selected_pane_ref(&self) -> Option<TransferRef> {
        let tab = self.tabs.get(self.current)?;
        self.panes.contains_key(&tab.active).then_some(TransferRef {
            pane: tab.active,
            whole: false,
        })
    }

    fn detach_selected_pane(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(target) = self.selected_pane_ref() {
            self.detach_transfer(target, None, w, cx);
        }
    }

    fn detach_tab(&mut self, tab_id: Id, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(target) = self.tab_transfer_ref(tab_id) {
            self.detach_transfer(target, None, w, cx);
        }
    }

    fn place_selected_pane(&mut self, dest: Destination, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(target) = self.selected_pane_ref()
            && let Some(t) = self.take_transfer(target)
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

    fn reconnect_remote_pane(&mut self, id: Id, cx: &mut Context<Self>) {
        let Some(pane) = self.panes.get(&id).cloned() else {
            return;
        };
        if pane.read(cx).server.is_none() {
            return;
        }
        self.clear_pane_sticky_toast(id);
        if self.active().as_ref() == Some(&pane) && self.files.preview_id.is_some() {
            self.files.preview_id = None;
            self.files.preview = None;
        }
        pane.update(cx, |p, cx| p.reconnect(cx));
    }

    fn reload_pane(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        if pane.read(cx).server.is_some() {
            if self
                .tabs
                .get(self.current)
                .is_some_and(|t| t.layout.contains(id))
            {
                self.show(Page::Terminal, w, cx);
            }
            self.reconnect_remote_pane(id, cx);
            cx.notify();
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

    fn prune_bounds(&mut self) {
        self.bounds
            .retain(|split_id, _| self.tabs.iter().any(|t| t.layout.contains_split(*split_id)));
    }

    fn remove_leaf(&mut self, id: Id) {
        if matches!(
            self.overlay,
            Some(
                OverlayMenu::Pane(p)
                    | OverlayMenu::Context(p, _)
                    | OverlayMenu::Split(p, _, _)
                    | OverlayMenu::Files(p)
            ) if p == id
        ) {
            self.overlay = None;
        }
        if self.split_at.is_some_and(|(p, _)| p == id) {
            self.split_at = None;
        }
        if self.find.pane == Some(id) {
            self.find.pane = None;
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
                if matches!(
                    self.overlay,
                    Some(OverlayMenu::Tab(t, _) | OverlayMenu::TabRename(t)) if t == removed_tab
                ) {
                    self.overlay = None;
                }
                if self.hovered_tab == Some(removed_tab) {
                    self.hovered_tab = None;
                }
                if i < self.current {
                    self.current -= 1
                }
                self.current = self.current.min(self.tabs.len().saturating_sub(1))
            }
            self.prune_bounds();
        }
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
        self.create.target = id.clone();
        self.create.options = Value::Null;
        self.create.tool.clear();
        self.message.clear();
        self.create
            .cancel_directory_lookups(self.create.target.is_empty(), cx);
        self.sync_machine_select(cx);
        self.sync_tool_select(cx);
        self.call(json!({
            "op": "options",
            "origin": self.create.origin,
            "accountId": self.create.account_id,
            "target": id,
        }));
    }

    fn creation_ready(&self) -> bool {
        !self.create.creating
            && self.create.options.is_object()
            && !self.create.tool.is_empty()
            && items(&self.create.options["missing"]).is_empty()
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
                let index = self.picker.index;
                self.activate_picker_item(index, w, cx);
            }
            _ => {}
        }
    }

    fn settings(&mut self, cx: &mut Context<Self>) {
        self.call(self.prefs.to_command());
        self.apply_preferences(cx);
        cx.notify()
    }

    fn apply_preferences(&self, cx: &mut Context<Self>) {
        let history = self.prefs.history();
        let font_size = self.prefs.font_size;
        let sound = self.prefs.sound;
        for p in self.panes.values() {
            p.update(cx, |p, cx| {
                p.set_scrollback(history);
                p.font_size = font_size;
                p.sound = sound;
                cx.notify()
            })
        }
    }

    fn catalogue(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.picker.refreshing = true;
        self.call(json!({"op":"refresh"}));
        self.show(Page::Choose, w, cx)
    }

    fn dismiss_page(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.split_at = None;
        let next = if self.tabs.is_empty() {
            Page::Home
        } else {
            Page::Terminal
        };
        self.show(next, w, cx);
    }

    fn any_popup_open(&self) -> bool {
        self.overlay.is_some() || self.files.preview_id.is_some()
    }

    fn restore_focus(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Terminal && self.find.open && !self.any_popup_open() {
            self.find.query.read(cx).focus_handle(cx).focus(w, cx);
        } else if self.page == Page::Terminal
            && !self.any_popup_open()
            && let Some(p) = self.active()
        {
            p.update(cx, |p, cx| p.focus_terminal(w, cx));
        } else {
            self.focus.focus(w, cx);
        }
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
        let mut actions = row()
            .flex_wrap()
            .items_center()
            .justify_center()
            .gap(px(8.));
        if remote {
            actions = actions.child(
                button(
                    ("pane-reconnect", id),
                    !pending,
                    cx,
                    move |s, w, cx| {
                        s.select(id, w, cx);
                        s.reconnect_remote_pane(id, cx);
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
        let text_box = div()
            .min_w_0()
            .flex_shrink(1.)
            .text_left()
            .text_size(px(14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(rgb(if pending { 0xd4d4d4 } else { 0xf0f0f0 }))
            .child(pane.status.clone());
        #[cfg(feature = "ui-tests")]
        let text_box = {
            let probe = self.status_overlay_bounds.clone();
            text_box.relative().child(
                canvas(
                    move |b, _, _| {
                        probe.lock().unwrap().insert("text", b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
        };
        let status_row = row()
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .child(div().flex_none().child(icon))
            .child(text_box);
        #[cfg(feature = "ui-tests")]
        let status_row = {
            let probe = self.status_overlay_bounds.clone();
            status_row.relative().child(
                canvas(
                    move |b, _, _| {
                        probe.lock().unwrap().insert("row", b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
        };
        let card = col()
            .id(("pane-status-overlay", id))
            .occlude()
            .max_w_full()
            .items_center()
            .gap(px(14.))
            .p(px(20.))
            .rounded(px(12.))
            .backdrop_blur(px(14.))
            .bg(rgba(0x161618cc))
            .border_1()
            .border_color(rgba(0xffffff22))
            .shadow_lg()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    cx.stop_propagation();
                    if s.tabs.get(s.current).is_some_and(|t| t.active != id) {
                        s.select(id, w, cx);
                    }
                }),
            )
            .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
            .child(status_row)
            .child(actions);
        #[cfg(feature = "ui-tests")]
        let card = {
            let probe = self.status_overlay_bounds.clone();
            card.relative().child(
                canvas(
                    move |b, _, _| {
                        probe.lock().unwrap().insert("card", b);
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
        };
        Some(
            div()
                .absolute()
                .inset_0()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .px(px(20.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(420.))
                        .flex()
                        .justify_center()
                        .child(card),
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
                let badge = (self.overlay == Some(OverlayMenu::Files(id))
                    || !items(&pane.files).is_empty())
                .then(|| self.files_dropdown(id, pane, cx));
                let find_bar = active.then(|| self.find_overlay(id, pane, cx)).flatten();
                let badge_top = if find_bar.is_some() { px(50.) } else { px(6.) };
                let dragged = self.drag.dragged_pane() == Some(id);
                let surface = col()
                    .relative()
                    .pt(px(5.))
                    .pb(px(5.))
                    .pl(px(5.))
                    .flex_1()
                    .overflow_hidden()
                    .child(p)
                    .when(!active && !dragged, |e| {
                        e.child(div().absolute().inset_0().bg(rgba(0x00000052)))
                    })
                    .when(dragged, |e| {
                        e.child(
                            div()
                                .absolute()
                                .inset_0()
                                .bg(rgba(0x0000007a))
                                .border_1()
                                .border_color(rgba(0xffffff2c)),
                        )
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
}

impl Render for Workspace {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.prefetch_thumbnail(cx);
        if self.find.open && self.page == Page::Terminal {
            if let Some(p) = self.active() {
                p.update(cx, |p, _| {
                    p.refresh_search_if_dirty();
                });
            } else {
                self.find.open = false;
                self.find.pane = None;
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
            .when(self.drag.is_active(), |e| e.cursor(CursorStyle::ClosedHand))
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
            .child(self.split_menu_overlay(cx))
            .children(self.tab_rename_overlay(cx))
            .children(self.drag_overlay(w))
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
                s.open_local(OpenTarget::NewTab, None, w, cx)
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
                    s.open_split_menu(None, Axis::Across, None, w, cx);
                }
            }))
            .on_action(cx.listener(|s, _: &crate::menu::SplitRows, w, cx| {
                if s.page == Page::Terminal && !s.tabs.is_empty() {
                    s.open_split_menu(None, Axis::Down, None, w, cx);
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
                if matches!(s.page, Page::Terminal | Page::Compose) && !s.tabs.is_empty() {
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

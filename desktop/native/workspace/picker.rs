use super::*;

pub(super) enum PickerItem {
    OpenPane(Id),
    RemoteSession {
        id: String,
        open_pane: Option<Id>,
        name: String,
        machine: Option<String>,
        server: String,
        tool: Option<&'static AgentMark>,
    },
}

pub(super) fn split_session_title(raw: &str) -> (&str, Option<&str>) {
    if let Some((name, machine)) = raw.split_once(" · ") {
        let name = name.trim();
        let machine = machine.trim();
        if !name.is_empty() {
            let machine = (!machine.is_empty() && machine != name).then_some(machine);
            return (name, machine);
        }
    }
    (raw, None)
}

pub(super) fn display_server(origin: &str) -> &str {
    origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))
        .unwrap_or(origin)
        .trim_end_matches('/')
}

fn matches_terms(haystack: &str, terms: &[String]) -> bool {
    if terms.is_empty() {
        return true;
    }
    let lower = haystack.to_lowercase();
    terms.iter().all(|term| lower.contains(term.as_str()))
}

fn keycap_icon(symbol: LucideIcon) -> Div {
    div()
        .px(px(4.))
        .py(px(2.))
        .rounded(px(4.))
        .border_1()
        .border_color(rgb(0x2a2a2a))
        .bg(rgb(0x161616))
        .flex()
        .items_center()
        .justify_center()
        .child(lucide_icon(symbol).size(px(11.)).text_color(rgb(MUTED)))
}

fn header_action(
    id: impl Into<ElementId>,
    symbol: LucideIcon,
    label: &'static str,
    disabled: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::accesskit::Role::Button)
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(5.))
        .px(px(8.))
        .py(px(4.))
        .rounded(px(5.))
        .border_1()
        .border_color(rgb(0x2b2b2b))
        .bg(rgb(0x171717))
        .text_size(px(12.))
        .text_color(rgb(if disabled { 0x6e6e6e } else { 0xc8c8c8 }))
        .when(!disabled, |el| {
            el.focusable()
                .tab_stop(true)
                .focus_visible(|s| s.border_color(rgb(0x888888)))
                .cursor_pointer()
                .hover(|s| {
                    s.bg(rgb(0x232323))
                        .border_color(rgb(0x404040))
                        .text_color(rgb(0xffffff))
                })
                .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
                .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)))
        })
        .when(disabled, |el| el.opacity(0.55))
        .child(lucide_icon(symbol).size(px(12.5)))
        .child(label)
}

fn section_label(label: &'static str, top_pad: Pixels) -> Div {
    div()
        .px(px(8.))
        .pt(top_pad)
        .pb(px(4.))
        .text_size(px(10.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(rgb(0x7a7a7a))
        .child(label)
}

#[allow(clippy::too_many_arguments)]
fn picker_row(
    idx: usize,
    is_selected: bool,
    leading: AnyElement,
    status: Option<AnyElement>,
    title: String,
    subtitle: String,
    subtitle_indent: Pixels,
    badge: Option<AnyElement>,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(("picker-row", idx))
        .relative()
        .w_full()
        .px(px(10.))
        .py(px(8.))
        .rounded(px(6.))
        .cursor_pointer()
        .bg(rgb(if is_selected { 0x222222 } else { 0x111111 }))
        .hover(|s| s.bg(rgb(0x1c1c1c)))
        .when(is_selected, |el| {
            el.child(
                div()
                    .absolute()
                    .left_0()
                    .top(px(5.))
                    .bottom(px(5.))
                    .w(px(2.))
                    .rounded_full()
                    .bg(rgb(0xe6e6e6)),
            )
        })
        .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
        .on_click(on_click)
        .child(
            col()
                .gap(px(2.))
                .child(
                    row()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            row()
                                .flex_1()
                                .gap(px(8.))
                                .children(status)
                                .child(leading)
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(13.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(rgb(0xf0f0f0))
                                        .child(title),
                                ),
                        )
                        .children(badge),
                )
                .child(
                    div()
                        .pl(subtitle_indent)
                        .truncate()
                        .text_size(px(11.5))
                        .text_color(rgb(0x888888))
                        .child(subtitle),
                ),
        )
}

fn picker_child_index(entries: &[PickerItem], choose: bool, item_index: usize) -> usize {
    if choose {
        return item_index;
    }
    let open_count = entries
        .iter()
        .take_while(|e| matches!(e, PickerItem::OpenPane(_)))
        .count();
    let has_both = open_count > 0 && open_count < entries.len();
    if !has_both {
        item_index
    } else if item_index < open_count {
        item_index + 1
    } else {
        item_index + 2
    }
}

impl Workspace {
    pub(super) fn creatable_accounts(&self) -> Vec<(String, String)> {
        items(&self.accounts["accounts"])
            .iter()
            .filter(|a| a["canCreate"] == true)
            .map(|a| (strval(a, "origin"), strval(&a["account"], "id")))
            .collect()
    }

    pub(super) fn open_create_session(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let accounts = self.creatable_accounts();
        if accounts.is_empty() {
            self.split_at = None;
            self.show(Page::Home, w, cx);
            self.address.read(cx).focus_handle(cx).focus(w, cx);
            return;
        }
        let preferred_server = self.active().and_then(|p| p.read(cx).server.clone());
        let (origin, account_id) = preferred_server
            .as_deref()
            .and_then(|srv| accounts.iter().find(|(o, _)| o == srv).cloned())
            .unwrap_or_else(|| accounts[0].clone());
        self.create_form(origin, account_id, w, cx);
    }

    pub(super) fn open_pane_for_session(&self, session: &Value, cx: &App) -> Option<Id> {
        let session_id = session["id"].as_str()?;
        self.panes
            .iter()
            .find(|(_, p)| p.read(cx).session_key.as_deref() == Some(session_id))
            .map(|(&id, _)| id)
    }

    pub(super) fn picker_items(&self, cx: &App) -> Vec<PickerItem> {
        let terms: Vec<String> = self
            .picker
            .query
            .read(cx)
            .value()
            .split_whitespace()
            .map(str::to_lowercase)
            .collect();
        let choose = self.page == Page::Choose;
        let mut list = Vec::new();
        let mut matched_open_ids = Vec::new();

        let mut open_ids: Vec<(Id, u64)> = self
            .panes
            .iter()
            .map(|(&id, p)| (id, p.read(cx).last_used))
            .collect();
        open_ids.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));

        if !choose {
            for &(id, _) in &open_ids {
                let pane = self.panes[&id].read(cx);
                let haystack = format!(
                    "{} {}",
                    pane.title,
                    pane.server.as_deref().unwrap_or("Local terminal")
                );
                if matches_terms(&haystack, &terms) {
                    list.push(PickerItem::OpenPane(id));
                }
            }
        }

        for v in items(&self.accounts["sessions"]) {
            let raw_title = strval(v, "title");
            let server = strval(v, "server");
            let detail = strval(v, "detail");
            let open_pane = self.open_pane_for_session(v, cx);
            if let Some(id) = open_pane {
                matched_open_ids.push(id);
            }
            if !choose && open_pane.is_some() {
                continue;
            }
            let haystack = format!("{raw_title} {server} {detail}");
            if !matches_terms(&haystack, &terms) {
                continue;
            }
            let (name, machine) = split_session_title(&raw_title);
            list.push(PickerItem::RemoteSession {
                id: strval(v, "id"),
                open_pane,
                name: name.to_owned(),
                machine: machine.map(str::to_owned),
                server,
                tool: AgentMark::get(v["tool"].as_str()),
            });
        }

        // In Choose mode, keep already-open remote panes visible only if they aren't
        // represented by a catalogue entry (e.g. while offline or before refresh completes).
        if choose {
            for &(id, _) in &open_ids {
                let pane = self.panes[&id].read(cx);
                if pane.server.is_none() || matched_open_ids.contains(&id) {
                    continue;
                }
                let haystack = format!("{} {}", pane.title, pane.server.as_deref().unwrap_or(""));
                if matches_terms(&haystack, &terms) {
                    list.push(PickerItem::OpenPane(id));
                }
            }
        }

        list
    }

    pub(super) fn activate_picker_item(
        &mut self,
        index: usize,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = self.picker_items(cx);
        let Some(item) = items.get(index).or_else(|| items.first()) else {
            return;
        };
        match item {
            PickerItem::OpenPane(id) => self.select(*id, w, cx),
            PickerItem::RemoteSession {
                open_pane: Some(pane_id),
                ..
            } if self.split_at.is_none() => self.select(*pane_id, w, cx),
            PickerItem::RemoteSession { id, .. } => self.choose(id.clone()),
        }
    }

    pub(super) fn step_picker(&mut self, delta: isize, cx: &mut Context<Self>) {
        let entries = self.picker_items(cx);
        let count = entries.len();
        if count == 0 {
            self.picker.index = 0;
            return;
        }
        let current = self.picker.index.min(count - 1) as isize;
        self.picker.index = (current + delta).rem_euclid(count as isize) as usize;
        let child_ix = picker_child_index(&entries, self.page == Page::Choose, self.picker.index);
        self.picker.scroll.scroll_to_item(child_ix);
        cx.notify();
    }

    pub(super) fn picker_overlay(&self, cx: &Context<Self>) -> Option<AnyElement> {
        if !matches!(self.page, Page::Choose | Page::Switch) {
            return None;
        }
        let choose = self.page == Page::Choose;
        let entries = self.picker_items(cx);
        let total_sessions = entries.len();
        let selected = self.picker.index.min(total_sessions.saturating_sub(1));
        let active_pane_id = self.tabs.get(self.current).map(|t| t.active);
        let can_create = !self.creatable_accounts().is_empty();
        let has_accounts = !items(&self.accounts["accounts"]).is_empty();

        let heading = if choose {
            match self.split_at {
                Some((_, Axis::Across)) => "Split right with Outpost session",
                Some((_, Axis::Down)) => "Split down with Outpost session",
                None => "Outpost sessions",
            }
        } else {
            "Switch session"
        };

        let header = row()
            .w_full()
            .justify_between()
            .px(px(14.))
            .py(px(11.))
            .border_b_1()
            .border_color(rgb(0x222222))
            .child(
                row()
                    .gap(px(8.))
                    .child(
                        lucide_icon(if choose {
                            LucideIcon::Server
                        } else {
                            LucideIcon::Search
                        })
                        .size(px(14.))
                        .text_color(rgb(MUTED)),
                    )
                    .child(text(heading, 13.5, 0xf5f5f5).font_weight(FontWeight::SEMIBOLD)),
            )
            .child(
                row()
                    .gap(px(6.))
                    .when(choose, |r| {
                        r.child(header_action(
                            "picker-refresh",
                            LucideIcon::RefreshCw,
                            "Refresh",
                            self.picker.refreshing,
                            cx,
                            |s, _, cx| {
                                s.picker.refreshing = true;
                                s.call(json!({"op":"refresh"}));
                                cx.notify();
                            },
                        ))
                        .when(can_create, |r| {
                            r.child(header_action(
                                "picker-new-session",
                                LucideIcon::Plus,
                                "New session",
                                false,
                                cx,
                                |s, w, cx| s.open_create_session(w, cx),
                            ))
                        })
                    })
                    .child(
                        div()
                            .id("picker-close")
                            .role(gpui::accesskit::Role::Button)
                            .aria_label("Close")
                            .focusable()
                            .tab_stop(true)
                            .focus_visible(|s| s.bg(rgb(0x353535)))
                            .size(px(26.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(5.))
                            .cursor_pointer()
                            .text_color(rgb(MUTED))
                            .hover(|s| s.bg(rgb(0x242424)).text_color(rgb(0xffffff)))
                            .tooltip(|w, cx| Tooltip::text("Close (Esc)", w, cx))
                            .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
                            .on_click(cx.listener(|s, _, w, cx| s.dismiss_page(w, cx)))
                            .child(lucide_icon(LucideIcon::X).size(px(14.))),
                    ),
            );

        let search_bar = div()
            .w_full()
            .px(px(14.))
            .pt(px(12.))
            .pb(px(8.))
            .child(
                input(&self.picker.query)
                    .w_full()
                    .h(px(36.))
                    .text_size(px(13.))
                    .bg(rgb(0x090909))
                    .border_color(rgb(0x2e2e2e))
                    .rounded(px(7.)),
            );

        let status_text = if choose && self.picker.refreshing {
            if total_sessions > 0 {
                format!(
                    "Refreshing… · {total_sessions} {}",
                    if total_sessions == 1 {
                        "session"
                    } else {
                        "sessions"
                    }
                )
            } else {
                "Loading sessions…".into()
            }
        } else if total_sessions > 0 {
            let noun = if choose {
                if total_sessions == 1 {
                    "session"
                } else {
                    "sessions"
                }
            } else if total_sessions == 1 {
                "result"
            } else {
                "results"
            };
            format!("{total_sessions} {noun}")
        } else {
            String::new()
        };

        let mut list = col()
            .id("picker-results")
            .track_scroll(&self.picker.scroll)
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(10.))
            .pb(px(10.))
            .gap(px(2.));

        let mut showed_open_heading = false;
        let mut showed_remote_heading = false;
        let has_both_groups = !choose
            && entries.iter().any(|e| matches!(e, PickerItem::OpenPane(_)))
            && entries
                .iter()
                .any(|e| matches!(e, PickerItem::RemoteSession { .. }));

        for (idx, item) in entries.iter().enumerate() {
            let is_selected = idx == selected;
            match item {
                PickerItem::OpenPane(id) => {
                    if has_both_groups && !showed_open_heading {
                        showed_open_heading = true;
                        list = list.child(section_label("OPEN", px(4.)));
                    }
                    let id = *id;
                    let pane = self.panes[&id].read(cx);
                    let subtitle = pane
                        .server
                        .as_deref()
                        .map(display_server)
                        .unwrap_or("Local terminal")
                        .to_owned();
                    let leading = pane.mark.map_or_else(
                        || {
                            lucide_icon(LucideIcon::Terminal)
                                .size(px(14.))
                                .text_color(rgb(MUTED))
                                .into_any_element()
                        },
                        |mark| mark.icon(15.).into_any_element(),
                    );
                    let badge = (active_pane_id == Some(id)).then(|| {
                        div()
                            .flex_none()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .bg(rgb(0x2a2a2a))
                            .text_size(px(10.5))
                            .text_color(rgb(0xc8c8c8))
                            .child("Active")
                            .into_any_element()
                    });
                    let status = panes::status_badge(pane, px(15.));
                    let indent = if status.is_some() { px(45.) } else { px(22.) };
                    list = list.child(picker_row(
                        idx,
                        is_selected,
                        leading,
                        status,
                        pane.title.clone(),
                        subtitle,
                        indent,
                        badge,
                        cx.listener(move |s, _, w, cx| s.select(id, w, cx)),
                    ));
                }
                PickerItem::RemoteSession {
                    id,
                    open_pane,
                    name,
                    machine,
                    server,
                    tool,
                } => {
                    if has_both_groups && !showed_remote_heading {
                        showed_remote_heading = true;
                        list = list.child(section_label("OUTPOST SESSIONS", px(10.)));
                    }
                    let id = id.clone();
                    let open_pane = *open_pane;
                    let host = display_server(server);
                    let subtitle = match machine {
                        Some(m) => format!("{m} · {host}"),
                        None => host.to_owned(),
                    };
                    let leading = tool.map_or_else(
                        || {
                            lucide_icon(LucideIcon::Terminal)
                                .size(px(14.))
                                .text_color(rgb(MUTED))
                                .into_any_element()
                        },
                        |mark| mark.icon(15.).into_any_element(),
                    );
                    let badge = open_pane.map(|_| {
                        row()
                            .flex_none()
                            .gap(px(5.))
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .bg(rgb(0x1d2a22))
                            .child(div().size(px(5.)).rounded_full().bg(rgb(0x4ade80)))
                            .child(text("Open", 10.5, 0x86efac))
                            .into_any_element()
                    });
                    list = list.child(picker_row(
                        idx,
                        is_selected,
                        leading,
                        None,
                        name.clone(),
                        subtitle,
                        px(23.),
                        badge,
                        cx.listener(move |s, _, w, cx| {
                            if let Some(pane_id) = open_pane
                                && s.split_at.is_none()
                            {
                                s.select(pane_id, w, cx);
                            } else {
                                s.choose(id.clone());
                            }
                        }),
                    ));
                }
            }
        }

        if total_sessions == 0 && !(choose && self.picker.refreshing) {
            let empty_msg = if !self.picker.query.read(cx).value().trim().is_empty() {
                "No matching sessions."
            } else if choose && !has_accounts {
                "No Outpost servers connected yet."
            } else if choose {
                "No sessions on your connected servers yet."
            } else {
                "No open sessions yet."
            };
            list = list.child(
                col()
                    .w_full()
                    .items_center()
                    .justify_center()
                    .py(px(36.))
                    .gap(px(10.))
                    .child(text(empty_msg, 12.5, 0x888888))
                    .when(choose && !has_accounts, |c| {
                        c.child(control("Connect a server", true, cx, |s, w, cx| {
                            s.split_at = None;
                            s.show(Page::Home, w, cx);
                            s.address.read(cx).focus_handle(cx).focus(w, cx);
                        }))
                    }),
            );
        }

        let footer = row()
            .w_full()
            .justify_between()
            .px(px(14.))
            .py(px(9.))
            .border_t_1()
            .border_color(rgb(0x222222))
            .bg(rgb(0x0e0e0e))
            .child(
                row()
                    .gap(px(10.))
                    .child(
                        row()
                            .gap(px(4.))
                            .child(keycap_icon(LucideIcon::ArrowUp))
                            .child(keycap_icon(LucideIcon::ArrowDown))
                            .child(text("Choose", 11.5, 0x888888)),
                    )
                    .child(
                        row()
                            .gap(px(4.))
                            .child(keycap_icon(LucideIcon::CornerDownLeft))
                            .child(text(
                                if choose { "Connect" } else { "Switch" },
                                11.5,
                                0x888888,
                            )),
                    )
                    .child(
                        row()
                            .gap(px(4.))
                            .child(kbd("Esc").bg(rgb(0x161616)))
                            .child(text("Cancel", 11.5, 0x888888)),
                    ),
            )
            .when(choose, |r| {
                r.child(
                    div()
                        .id("picker-connect-server")
                        .role(gpui::accesskit::Role::Button)
                        .focusable()
                        .tab_stop(true)
                        .focus_visible(|s| s.bg(rgb(0x282828)))
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(5.))
                        .px(px(6.))
                        .py(px(3.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .text_size(px(11.5))
                        .text_color(rgb(MUTED))
                        .hover(|s| s.bg(rgb(0x202020)).text_color(rgb(0xffffff)))
                        .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
                        .on_click(cx.listener(|s, _, w, cx| {
                            s.split_at = None;
                            s.show(Page::Home, w, cx);
                            s.address.read(cx).focus_handle(cx).focus(w, cx);
                        }))
                        .child(lucide_icon(LucideIcon::Server).size(px(12.)))
                        .child("Connect server"),
                )
            });

        let card = col()
            .id("session-picker-card")
            .occlude()
            .w(px(520.))
            .max_w(relative(0.92))
            .max_h(px(460.))
            .rounded(px(10.))
            .bg(rgb(0x111111))
            .border_1()
            .border_color(rgb(0x2e2e2e))
            .shadow_lg()
            .overflow_hidden()
            .on_any_mouse_down(|_, _, cx| cx.stop_propagation())
            .child(header)
            .child(search_bar)
            .when(!status_text.is_empty(), |c| {
                c.child(
                    div()
                        .px(px(16.))
                        .pb(px(6.))
                        .text_size(px(11.5))
                        .text_color(rgb(0x7a7a7a))
                        .child(status_text),
                )
            })
            .child(list)
            .child(footer);

        Some(
            div()
                .id("session-picker-backdrop")
                .occlude()
                .absolute()
                .inset_0()
                .flex()
                .items_start()
                .justify_center()
                .pt(px(56.))
                .bg(rgba(0x00000080))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|s, _, w, cx| s.dismiss_page(w, cx)),
                )
                .child(card)
                .into_any_element(),
        )
    }
}

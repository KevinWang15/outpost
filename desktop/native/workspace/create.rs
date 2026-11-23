use super::*;

pub(super) const HARNESSES: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("kimi", "Kimi Code", "kimi"),
    ("deepseek", "DeepSeek Harness", "dsh"),
    ("antigravity", "Antigravity CLI", "agy"),
];

pub(super) fn harness_label(id: &str) -> &str {
    HARNESSES
        .iter()
        .find_map(|&(key, label, _)| (key == id).then_some(label))
        .unwrap_or(id)
}

fn server_key(origin: &str, account_id: &str) -> String {
    format!("{origin}\0{account_id}")
}

fn parse_server_key(key: &str) -> Option<(String, String)> {
    let (origin, account_id) = key.split_once('\0')?;
    Some((origin.to_owned(), account_id.to_owned()))
}

fn create_card() -> Div {
    col()
        .w_full()
        .rounded(px(10.))
        .bg(rgb(0x131313))
        .border_1()
        .border_color(rgb(0x252525))
}

fn card_divider() -> Div {
    div().w_full().h(px(1.)).bg(rgb(0x202020))
}

fn field_label(label: &'static str) -> Div {
    div()
        .text_size(px(12.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(0xd4d4d4))
        .child(label)
}

fn subtle_action(
    id: impl Into<ElementId>,
    symbol: LucideIcon,
    label: &'static str,
    trailing: bool,
    cx: &Context<Workspace>,
    action: impl Fn(&mut Workspace, &mut Window, &mut Context<Workspace>) + 'static,
) -> Stateful<Div> {
    let glyph = lucide_icon(symbol).size(px(12.));
    let base = div()
        .id(id)
        .role(gpui::accesskit::Role::Button)
        .focusable()
        .tab_stop(true)
        .focus_visible(|s| s.border_color(rgb(0x888888)))
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(5.))
        .px(px(8.))
        .py(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(rgb(0x262626))
        .bg(rgb(0x171717))
        .text_size(px(11.5))
        .text_color(rgb(0xb8b8b8))
        .cursor_pointer()
        .hover(|s| {
            s.bg(rgb(0x222222))
                .border_color(rgb(0x3c3c3c))
                .text_color(rgb(0xffffff))
        })
        .on_click(cx.listener(move |s, _, w, cx| action(s, w, cx)));
    if trailing {
        base.child(label).child(glyph)
    } else {
        base.child(glyph).child(label)
    }
}

fn styled_select<T: Clone + PartialEq + 'static>(state: &Entity<ComboBoxState<T>>) -> ComboBox<T> {
    combo_box(state).rounded(px(8.))
}

pub(super) struct CreateForm {
    server_select: Entity<ComboBoxState<String>>,
    machine_select: Entity<ComboBoxState<String>>,
    tool_select: Entity<ComboBoxState<String>>,
    _subscriptions: [Subscription; 3],
}

impl CreateForm {
    pub(super) fn new(cx: &mut Context<Workspace>) -> Self {
        let server_select = cx.new(|cx| {
            ComboBoxState::new(Vec::new(), cx)
                .placeholder("Search or select a server…")
                .empty_message("No matching servers.")
                .clearable(false)
                .disabled(true)
        });
        let server_sub = cx.subscribe(
            &server_select,
            |s: &mut Workspace, _, event: &ComboBoxEvent<String>, cx| {
                if let ComboBoxEvent::Change(values) = event
                    && let Some(key) = values.first()
                    && let Some((origin, account_id)) = parse_server_key(key)
                    && (s.origin != origin || s.account_id != account_id)
                {
                    s.switch_create_server(origin, account_id, cx);
                }
            },
        );

        let machine_select = cx.new(|cx| {
            ComboBoxState::new(Vec::new(), cx)
                .placeholder("Loading machines…")
                .empty_message("No matching machines.")
                .clearable(false)
                .disabled(true)
        });
        let machine_sub = cx.subscribe(
            &machine_select,
            |s: &mut Workspace, _, event: &ComboBoxEvent<String>, cx| {
                if let ComboBoxEvent::Change(values) = event
                    && let Some(id) = values.first()
                    && s.target != *id
                {
                    s.select_target(id.clone(), cx);
                    cx.notify();
                }
            },
        );

        let tool_select = cx.new(|cx| {
            ComboBoxState::new(Vec::new(), cx)
                .placeholder("Select a machine first")
                .empty_message("No matching coding tools.")
                .clearable(false)
                .disabled(true)
        });
        let tool_sub = cx.subscribe(
            &tool_select,
            |s: &mut Workspace, _, event: &ComboBoxEvent<String>, cx| {
                if let ComboBoxEvent::Change(values) = event {
                    let next = values.first().cloned().unwrap_or_default();
                    if s.tool != next {
                        s.tool = next;
                        cx.notify();
                    }
                }
            },
        );

        Self {
            server_select,
            machine_select,
            tool_select,
            _subscriptions: [server_sub, machine_sub, tool_sub],
        }
    }

    pub(super) fn any_open(&self, cx: &App) -> bool {
        self.server_select.read(cx).is_open()
            || self.machine_select.read(cx).is_open()
            || self.tool_select.read(cx).is_open()
    }

    pub(super) fn any_focused(&self, w: &Window, cx: &App) -> bool {
        self.server_select.focus_handle(cx).is_focused(w)
            || self.machine_select.focus_handle(cx).is_focused(w)
            || self.tool_select.focus_handle(cx).is_focused(w)
    }

    pub(super) fn close_all(&self, cx: &mut App) {
        self.server_select.update(cx, |s, cx| s.close_menu(cx));
        self.machine_select.update(cx, |s, cx| s.close_menu(cx));
        self.tool_select.update(cx, |s, cx| s.close_menu(cx));
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn select_tool(&self, id: &str, cx: &mut App) {
        let value = id.to_owned();
        self.tool_select
            .update(cx, |s, cx| s.select_value(value, cx));
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn open_tool_menu(&self, w: &mut Window, cx: &mut App) {
        self.tool_select.update(cx, |s, cx| s.open_menu(w, cx));
    }
}

fn tool_option(id: &str, label: &str, cmd: &str, available: bool) -> ComboBoxOption<String> {
    let mut opt = ComboBoxOption::new(id.to_owned(), label.to_owned()).keywords([id, cmd]);
    if let Some(mark) = AgentMark::get(Some(id)) {
        opt = opt.leading(move |_, _| mark.icon(15.));
    } else {
        opt = opt.icon(if available {
            LucideIcon::Terminal
        } else {
            LucideIcon::Download
        });
    }
    if available {
        opt.group("Available")
    } else {
        opt.description("Not installed — set up on machine page")
            .group("Not installed")
            .disabled(true)
    }
}

impl Workspace {
    pub(super) fn sync_server_select(&mut self, cx: &mut Context<Self>) {
        let servers = self.creatable_accounts();
        let options: Vec<ComboBoxOption<String>> = servers
            .iter()
            .map(|(origin, account_id)| {
                let display = picker::display_server(origin).to_owned();
                let mut opt = ComboBoxOption::new(server_key(origin, account_id), display)
                    .icon(LucideIcon::Globe)
                    .keywords([origin.as_str()]);
                if origin != picker::display_server(origin) {
                    opt = opt.description(origin.clone());
                }
                opt
            })
            .collect();
        let selected = (!self.origin.is_empty())
            .then(|| server_key(&self.origin, &self.account_id));
        let disabled = options.is_empty();
        self.create.server_select.update(cx, |cb, cx| {
            cb.set_options(options, cx);
            cb.set_values_silent(selected, cx);
            cb.set_disabled(disabled, cx);
        });
    }

    pub(super) fn sync_machine_select(&mut self, cx: &mut Context<Self>) {
        let loading = self.targets.is_null() && self.message.is_empty();
        let target_list = items(&self.targets);
        let options: Vec<ComboBoxOption<String>> = target_list
            .iter()
            .map(|t| {
                let id = strval(t, "id");
                let name = strval(t, "name");
                ComboBoxOption::new(id, name).icon(LucideIcon::Server)
            })
            .collect();
        let selected = (!self.target.is_empty()).then(|| self.target.clone());
        let placeholder = if loading {
            "Loading machines…"
        } else if options.is_empty() {
            "No machines available"
        } else {
            "Search or select a machine…"
        };
        let disabled = loading || options.is_empty();
        self.create.machine_select.update(cx, |cb, cx| {
            cb.set_options(options, cx);
            cb.set_values_silent(selected, cx);
            cb.set_placeholder(placeholder, cx);
            cb.set_disabled(disabled, cx);
        });
    }

    pub(super) fn sync_tool_select(&mut self, cx: &mut Context<Self>) {
        let checking = !self.target.is_empty() && self.options.is_null() && self.message.is_empty();
        let failed = !self.target.is_empty() && self.options.is_null() && !self.message.is_empty();
        let available_ids: Vec<&str> = items(&self.options["tools"])
            .iter()
            .filter_map(Value::as_str)
            .collect();

        let mut options = Vec::new();
        if self.options.is_object() {
            for &id in &available_ids {
                let cmd = HARNESSES
                    .iter()
                    .find_map(|&(key, _, c)| (key == id).then_some(c))
                    .unwrap_or(id);
                options.push(tool_option(id, harness_label(id), cmd, true));
            }
            for &(id, label, cmd) in HARNESSES {
                if !available_ids.contains(&id) {
                    options.push(tool_option(id, label, cmd, false));
                }
            }
        }

        let selected = (!self.tool.is_empty() && available_ids.contains(&self.tool.as_str()))
            .then(|| self.tool.clone());
        let placeholder = if self.target.is_empty() {
            "Select a machine first"
        } else if checking {
            "Checking installed coding tools…"
        } else if failed {
            "Could not check coding tools"
        } else if available_ids.is_empty() {
            "No coding tools installed"
        } else {
            "Search or select a coding tool…"
        };
        let disabled = self.target.is_empty() || checking || failed || options.is_empty();

        self.create.tool_select.update(cx, |cb, cx| {
            cb.set_options(options, cx);
            cb.set_values_silent(selected, cx);
            cb.set_placeholder(placeholder, cx);
            cb.set_disabled(disabled, cx);
        });
    }

    pub(super) fn switch_create_server(
        &mut self,
        origin: String,
        account_id: String,
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
        self.message.clear();
        self.sync_server_select(cx);
        self.sync_machine_select(cx);
        self.sync_tool_select(cx);
        self.call(json!({"op":"targets","origin":self.origin,"accountId":self.account_id}));
        cx.notify();
    }

    pub(super) fn create_view(&self, cx: &Context<Self>) -> Div {
        let servers = self.creatable_accounts();
        let target_list = items(&self.targets);
        let missing: Vec<&str> = items(&self.options["missing"])
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let available_tools: Vec<&str> = items(&self.options["tools"])
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let unavailable_count = HARNESSES
            .iter()
            .filter(|&&(id, _, _)| !available_tools.contains(&id))
            .count();

        let header = col()
            .gap(px(4.))
            .child(text("MANAGED SESSIONS", 10., 0x808080).font_weight(FontWeight::SEMIBOLD))
            .child(text("New session", 26., 0xfafafa).font_weight(FontWeight::SEMIBOLD))
            .child(text(
                "Choose a machine and coding tool. Sessions keep running on the machine when you close Outpost.",
                12.5,
                0x888888,
            ));

        // Card 1: Destination (Server, Machine, Coding tool — all searchable selects)
        let mut target_card = create_card();
        if servers.len() > 1 {
            target_card = target_card
                .child(
                    col()
                        .gap(px(7.))
                        .p(px(16.))
                        .child(field_label("Server"))
                        .child(styled_select(&self.create.server_select)),
                )
                .child(card_divider());
        } else if !self.origin.is_empty() {
            target_card = target_card
                .child(
                    row()
                        .px(px(16.))
                        .py(px(10.))
                        .gap(px(8.))
                        .child(
                            lucide_icon(LucideIcon::Globe)
                                .size(px(13.))
                                .text_color(rgb(0x7c7c7c)),
                        )
                        .child(text(
                            picker::display_server(&self.origin).to_owned(),
                            12.,
                            0x9a9a9a,
                        )),
                )
                .child(card_divider());
        }

        let machine_section = {
            let mut body = col().gap(px(7.)).p(px(16.));
            let mut label_row = row()
                .w_full()
                .justify_between()
                .child(field_label("Machine"));
            if !self.origin.is_empty() && !target_list.is_empty() {
                let url = format!("{}/?add=1", self.origin);
                label_row = label_row.child(subtle_action(
                    "add-machine-link",
                    LucideIcon::ExternalLink,
                    "Add machine",
                    true,
                    cx,
                    move |_, _, cx| cx.open_url(&url),
                ));
            }
            body = body.child(label_row);

            if self.targets.is_array() && target_list.is_empty() {
                let url = format!("{}/?add=1", self.origin);
                body = body.child(
                    row()
                        .w_full()
                        .justify_between()
                        .gap(px(12.))
                        .p(px(12.))
                        .rounded(px(8.))
                        .bg(rgb(0x181818))
                        .border_1()
                        .border_color(rgb(0x2a2a2a))
                        .child(text(
                            "No machines on this account yet.",
                            12.5,
                            0xb0b0b0,
                        ))
                        .child(control_with_icon(
                            "Add a machine",
                            LucideIcon::ExternalLink,
                            true,
                            false,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        )),
                );
            } else {
                body = body.child(styled_select(&self.create.machine_select));
            }
            body
        };

        let tool_section = {
            let mut body = col().gap(px(8.)).p(px(16.));
            let mut label_row = row().w_full().justify_between().child(
                row()
                    .gap(px(8.))
                    .child(field_label("Coding tool"))
                    .when(!self.tool.is_empty() && missing.is_empty(), |r| {
                        r.child(
                            row()
                                .gap(px(5.))
                                .px(px(7.))
                                .py(px(2.))
                                .rounded(px(999.))
                                .bg(rgb(0x13261b))
                                .border_1()
                                .border_color(rgb(0x1f4731))
                                .child(div().size(px(6.)).rounded_full().bg(rgb(0x4ade80)))
                                .child(text("Available", 11., 0x4ade80)),
                        )
                    }),
            );
            if !self.target.is_empty() {
                let target_id = self.target.clone();
                let url = format!("{}/?target={}", self.origin, self.target);
                label_row = label_row.child(
                    row()
                        .gap(px(6.))
                        .child(subtle_action(
                            "recheck-tools",
                            LucideIcon::RefreshCw,
                            "Recheck",
                            false,
                            cx,
                            move |s, _, cx| {
                                s.select_target(target_id.clone(), cx);
                                cx.notify();
                            },
                        ))
                        .child(subtle_action(
                            "manage-tools-link",
                            LucideIcon::ExternalLink,
                            "Set up tools",
                            true,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        )),
                );
            }
            body = body
                .child(label_row)
                .child(styled_select(&self.create.tool_select));

            if !missing.is_empty() {
                let url = format!("{}/?target={}", self.origin, self.target);
                body = body.child(
                    row()
                        .w_full()
                        .justify_between()
                        .gap(px(12.))
                        .p(px(10.))
                        .rounded(px(8.))
                        .bg(rgb(0x1f190e))
                        .border_1()
                        .border_color(rgb(0x4a3816))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .text_color(rgb(0xfcd34d))
                                .child(format!(
                                    "Set up {} on this machine before creating a session.",
                                    missing.join(", ")
                                )),
                        )
                        .child(subtle_action(
                            "open-machine-missing",
                            LucideIcon::ExternalLink,
                            "Open machine",
                            true,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        )),
                );
            } else if self.options.is_object() && available_tools.is_empty() {
                let url = format!("{}/?target={}", self.origin, self.target);
                body = body.child(
                    row()
                        .w_full()
                        .justify_between()
                        .gap(px(12.))
                        .p(px(10.))
                        .rounded(px(8.))
                        .bg(rgb(0x1f190e))
                        .border_1()
                        .border_color(rgb(0x4a3816))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .text_size(px(12.))
                                .text_color(rgb(0xfcd34d))
                                .child("No coding tools detected on this machine yet. Set one up from its machine page."),
                        )
                        .child(subtle_action(
                            "open-machine-empty",
                            LucideIcon::ExternalLink,
                            "Open machine",
                            true,
                            cx,
                            move |_, _, cx| cx.open_url(&url),
                        )),
                );
            } else if self.options.is_object() && unavailable_count > 0 {
                body = body.child(text(
                    format!(
                        "{} of {} coding tools available on this machine. Unavailable tools can be installed via Set up tools.",
                        available_tools.len(),
                        HARNESSES.len()
                    ),
                    11.5,
                    0x7e7e7e,
                ));
            }
            body
        };

        target_card = target_card
            .child(machine_section)
            .child(card_divider())
            .child(tool_section);

        // Card 2: Session details
        let details_card = create_card()
            .child(
                col()
                    .gap(px(7.))
                    .p(px(16.))
                    .child(field_label("Session name"))
                    .child(field(&self.name)),
            )
            .child(card_divider())
            .child(
                col()
                    .gap(px(7.))
                    .p(px(16.))
                    .child(field_label("Working directory"))
                    .child(field(&self.directory))
                    .child(text(
                        "Absolute path or ~/… on the selected machine.",
                        11.5,
                        0x7e7e7e,
                    )),
            );

        // Action bar
        let disabled_reason = if self.creating {
            Some("Creating session…")
        } else if self.targets.is_null() && self.message.is_empty() {
            Some("Loading machines…")
        } else if self.target.is_empty() {
            Some("Select a machine to continue.")
        } else if self.options.is_null() && self.message.is_empty() {
            Some("Checking installed coding tools…")
        } else if !missing.is_empty() {
            Some("Set up machine software first.")
        } else if self.tool.is_empty() {
            Some("Install a coding tool on this machine first.")
        } else {
            None
        };

        let footer = row()
            .mt(px(6.))
            .gap(px(12.))
            .child(
                Button::new("create-session")
                    .label(if self.creating {
                        "Creating…"
                    } else {
                        "Create and open"
                    })
                    .primary()
                    .disabled(!self.creation_ready())
                    .on_click(cx.listener(|s, _, w, cx| s.submit(w, cx))),
            )
            .when_some(disabled_reason, |r, reason| {
                r.child(text(reason, 12., 0x808080))
            });

        col()
            .w_full()
            .gap(px(16.))
            .child(header)
            .child(target_card)
            .child(details_card)
            .child(footer)
    }
}

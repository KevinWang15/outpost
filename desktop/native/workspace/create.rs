use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

pub(super) const HARNESSES: &[(&str, &str, &str)] = &[
    ("claude", "Claude Code", "claude"),
    ("codex", "Codex", "codex"),
    ("kimi", "Kimi Code", "kimi"),
    ("deepseek", "DeepSeek Harness", "dsh"),
    ("antigravity", "Antigravity CLI", "agy"),
];

const MAX_ENV_VARS: usize = 32;
const MAX_ARGS_LEN: usize = 8192;
const MAX_ENV_KEY_LEN: usize = 128;
const MAX_ENV_VAL_LEN: usize = 4096;

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

fn valid_remote_dir_query(path: &str) -> bool {
    (path.is_empty() || path == "~" || path.starts_with("~/") || path.starts_with('/'))
        && !path.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
}

fn valid_root_dir(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && (path.starts_with("~/") || path.starts_with('/'))
        && !path.chars().any(|c| (c as u32) < 32 || c as u32 == 127)
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    name.len() <= MAX_ENV_KEY_LEN
        && (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
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
        .px(px(9.))
        .py(px(4.))
        .rounded(px(7.))
        .border_1()
        .border_color(rgb(0x2e2e2e))
        .bg(rgb(0x161616))
        .text_size(px(11.5))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgb(0xd4d4d4))
        .cursor_pointer()
        .hover(|s| {
            s.bg(rgb(0x242424))
                .border_color(rgb(0x454545))
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

fn mono_field(state: &Entity<InputState>) -> Input {
    field(state)
        .font_family(crate::terminal::FAMILY)
        .text_size(px(12.5))
}

struct EnvRow {
    id: u64,
    name: Entity<InputState>,
    value: Entity<InputState>,
}

type DirReply = async_channel::Sender<Result<PathSuggestions, SharedString>>;

pub(super) struct CreateForm {
    server_select: Entity<ComboBoxState<String>>,
    machine_select: Entity<ComboBoxState<String>>,
    tool_select: Entity<ComboBoxState<String>>,
    directory: Entity<PathInputState>,
    pending_dirs: Rc<RefCell<HashMap<u64, DirReply>>>,
    create_directory: bool,
    launch_open: bool,
    args: Entity<InputState>,
    env_rows: Vec<EnvRow>,
    next_env_id: u64,
    _subscriptions: [Subscription; 4],
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

        let pending_dirs: Rc<RefCell<HashMap<u64, DirReply>>> =
            Rc::new(RefCell::new(HashMap::new()));
        let dir_req_seq = Cell::new(0u64);
        let weak = cx.entity().downgrade();
        let pending_for_loader = pending_dirs.clone();
        let dir_source = PathSource::async_loader(move |prefix, cx| {
            let prefix = prefix.to_owned();
            let req_id = dir_req_seq.get().wrapping_add(1);
            dir_req_seq.set(req_id);
            let (tx, rx) = async_channel::bounded(1);
            pending_for_loader.borrow_mut().insert(req_id, tx);
            let dispatched = weak
                .upgrade()
                .map(|entity| {
                    let s = entity.read(cx);
                    if s.origin.is_empty()
                        || s.account_id.is_empty()
                        || s.target.is_empty()
                        || s.bridge.is_none()
                    {
                        return false;
                    }
                    s.call(json!({
                        "op": "directories",
                        "id": req_id,
                        "origin": s.origin,
                        "accountId": s.account_id,
                        "target": s.target,
                        "path": prefix,
                    }));
                    true
                })
                .unwrap_or(false);
            let pending_cleanup = pending_for_loader.clone();
            cx.foreground_executor().spawn(async move {
                if !dispatched {
                    pending_cleanup.borrow_mut().remove(&req_id);
                    return Ok(PathSuggestions::empty());
                }
                let result = rx.recv().await.unwrap_or_else(|_| Ok(PathSuggestions::empty()));
                pending_cleanup.borrow_mut().remove(&req_id);
                result
            })
        })
        .debounce(Duration::from_millis(220));

        let directory = cx.new(|cx| {
            PathInputState::new(dir_source, cx)
                .placeholder("~/dev/project or /path/to/project")
                .loading_message("Looking up directories on the machine…")
                .empty_message(Some(
                    "No matching directories. You can still enter a new path.".into(),
                ))
                .truncated_message("Showing first 50 matches. Keep typing to narrow.")
                .hint_message(Some(
                    "↑/↓ and Enter to select · Tab completes a match or prefix".into(),
                ))
                .query_filter(valid_remote_dir_query)
                .disabled(true)
        });
        let dir_sub = cx.subscribe(
            &directory,
            |s: &mut Workspace, _, event: &PathInputEvent, cx| {
                if matches!(event, PathInputEvent::Submit(_)) && s.page == Page::Create {
                    s.submit_create(cx);
                }
            },
        );

        let args = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("--verbose")
                .max_length(MAX_ARGS_LEN)
        });

        Self {
            server_select,
            machine_select,
            tool_select,
            directory,
            pending_dirs,
            create_directory: false,
            launch_open: false,
            args,
            env_rows: Vec::new(),
            next_env_id: 1,
            _subscriptions: [server_sub, machine_sub, tool_sub, dir_sub],
        }
    }

    pub(super) fn any_open(&self, cx: &App) -> bool {
        self.server_select.read(cx).is_open()
            || self.machine_select.read(cx).is_open()
            || self.tool_select.read(cx).is_open()
            || self.directory.read(cx).is_open()
    }

    pub(super) fn any_focused(&self, w: &Window, cx: &App) -> bool {
        self.server_select.focus_handle(cx).is_focused(w)
            || self.machine_select.focus_handle(cx).is_focused(w)
            || self.tool_select.focus_handle(cx).is_focused(w)
            || self.directory.focus_handle(cx).is_focused(w)
    }

    pub(super) fn close_all(&self, cx: &mut App) {
        self.server_select.update(cx, |s, cx| s.close_menu(cx));
        self.machine_select.update(cx, |s, cx| s.close_menu(cx));
        self.tool_select.update(cx, |s, cx| s.close_menu(cx));
        self.directory
            .update(cx, |s, cx| s.close_suggestions(cx));
    }

    pub(super) fn cancel_directory_lookups(&self, disabled: bool, cx: &mut App) {
        self.pending_dirs.borrow_mut().clear();
        self.directory.update(cx, |dir, cx| {
            dir.close_suggestions(cx);
            dir.set_disabled(disabled, cx);
        });
    }

    fn reset_inputs(&mut self, cx: &mut App) {
        self.directory
            .update(cx, |d, cx| d.set_value_silent("", cx));
        self.args.update(cx, |a, cx| a.set_value_silent("", cx));
        self.create_directory = false;
        self.launch_open = false;
        self.env_rows.clear();
    }

    fn add_env_row(&mut self, cx: &mut Context<Workspace>) {
        if self.env_rows.len() >= MAX_ENV_VARS {
            return;
        }
        let id = self.next_env_id;
        self.next_env_id += 1;
        let name = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("NAME")
                .max_length(MAX_ENV_KEY_LEN)
        });
        let value = cx.new(|cx| {
            InputState::new(cx)
                .placeholder("value")
                .max_length(MAX_ENV_VAL_LEN)
        });
        self.env_rows.push(EnvRow { id, name, value });
        self.launch_open = true;
    }

    fn remove_env_row(&mut self, id: u64) {
        self.env_rows.retain(|row| row.id != id);
    }

    fn configured_launch_summary(&self, cx: &App) -> Option<String> {
        let has_args = !self.args.read(cx).value().trim().is_empty();
        let env_count = self
            .env_rows
            .iter()
            .filter(|r| {
                !r.name.read(cx).value().trim().is_empty() || !r.value.read(cx).value().is_empty()
            })
            .count();
        match (has_args, env_count) {
            (false, 0) => None,
            (true, 0) => Some("Custom args".into()),
            (false, n) => Some(format!("{n} env")),
            (true, n) => Some(format!("Custom args · {n} env")),
        }
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

    #[cfg(feature = "ui-tests")]
    pub(super) fn set_directory_silent(&self, value: &str, cx: &mut App) {
        self.directory
            .update(cx, |d, cx| d.set_value_silent(value, cx));
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn open_directory_suggestions(&self, cx: &mut App) {
        self.directory.update(cx, |d, cx| d.open_suggestions(cx));
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn directory_entries(&self, cx: &App) -> Vec<String> {
        self.directory
            .read(cx)
            .entries()
            .iter()
            .map(|e| e.path.to_string())
            .collect()
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn set_args_silent(&self, value: &str, cx: &mut App) {
        self.args.update(cx, |a, cx| a.set_value_silent(value, cx));
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn set_create_directory(&mut self, create: bool) {
        self.create_directory = create;
    }

    #[cfg(feature = "ui-tests")]
    pub(super) fn push_env(&mut self, key: &str, val: &str, cx: &mut Context<Workspace>) {
        self.add_env_row(cx);
        if let Some(row) = self.env_rows.last() {
            row.name.update(cx, |i, cx| i.set_value_silent(key, cx));
            row.value.update(cx, |i, cx| i.set_value_silent(val, cx));
        }
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
    pub(super) fn handle_directory_suggestions(&mut self, e: Value) {
        let Some(req_id) = e["id"].as_u64() else {
            return;
        };
        let Some(tx) = self.create.pending_dirs.borrow_mut().remove(&req_id) else {
            return;
        };
        if self.origin != e["origin"]
            || self.account_id != e["accountId"]
            || self.target != e["target"]
        {
            return;
        }
        let reply = if let Some(err) = e["error"].as_str() {
            Err(SharedString::from(err.to_owned()))
        } else {
            let entries: Vec<PathEntry> = items(&e["directories"])
                .iter()
                .filter_map(Value::as_str)
                .map(PathEntry::dir)
                .collect();
            let truncated = e["truncated"] == true;
            Ok(PathSuggestions::new(entries).truncated(truncated))
        };
        let _ = tx.try_send(reply);
    }

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
        let selected = (!self.origin.is_empty()).then(|| server_key(&self.origin, &self.account_id));
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
            self.create.reset_inputs(cx);
        }
        self.origin = origin;
        self.account_id = account_id;
        self.target.clear();
        self.tool.clear();
        self.targets = Value::Null;
        self.options = Value::Null;
        self.creating = false;
        self.message.clear();
        self.create.cancel_directory_lookups(true, cx);
        self.sync_server_select(cx);
        self.sync_machine_select(cx);
        self.sync_tool_select(cx);
        self.call(json!({"op":"targets","origin":self.origin,"accountId":self.account_id}));
        cx.notify();
    }

    pub(super) fn submit_create(&mut self, cx: &mut Context<Self>) {
        if !self.creation_ready() {
            return;
        }
        let name = self.name.read(cx).value().trim().to_owned();
        let dir = self.create.directory.read(cx).value(cx).trim().to_owned();
        if name.is_empty() || dir.is_empty() {
            self.message = "Enter a session name and working directory.".into();
            cx.notify();
            return;
        }
        if !valid_root_dir(&dir) {
            self.message = "Working directory must be an absolute path or start with ~/.".into();
            cx.notify();
            return;
        }
        let args = self.create.args.read(cx).value().to_owned();
        if args.len() > MAX_ARGS_LEN || args.contains('\0') {
            self.message = "Program arguments exceed the allowed length or contain invalid characters.".into();
            cx.notify();
            return;
        }

        let mut env_map = serde_json::Map::new();
        for row in &self.create.env_rows {
            let key = row.name.read(cx).value().trim().to_owned();
            let val = row.value.read(cx).value().to_owned();
            if key.is_empty() && val.is_empty() {
                continue;
            }
            if !valid_env_name(&key) {
                self.message = format!(
                    "Invalid environment variable name “{key}”. Use letters, digits, and _ (starting with a letter or _)."
                );
                cx.notify();
                return;
            }
            if env_map.contains_key(&key) {
                self.message = format!(
                    "Duplicate environment variable “{key}”. Variable names must be unique."
                );
                cx.notify();
                return;
            }
            if val.len() > MAX_ENV_VAL_LEN || val.contains('\0') {
                self.message = format!(
                    "Environment variable “{key}” value exceeds 4096 characters or contains invalid characters."
                );
                cx.notify();
                return;
            }
            env_map.insert(key, Value::String(val));
        }

        let mut input = serde_json::Map::new();
        input.insert("name".into(), json!(name));
        input.insert("rootDir".into(), json!(dir));
        input.insert("tool".into(), json!(self.tool));
        if self.create.create_directory {
            input.insert("createDirectory".into(), json!(true));
        }
        if !args.trim().is_empty() {
            input.insert("args".into(), json!(args));
        }
        if !env_map.is_empty() {
            input.insert("env".into(), Value::Object(env_map));
        }

        self.creating = true;
        self.message = "Creating session…".into();
        self.call(json!({
            "op": "create",
            "origin": self.origin,
            "accountId": self.account_id,
            "target": self.target,
            "input": Value::Object(input),
        }));
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
        let tool_name = if self.tool.is_empty() {
            "the coding tool"
        } else {
            harness_label(&self.tool)
        };

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

        // Card 2: Session details (Name + live-autocompleting Working directory)
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
                    .gap(px(8.))
                    .p(px(16.))
                    .child(field_label("Working directory"))
                    .child(path_input(&self.create.directory).rounded(px(8.)))
                    .child(
                        row()
                            .w_full()
                            .justify_between()
                            .gap(px(12.))
                            .child(
                                checkbox("create-directory-toggle", self.create.create_directory)
                                    .label("Create directory if it doesn't exist")
                                    .on_change(cx.listener(|s, checked: &bool, _, cx| {
                                        s.create.create_directory = *checked;
                                        cx.notify();
                                    })),
                            )
                            .child(text(
                                "Live machine suggestions · Tab to complete",
                                11.5,
                                0x7e7e7e,
                            )),
                    ),
            );

        // Card 3: Collapsible Launch options (Program arguments & Environment variables)
        let launch_summary = self.create.configured_launch_summary(cx);
        let launch_open = self.create.launch_open;
        let launch_header = div()
            .id("launch-options-toggle")
            .role(gpui::accesskit::Role::Button)
            .focusable()
            .tab_stop(true)
            .focus_visible(|s| s.bg(rgb(0x1b1b1b)))
            .w_full()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(16.))
            .py(px(12.))
            .cursor_pointer()
            .hover(|s| s.bg(rgb(0x181818)))
            .on_click(cx.listener(|s, _, _, cx| {
                s.create.launch_open = !s.create.launch_open;
                cx.notify();
            }))
            .child(
                row()
                    .gap(px(8.))
                    .child(
                        lucide_icon(if launch_open {
                            LucideIcon::ChevronDown
                        } else {
                            LucideIcon::ChevronRight
                        })
                        .size(px(14.))
                        .text_color(rgb(0x888888)),
                    )
                    .child(field_label("Launch options"))
                    .child(text(
                        "Arguments & environment variables",
                        12.,
                        0x7e7e7e,
                    )),
            )
            .when_some(launch_summary, |el, summary| {
                el.child(
                    div()
                        .px(px(7.))
                        .py(px(2.))
                        .rounded(px(999.))
                        .bg(rgb(0x1e1e1e))
                        .border_1()
                        .border_color(rgb(0x2f2f2f))
                        .text_size(px(11.))
                        .text_color(rgb(0xcfcfcf))
                        .child(summary),
                )
            });

        let mut launch_card = create_card().child(launch_header);
        if launch_open {
            let mut env_section = col()
                .gap(px(8.))
                .p(px(16.))
                .child(
                    row()
                        .w_full()
                        .justify_between()
                        .child(field_label("Environment variables"))
                        .child(text(
                            format!("{} / {MAX_ENV_VARS}", self.create.env_rows.len()),
                            11.5,
                            0x7e7e7e,
                        )),
                );

            for env_row in &self.create.env_rows {
                let row_id = env_row.id;
                env_section = env_section.child(
                    row()
                        .w_full()
                        .gap(px(8.))
                        .child(div().w(px(190.)).flex_none().child(mono_field(&env_row.name)))
                        .child(text("=", 13., 0x6e6e6e))
                        .child(div().flex_1().min_w_0().child(mono_field(&env_row.value)))
                        .child(
                            div()
                                .id(("remove-env", row_id))
                                .role(gpui::accesskit::Role::Button)
                                .aria_label("Remove environment variable")
                                .focusable()
                                .tab_stop(true)
                                .focus_visible(|s| s.border_color(rgb(0x888888)))
                                .size(px(36.))
                                .flex_none()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(7.))
                                .border_1()
                                .border_color(rgb(0x2a2a2a))
                                .bg(rgb(0x161616))
                                .text_color(rgb(0x9a9a9a))
                                .cursor_pointer()
                                .hover(|s| {
                                    s.bg(rgb(0x242424))
                                        .border_color(rgb(0x454545))
                                        .text_color(rgb(0xffffff))
                                })
                                .on_click(cx.listener(move |s, _, _, cx| {
                                    s.create.remove_env_row(row_id);
                                    cx.notify();
                                }))
                                .child(lucide_icon(LucideIcon::Trash).size(px(14.))),
                        ),
                );
            }

            if self.create.env_rows.is_empty() {
                env_section = env_section.child(text(
                    "No custom environment variables configured.",
                    12.,
                    0x7e7e7e,
                ));
            }

            env_section = env_section.child(
                row().child(
                    Button::new("add-env-var")
                        .secondary()
                        .size(ComponentSize::Sm)
                        .leading_icon(LucideIcon::Plus)
                        .label("Add variable")
                        .disabled(self.create.env_rows.len() >= MAX_ENV_VARS)
                        .on_click(cx.listener(|s, _, _, cx| {
                            s.create.add_env_row(cx);
                            cx.notify();
                        })),
                ),
            );

            launch_card = launch_card
                .child(card_divider())
                .child(
                    col()
                        .gap(px(7.))
                        .p(px(16.))
                        .child(field_label("Program arguments"))
                        .child(mono_field(&self.create.args))
                        .child(text(
                            format!(
                                "Appended to the {tool_name} command in terminals. Bash quoting and expansion apply."
                            ),
                            11.5,
                            0x7e7e7e,
                        )),
                )
                .child(card_divider())
                .child(env_section);
        }

        // Action bar (unified monochrome button UI)
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
                    .primary()
                    .label(if self.creating {
                        "Creating…"
                    } else {
                        "Create and open"
                    })
                    .disabled(!self.creation_ready())
                    .on_click(cx.listener(|s, _, _, cx| s.submit_create(cx))),
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
            .child(launch_card)
            .child(footer)
    }
}

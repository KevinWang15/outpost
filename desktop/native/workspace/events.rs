use super::*;

impl Workspace {
    pub(crate) fn event(&mut self, e: Value, w: &mut Window, cx: &mut Context<Self>) {
        let kind = e["event"].as_str().unwrap_or("");
        let n = e["pane"].as_u64().unwrap_or(0);
        let cols = e["cols"].as_u64().unwrap_or(80).clamp(2, 400) as u16;
        let rows = e["rows"].as_u64().unwrap_or(24).clamp(2, 200) as u16;
        match kind {
            "prefs" => {
                let previous_lines = self.prefs.scrollback_lines;
                self.prefs = Preferences::from_event(&e);
                if self.prefs.scrollback_lines != previous_lines {
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
                self.picker.refreshing = false;
                if self.page == Page::Create {
                    if !items(&self.accounts["accounts"]).iter().any(|a| {
                        a["origin"] == self.create.origin
                            && a["account"]["id"] == self.create.account_id
                            && a["canCreate"] == true
                    }) {
                        self.create.creating = false;
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
                    self.create.creating = false;
                    let fs = self.prefs.font_size;
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
                self.create.creating = false;
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
                self.create.creating = false;
                self.picker.refreshing = false;
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
                if e["toast"].as_bool() == Some(true) && !error_message.is_empty() {
                    self.show_toast(None, error_message.clone(), false, cx);
                }
                self.message = error_message;
                if self.page == Page::Create {
                    self.sync_machine_select(cx);
                    self.sync_tool_select(cx);
                }
            }
            "targets"
                if self.create.origin == e["origin"]
                    && self.create.account_id == e["accountId"] =>
            {
                self.create.targets = e["targets"].clone();
                let first = items(&self.create.targets)
                    .first()
                    .map(|t| strval(t, "id"))
                    .filter(|id| !id.is_empty());
                if self.create.target.is_empty()
                    && let Some(id) = first
                {
                    self.select_target(id, cx);
                } else {
                    self.sync_machine_select(cx);
                }
            }
            "options"
                if self.create.origin == e["origin"]
                    && self.create.account_id == e["accountId"]
                    && self.create.target == e["target"] =>
            {
                let tools: Vec<&str> = items(&e["tools"])
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                if self.create.tool.is_empty() || !tools.contains(&self.create.tool.as_str()) {
                    self.create.tool = tools.first().copied().unwrap_or("").into();
                }
                self.create.options = e;
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
                            .files
                            .preview_id
                            .as_ref()
                            .is_some_and(|id| !items(&e["files"]).iter().any(|f| f["id"] == *id))
                    {
                        self.files.preview_id = None;
                        self.files.preview = None;
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
                                    p.activity_blocked_kind = None;
                                    p.activity_progress = None;
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
                                p.activity_blocked_kind = e["activity"]["blockedKind"]
                                    .as_str()
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned);
                                p.activity_progress = e["activity"]["progress"]
                                    .as_u64()
                                    .and_then(|v| u8::try_from(v).ok())
                                    .filter(|&v| v <= 100);
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
}

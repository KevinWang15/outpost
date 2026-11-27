use super::*;

impl Workspace {
    pub(super) fn panel(&self, page: Page, cx: &mut Context<Self>) -> AnyElement {
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
                    content = content.child(text(
                        "Your 10 most recent managed sessions will appear here after connecting. Local terminals aren't saved.",
                        13.,
                        MUTED,
                    ))
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

    pub(super) fn startup_cloak_view(&self) -> AnyElement {
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

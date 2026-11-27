use super::*;
use crate::prefs::{DEFAULT_FONT_SIZE, MAX_FONT_SIZE, MIN_FONT_SIZE};

const FONT_STEP: f32 = 0.5;
const SCROLLBACK_PRESETS: [usize; 4] = [5_000, 10_000, 50_000, 100_000];

fn settings_section_header(symbol: LucideIcon, label: &'static str) -> Div {
    row()
        .gap(px(7.))
        .mt(px(20.))
        .mb(px(8.))
        .child(lucide_icon(symbol).size(px(13.)).text_color(rgb(0x7e7e7e)))
        .child(
            div()
                .text_size(px(11.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgb(0x888888))
                .child(label),
        )
}

fn settings_card() -> Div {
    card().overflow_hidden()
}

fn setting_copy(title: &'static str, description: &'static str) -> Div {
    col()
        .flex_1()
        .gap(px(3.))
        .child(
            div()
                .text_size(px(13.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgb(0xf0f0f0))
                .child(title),
        )
        .child(
            div()
                .text_size(px(12.))
                .text_color(rgb(0x888888))
                .child(description),
        )
}

fn shortcut_keys(keys: &[&'static str]) -> Div {
    let mut r = row().flex_none().gap(px(4.));
    for &key in keys {
        r = r.child(
            kbd(key)
                .px(px(6.))
                .py(px(2.))
                .min_w(px(22.))
                .bg(rgb(0x1a1a1a))
                .border_color(rgb(0x2f2f2f))
                .text_color(rgb(0xcfcfcf)),
        );
    }
    r
}

fn shortcut_row(label: &'static str, keys: &[&'static str]) -> Div {
    row()
        .w_full()
        .justify_between()
        .gap(px(12.))
        .py(px(7.))
        .child(
            div()
                .min_w_0()
                .truncate()
                .text_size(px(12.5))
                .text_color(rgb(0xd4d4d4))
                .child(label),
        )
        .child(shortcut_keys(keys))
}

impl Workspace {
    pub(super) fn reset_terminal_settings(&mut self, cx: &mut Context<Self>) {
        self.prefs.reset_terminal_defaults();
        self.message.clear();
        self.sync_history_input(cx);
        self.settings(cx);
    }

    fn set_scrollback_preset(&mut self, lines: usize, cx: &mut Context<Self>) {
        self.prefs.unlimited_scrollback = false;
        self.prefs.scrollback_lines = lines;
        self.message.clear();
        self.sync_history_input(cx);
        self.settings(cx);
    }

    pub(super) fn settings_view(&self, cx: &Context<Self>) -> Div {
        let fontsize = self.prefs.font_size;
        let sound = self.prefs.sound;
        let unlimited = self.prefs.unlimited_scrollback;
        let bounded = self.prefs.scrollback_lines;
        let profiles = &self.prefs.profiles;
        let selected_shell = self.prefs.local_profile(None).map(|p| p.id.as_str());

        // Header
        let header = row()
            .w_full()
            .items_end()
            .justify_between()
            .gap(px(16.))
            .child(
                col()
                    .gap(px(4.))
                    .child(text("SETTINGS", 10., 0x808080).font_weight(FontWeight::SEMIBOLD))
                    .child(
                        text("Terminal settings", 26., 0xfafafa).font_weight(FontWeight::SEMIBOLD),
                    )
                    .child(text(
                        "Changes save automatically and apply immediately to open terminals.",
                        12.5,
                        0x888888,
                    )),
            )
            .when(self.prefs.is_custom(), |r| {
                r.child(
                    div()
                        .id("settings-reset-defaults")
                        .role(gpui::accesskit::Role::Button)
                        .focusable()
                        .tab_stop(true)
                        .focus_visible(|s| s.border_color(rgb(0x888888)))
                        .flex_none()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(6.))
                        .px(px(10.))
                        .py(px(6.))
                        .rounded(px(7.))
                        .border_1()
                        .border_color(rgb(0x2a2a2a))
                        .bg(rgb(0x141414))
                        .text_size(px(12.))
                        .text_color(rgb(0xb8b8b8))
                        .cursor_pointer()
                        .hover(|s| {
                            s.bg(rgb(0x222222))
                                .border_color(rgb(0x3e3e3e))
                                .text_color(rgb(0xffffff))
                        })
                        .on_click(cx.listener(|s, _, _, cx| s.reset_terminal_settings(cx)))
                        .child(lucide_icon(LucideIcon::RotateCcw).size(px(12.5)))
                        .child("Reset defaults"),
                )
            });

        // Card 1: Appearance & Feedback (Text size + live preview, Bell sound)
        let at_min_font = fontsize <= MIN_FONT_SIZE + 0.01;
        let at_max_font = fontsize >= MAX_FONT_SIZE - 0.01;
        let font_stepper = row()
            .flex_none()
            .gap(px(0.))
            .rounded(px(7.))
            .bg(rgb(0x0c0c0c))
            .border_1()
            .border_color(rgb(0x2c2c2c))
            .overflow_hidden()
            .child(
                div()
                    .id("font-decrease")
                    .role(gpui::accesskit::Role::Button)
                    .aria_label("Decrease terminal text size")
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_r_1()
                    .border_color(rgb(0x242424))
                    .text_color(rgb(if at_min_font { 0x4a4a4a } else { 0xd4d4d4 }))
                    .when(!at_min_font, |el| {
                        el.focusable()
                            .tab_stop(true)
                            .focus_visible(|s| s.bg(rgb(0x2a2a2a)))
                            .cursor_pointer()
                            .hover(|s| s.bg(rgb(0x202020)).text_color(rgb(0xffffff)))
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.prefs.font_size =
                                    (s.prefs.font_size - FONT_STEP).max(MIN_FONT_SIZE);
                                s.settings(cx)
                            }))
                    })
                    .child(lucide_icon(LucideIcon::Minus).size(px(13.5))),
            )
            .child(
                div()
                    .w(px(68.))
                    .h(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .font_family(crate::terminal::FAMILY)
                    .text_size(px(13.))
                    .text_color(rgb(0xf0f0f0))
                    .child(format!("{fontsize:.1} px")),
            )
            .child(
                div()
                    .id("font-increase")
                    .role(gpui::accesskit::Role::Button)
                    .aria_label("Increase terminal text size")
                    .size(px(32.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(rgb(0x242424))
                    .text_color(rgb(if at_max_font { 0x4a4a4a } else { 0xd4d4d4 }))
                    .when(!at_max_font, |el| {
                        el.focusable()
                            .tab_stop(true)
                            .focus_visible(|s| s.bg(rgb(0x2a2a2a)))
                            .cursor_pointer()
                            .hover(|s| s.bg(rgb(0x202020)).text_color(rgb(0xffffff)))
                            .on_click(cx.listener(|s, _, _, cx| {
                                s.prefs.font_size =
                                    (s.prefs.font_size + FONT_STEP).min(MAX_FONT_SIZE);
                                s.settings(cx)
                            }))
                    })
                    .child(lucide_icon(LucideIcon::Plus).size(px(13.5))),
            );

        let font_preview = row()
            .w_full()
            .mt(px(12.))
            .px(px(12.))
            .py(px(10.))
            .rounded(px(7.))
            .bg(rgb(0x0a0a0a))
            .border_1()
            .border_color(rgb(0x222222))
            .overflow_hidden()
            .gap(px(0.))
            .font_family(crate::terminal::FAMILY)
            .text_size(px(fontsize))
            .child(div().flex_none().text_color(rgb(0x4ade80)).child("~/outpost"))
            .child(div().flex_none().text_color(rgb(0x737373)).child(" $ "))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_color(rgb(0xe6e6e6))
                    .child("git status --short"),
            )
            .child(
                div()
                    .flex_none()
                    .ml(px(2.))
                    .w(px((fontsize * 0.55).max(6.)))
                    .h(px((fontsize * 1.15).max(12.)))
                    .bg(rgb(0xd4d4d4)),
            );

        let appearance_card = settings_card()
            .child(
                col()
                    .p(px(16.))
                    .child(
                        row()
                            .w_full()
                            .justify_between()
                            .gap(px(16.))
                            .child(setting_copy(
                                "Text size",
                                "Applied immediately to all local and remote terminal panes.",
                            ))
                            .child(
                                row()
                                    .flex_none()
                                    .gap(px(8.))
                                    .when((fontsize - DEFAULT_FONT_SIZE).abs() > 0.01, |r| {
                                        r.child(
                                            div()
                                                .id("font-reset")
                                                .role(gpui::accesskit::Role::Button)
                                                .focusable()
                                                .tab_stop(true)
                                                .focus_visible(|s| s.bg(rgb(0x2a2a2a)))
                                                .px(px(7.))
                                                .py(px(4.))
                                                .rounded(px(5.))
                                                .cursor_pointer()
                                                .text_size(px(11.5))
                                                .text_color(rgb(0x888888))
                                                .hover(|s| {
                                                    s.bg(rgb(0x202020)).text_color(rgb(0xffffff))
                                                })
                                                .on_click(cx.listener(|s, _, _, cx| {
                                                    s.prefs.font_size = DEFAULT_FONT_SIZE;
                                                    s.settings(cx)
                                                }))
                                                .child("Reset"),
                                        )
                                    })
                                    .child(font_stepper),
                            ),
                    )
                    .child(font_preview),
            )
            .child(card_divider())
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .gap(px(16.))
                    .p(px(16.))
                    .child(
                        row()
                            .flex_1()
                            .gap(px(12.))
                            .child(
                                div()
                                    .size(px(32.))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(7.))
                                    .bg(rgb(0x1b1b1b))
                                    .border_1()
                                    .border_color(rgb(0x282828))
                                    .child(
                                        lucide_icon(if sound {
                                            LucideIcon::Bell
                                        } else {
                                            LucideIcon::BellOff
                                        })
                                        .size(px(15.))
                                        .text_color(rgb(if sound { 0xe6e6e6 } else { 0x7a7a7a })),
                                    ),
                            )
                            .child(setting_copy(
                                "Bell sound",
                                "Play the system alert sound on terminal bell. Tab indicators remain active.",
                            )),
                    )
                    .child(
                        switch("settings-bell-switch", sound)
                            .size(ComponentSize::Sm)
                            .on_change(cx.listener(|s, value: &bool, _, cx| {
                                s.prefs.sound = *value;
                                s.settings(cx);
                            })),
                    ),
            );

        // Card 2: Shell & Scrollback
        let mut shell_list = col().w_full().mt(px(12.)).gap(px(6.));
        for p in profiles {
            let id = p.id.clone();
            let name = p.name.clone();
            let exec = p.executable.clone();
            let is_selected = selected_shell == Some(id.as_str());
            shell_list = shell_list.child(
                div()
                    .id(SharedString::from(format!("shell-profile-{id}")))
                    .role(gpui::accesskit::Role::RadioButton)
                    .aria_selected(is_selected)
                    .focusable()
                    .tab_stop(true)
                    .focus_visible(|s| s.border_color(rgb(0x888888)))
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(12.))
                    .px(px(12.))
                    .py(px(9.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(rgb(if is_selected { 0x454545 } else { 0x222222 }))
                    .bg(rgb(if is_selected { 0x1d1d1d } else { 0x0f0f0f }))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(0x1f1f1f)).border_color(rgb(0x3a3a3a)))
                    .on_click(cx.listener(move |s, _, _, cx| {
                        s.prefs.local_shell = Some(id.clone());
                        s.settings(cx)
                    }))
                    .child(
                        row()
                            .flex_1()
                            .gap(px(10.))
                            .child(
                                lucide_icon(LucideIcon::Terminal)
                                    .size(px(15.))
                                    .text_color(rgb(if is_selected { 0xe6e6e6 } else { 0x777777 })),
                            )
                            .child(
                                col()
                                    .flex_1()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(rgb(if is_selected {
                                                0xf5f5f5
                                            } else {
                                                0xc8c8c8
                                            }))
                                            .child(name),
                                    )
                                    .when(!exec.is_empty(), |c| {
                                        c.child(
                                            div()
                                                .truncate()
                                                .font_family(crate::terminal::FAMILY)
                                                .text_size(px(11.))
                                                .text_color(rgb(0x757575))
                                                .child(exec),
                                        )
                                    }),
                            ),
                    )
                    .child(
                        div()
                            .size(px(18.))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .border_1()
                            .border_color(rgb(if is_selected { 0x4ade80 } else { 0x383838 }))
                            .bg(rgb(if is_selected { 0x163022 } else { 0x121212 }))
                            .when(is_selected, |el| {
                                el.child(
                                    lucide_icon(LucideIcon::Check)
                                        .size(px(11.))
                                        .text_color(rgb(0x4ade80)),
                                )
                            }),
                    ),
            );
        }

        let scrollback_mode = segmented_control(
            "settings-scrollback-mode",
            if unlimited { "unlimited" } else { "limited" },
        )
        .size(ComponentSize::Sm)
        .item(SegmentedItem::new("limited", "Limit lines"))
        .item(SegmentedItem::new("unlimited", "Unlimited").icon(LucideIcon::Infinity))
        .on_change(cx.listener(|s, value: &SharedString, _, cx| {
            let next_unlimited = value.as_ref() == "unlimited";
            if s.prefs.unlimited_scrollback != next_unlimited {
                s.prefs.unlimited_scrollback = next_unlimited;
                s.message.clear();
                s.settings(cx);
            }
        }));

        let mut presets = row().flex_wrap().gap(px(6.));
        for lines in SCROLLBACK_PRESETS {
            let active = !unlimited && bounded == lines;
            presets = presets.child(
                div()
                    .id(("scrollback-preset", lines))
                    .role(gpui::accesskit::Role::Button)
                    .focusable()
                    .tab_stop(true)
                    .focus_visible(|s| s.border_color(rgb(0x888888)))
                    .px(px(9.))
                    .py(px(5.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(rgb(if active { 0x525252 } else { 0x262626 }))
                    .bg(rgb(if active { 0x242424 } else { 0x0e0e0e }))
                    .text_size(px(12.))
                    .font_weight(if active {
                        FontWeight::MEDIUM
                    } else {
                        FontWeight::NORMAL
                    })
                    .text_color(rgb(if active { 0xffffff } else { 0x9e9e9e }))
                    .cursor_pointer()
                    .hover(|s| s.bg(rgb(0x222222)).text_color(rgb(0xffffff)))
                    .on_click(cx.listener(move |s, _, _, cx| s.set_scrollback_preset(lines, cx)))
                    .child(format_thousands(lines)),
            );
        }

        let shell_and_history_card = settings_card()
            .when(!profiles.is_empty(), |c| {
                c.child(
                    col()
                        .p(px(16.))
                        .child(setting_copy(
                            "Default local shell",
                            "Used for new local tabs, splits, and shortcuts. Click + to choose another shell anytime.",
                        ))
                        .child(shell_list),
                )
                .child(card_divider())
            })
            .child(
                col()
                    .p(px(16.))
                    .child(
                        row()
                            .w_full()
                            .justify_between()
                            .gap(px(16.))
                            .child(setting_copy(
                                "Scrollback history",
                                "Lines retained in memory per terminal pane.",
                            ))
                            .child(scrollback_mode),
                    )
                    .when(!unlimited, |c| {
                        c.child(
                            row()
                                .w_full()
                                .flex_wrap()
                                .justify_between()
                                .mt(px(12.))
                                .gap(px(10.))
                                .child(presets)
                                .child(
                                    row()
                                        .flex_none()
                                        .gap(px(6.))
                                        .child(
                                            div().w(px(108.)).child(
                                                input(&self.history_input)
                                                    .w_full()
                                                    .h(px(32.))
                                                    .text_size(px(12.5))
                                                    .bg(rgb(0x0a0a0a))
                                                    .border_color(rgb(0x2e2e2e))
                                                    .rounded(px(6.)),
                                            ),
                                        )
                                        .child(text("lines", 12., 0x888888))
                                        .child(
                                            button("apply-scrollback", false, cx, |s, _, cx| {
                                                s.save_history_limit(cx)
                                            })
                                            .py(px(5.))
                                            .px(px(10.))
                                            .text_size(px(12.))
                                            .child("Apply"),
                                        ),
                                ),
                        )
                    })
                    .when(unlimited, |c| {
                        c.child(
                            row()
                                .mt(px(12.))
                                .px(px(11.))
                                .py(px(8.))
                                .rounded(px(7.))
                                .bg(rgb(0x0f0f0f))
                                .border_1()
                                .border_color(rgb(0x222222))
                                .gap(px(8.))
                                .child(
                                    lucide_icon(LucideIcon::Info)
                                        .size(px(13.5))
                                        .text_color(rgb(0x888888)),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .text_size(px(12.))
                                        .text_color(rgb(0x9a9a9a))
                                        .child("History grows in memory without pruning. Managed Outpost terminals also keep output while disconnected."),
                                ),
                        )
                    }),
            );

        // Card 3: Keyboard shortcuts (two balanced columns matching actual keybindings 1:1)
        let mac = cfg!(target_os = "macos");
        let left_shortcuts: &[(&'static str, &[&'static str])] = if mac {
            &[
                ("Copy selection", &["⌘", "C"]),
                ("Paste", &["⌘", "V"]),
                ("Select all", &["⌘", "A"]),
                ("Find in terminal", &["⌘", "F"]),
                ("Find next / previous", &["⌘", "G / ⇧G"]),
                ("Use selection for Find", &["⌘", "E"]),
                ("Write a message", &["⌘", "Return"]),
                ("Clear screen", &["⌘", "K"]),
                ("Scroll page / top & bottom", &["Shift", "PgUp/Dn · Home/End"]),
                ("Reload terminal", &["⌘", "R"]),
                ("Larger text", &["⌘", "+"]),
                ("Smaller text", &["⌘", "−"]),
                ("Reset text size", &["⌘", "0"]),
                ("Settings", &["⌘", ","]),
                ("Close window", &["⌘", "Shift", "W"]),
                ("Toggle full screen", &["Ctrl", "⌘", "F"]),
            ]
        } else {
            &[
                ("Copy selection", &["Ctrl", "C"]),
                ("Paste", &["Ctrl", "V"]),
                ("Select all", &["Ctrl", "Shift", "A"]),
                ("Find in terminal", &["Ctrl", "Shift", "F"]),
                ("Find next / previous", &["F3 / Shift+F3"]),
                ("Use selection for Find", &["Ctrl", "Shift", "E"]),
                ("Write a message", &["Ctrl", "Shift", "Enter"]),
                ("Clear screen", &["Ctrl", "Shift", "K"]),
                ("Scroll page / top & bottom", &["Shift", "PgUp/Dn · Home/End"]),
                ("Reload terminal", &["Ctrl", "Shift", "R"]),
                ("Larger text", &["Ctrl", "+"]),
                ("Smaller text", &["Ctrl", "−"]),
                ("Reset text size", &["Ctrl", "0"]),
                ("Settings", &["Ctrl", ","]),
                ("Close window", &["Alt", "F4"]),
                ("Toggle full screen", &["F11"]),
            ]
        };
        let right_shortcuts: &[(&'static str, &[&'static str])] = if mac {
            &[
                ("New terminal tab", &["⌘", "T"]),
                ("New window", &["⌘", "Shift", "N"]),
                ("Switch session", &["⌘", "P"]),
                ("Outpost sessions", &["⌘", "Shift", "O"]),
                ("Next / previous tab", &["Ctrl", "Tab"]),
                ("Go to tab 1–8 / last", &["⌘", "1–9"]),
                ("Move tab left / right", &["Ctrl", "Shift", "PgUp/Dn"]),
                ("Split side by side", &["⌘", "D"]),
                ("Split top & bottom", &["⌘", "Shift", "D"]),
                ("Zoom / restore pane", &["⌘", "Shift", "Return"]),
                ("Focus other pane", &["⌘", "⌥", "←/→"]),
                ("Close focused pane", &["⌘", "W"]),
                ("Close current tab", &["⌘", "⌥", "W"]),
            ]
        } else {
            &[
                ("New terminal tab", &["Ctrl", "Shift", "T"]),
                ("New window", &["Ctrl", "Shift", "N"]),
                ("Switch session", &["Ctrl", "Shift", "P"]),
                ("Outpost sessions", &["Ctrl", "Shift", "O"]),
                ("Next / previous tab", &["Ctrl", "Tab"]),
                ("Go to tab 1–8 / last", &["Alt", "1–9"]),
                ("Move tab left / right", &["Ctrl", "Shift", "PgUp/Dn"]),
                ("Split side by side", &["Ctrl", "Shift", "D"]),
                ("Split top & bottom", &["Ctrl", "Alt", "D"]),
                ("Zoom / restore pane", &["Ctrl", "Alt", "Enter"]),
                ("Focus other pane", &["Ctrl", "Alt", "←/→"]),
                ("Close focused pane", &["Ctrl", "Shift", "W"]),
                ("Close current tab", &["Ctrl", "Alt", "W"]),
            ]
        };

        let build_shortcut_col = |heading: &'static str, rows: &[(&'static str, &[&'static str])]| {
            let mut c = col().flex_1().p(px(14.)).gap(px(2.)).child(
                div()
                    .pb(px(6.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(rgb(0x7e7e7e))
                    .child(heading),
            );
            for (i, (label, keys)) in rows.iter().enumerate() {
                if i > 0 {
                    c = c.child(div().w_full().h(px(1.)).bg(rgb(0x1c1c1c)));
                }
                c = c.child(shortcut_row(label, keys));
            }
            c
        };

        let shortcuts_card = settings_card().child(
            div()
                .w_full()
                .flex()
                .flex_row()
                .items_stretch()
                .child(build_shortcut_col("EDITING & VIEW", left_shortcuts))
                .child(div().w(px(1.)).flex_none().bg(rgb(0x202020)))
                .child(build_shortcut_col("TABS, SPLITS & WORKSPACE", right_shortcuts)),
        );

        // Footer: About & Updates
        let footer = row()
            .w_full()
            .justify_between()
            .mt(px(22.))
            .pt(px(16.))
            .border_t_1()
            .border_color(rgb(0x202020))
            .child(
                row()
                    .gap(px(10.))
                    .child(img(self.logo.clone()).size(px(20.)))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(rgb(0xd4d4d4))
                            .child("Outpost Desktop"),
                    )
                    .child(
                        div()
                            .px(px(6.))
                            .py(px(1.))
                            .rounded(px(4.))
                            .bg(rgb(0x181818))
                            .border_1()
                            .border_color(rgb(0x282828))
                            .font_family(crate::terminal::FAMILY)
                            .text_size(px(11.))
                            .text_color(rgb(0x888888))
                            .child(format!("v{}", env!("CARGO_PKG_VERSION"))),
                    ),
            )
            .child(control_with_icon(
                "Check for updates",
                LucideIcon::ExternalLink,
                true,
                false,
                cx,
                |_, _, cx| cx.open_url("https://github.com/KevinWang15/outpost/releases"),
            ));

        col()
            .w_full()
            .child(header)
            .child(settings_section_header(
                LucideIcon::Type,
                "APPEARANCE & FEEDBACK",
            ))
            .child(appearance_card)
            .child(settings_section_header(
                LucideIcon::Terminal,
                "SHELL & SCROLLBACK",
            ))
            .child(shell_and_history_card)
            .child(settings_section_header(
                LucideIcon::Keyboard,
                "KEYBOARD SHORTCUTS",
            ))
            .child(shortcuts_card)
            .child(footer)
    }
}

use super::*;

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

impl Workspace {
    pub(super) fn set_new_tab_menu(&mut self, open: bool, cx: &mut Context<Self>) {
        if open {
            if self.overlay != Some(OverlayMenu::NewTab) {
                self.overlay = Some(OverlayMenu::NewTab);
                cx.notify();
            }
        } else if self.overlay == Some(OverlayMenu::NewTab) {
            self.overlay = None;
            cx.notify();
        }
    }

    pub(super) fn set_bar_menu(&mut self, open: bool, cx: &mut Context<Self>) {
        if open {
            if self.overlay != Some(OverlayMenu::BarOverflow) {
                self.overlay = Some(OverlayMenu::BarOverflow);
                cx.notify();
            }
        } else if self.overlay == Some(OverlayMenu::BarOverflow) {
            self.overlay = None;
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
        let open = self.overlay == Some(OverlayMenu::BarOverflow);
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
        let open = self.overlay == Some(OverlayMenu::NewTab);
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
        let profiles = &self.prefs.profiles;
        let shortcut = if cfg!(target_os = "macos") {
            "⌘T"
        } else {
            "Ctrl+Shift+T"
        };
        if profiles.len() <= 1 {
            menu = menu.entry(local_entry("Local terminal".into(), None).with_shortcut(shortcut));
        } else {
            menu = menu.entry(MenuEntry::Label("Local shells".into()));
            let preferred = self.prefs.local_profile(None).map(|p| p.id.as_str());
            for profile in profiles {
                let entry =
                    local_entry(profile.name.clone().into(), Some(profile.id.clone()));
                menu = menu.entry(if Some(profile.id.as_str()) == preferred {
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

    pub(super) fn chrome(&self, w: &Window, cx: &mut Context<Self>) -> Div {
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
}

#[cfg(test)]
mod tests {
    use super::{compute_chrome_layout, show_tab_divider};
    use crate::{terminal::SearchStatus, workspace::find::format_find_counter};

    #[test]
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

    #[test]
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

    #[test]
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

use super::*;

pub(super) fn status_dot(pane: &Pane) -> Div {
    let color = if pane.bell || pane.activity == "waiting" {
        0xfbbf24
    } else if !pane.status.is_empty() || pane.activity == "error" {
        0xf87171
    } else {
        0x4ade80
    };
    div().size(px(6.)).flex_none().rounded_full().bg(rgb(color))
}

pub(super) fn header_button(
    id: impl Into<ElementId>,
    glyph: LucideIcon,
    label: &'static str,
    show_hint: bool,
    click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::accesskit::Role::Button)
        .aria_label(label)
        .focusable()
        .tab_stop(true)
        .focus_visible(|s| s.bg(rgb(0x353535)))
        .size(px(24.))
        .flex_none()
        .flex()
        .justify_center()
        .items_center()
        .rounded(px(3.))
        .cursor_pointer()
        .hover(|s| s.bg(rgb(0x303030)).text_color(rgb(TEXT)))
        .when(show_hint, |e| {
            e.tooltip(move |w, cx| Tooltip::text(label, w, cx))
        })
        // A pointer action should leave typing in the terminal. Keyboard users can still focus the button.
        .on_mouse_down(MouseButton::Left, |_, w, _| w.prevent_default())
        .child(lucide_icon(glyph).size(px(14.)))
        .on_click(click)
}

impl Workspace {
    pub(super) fn toggle_zoom(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        let Some(i) = self.tabs.iter().position(|t| t.layout.contains(id)) else {
            return;
        };
        if matches!(self.tabs[i].layout, Layout::Pane(_)) {
            return;
        }
        self.tabs[i].zoom = !self.tabs[i].zoom;
        self.select(id, w, cx);
    }

    fn toggle_pane_menu(&mut self, id: Id, open: bool, w: &mut Window, cx: &mut Context<Self>) {
        if open {
            self.select(id, w, cx);
            self.context_menu = None;
            self.pane_menu = Some(id);
        } else if self.pane_menu == Some(id) {
            self.pane_menu = None;
        }
        cx.notify();
    }

    pub(super) fn pane_header(
        &self,
        id: Id,
        pane: &Pane,
        active: bool,
        cx: &Context<Self>,
    ) -> Stateful<Div> {
        let zoomed = self.tabs[self.current].zoom;
        let open = self.pane_menu == Some(id);
        let dragging = self.drag.dragged_pane() == Some(id);
        let zoom_label = if zoomed {
            "Restore split panes"
        } else {
            "Zoom pane"
        };
        let handle = row()
            .id(("pane-handle", id))
            .role(gpui::accesskit::Role::Button)
            .focusable()
            .tab_stop(true)
            .on_click(cx.listener(move |s, e: &ClickEvent, w, cx| {
                if !matches!(e, ClickEvent::Mouse(_)) {
                    s.select(id, w, cx);
                }
            }))
            .flex_1()
            .h_full()
            .overflow_hidden()
            .gap(px(6.))
            .pl(px(6.))
            .cursor(if dragging {
                CursorStyle::ClosedHand
            } else {
                CursorStyle::OpenHand
            })
            .aria_label(format!("Focus or drag {}", pane.title))
            .tooltip(|w, cx| {
                Tooltip::text("Drag to move pane · Double-click to zoom or restore", w, cx)
            })
            .child(
                lucide_icon(LucideIcon::GripVertical)
                    .size(px(12.))
                    .text_color(rgb(MUTED)),
            )
            .child(status_dot(pane))
            .children(pane.mark.map(|m| m.icon(14.)))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .child(pane.title.clone()),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, e: &MouseDownEvent, w, cx| {
                    w.prevent_default();
                    if e.click_count == 2 {
                        s.cancel_drag(cx);
                        s.toggle_zoom(id, w, cx);
                    } else {
                        s.arm(id, false, e.position, w, cx);
                    }
                }),
            );
        let trigger = div()
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    s.toggle_pane_menu(id, !open, w, cx);
                }),
            )
            .child(header_button(
                ("pane-options", id),
                LucideIcon::Ellipsis,
                "Pane actions",
                !open,
                cx.listener(move |s, e: &ClickEvent, w, cx| {
                    if !matches!(e, ClickEvent::Mouse(_)) {
                        s.toggle_pane_menu(id, !open, w, cx);
                    }
                }),
            ));
        let mut menu = dropdown_menu(("pane-menu", id), open)
            .trigger(trigger)
            .min_width(px(224.))
            .on_close(cx.listener(move |s, _, w, cx| s.toggle_pane_menu(id, false, w, cx)));
        if open {
            menu = menu.entries(self.pane_menu_entries(id, zoom_label, cx));
        }
        row()
            .id(("header", id))
            .w_full()
            .h(px(28.))
            .flex_none()
            .gap(px(1.))
            .pr(px(3.))
            .border_b_1()
            .border_color(rgb(if active { 0x404040 } else { 0x242424 }))
            .bg(rgb(if active { 0x191919 } else { 0x111111 }))
            .text_color(rgb(if active { TEXT } else { MUTED }))
            .when(dragging, |e| e.opacity(0.55))
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |s, _, w, cx| s.toggle_pane_menu(id, true, w, cx)),
            )
            .child(handle)
            .child(header_button(
                ("pane-zoom", id),
                if zoomed {
                    LucideIcon::Minimize2
                } else {
                    LucideIcon::Maximize2
                },
                zoom_label,
                true,
                cx.listener(move |s, _, w, cx| s.toggle_zoom(id, w, cx)),
            ))
            .child(menu)
            .child(header_button(
                ("pane-close", id),
                LucideIcon::X,
                "Close pane",
                true,
                cx.listener(move |s, _, w, cx| s.close(id, w, cx)),
            ))
    }

    fn pane_menu_entries(
        &self,
        id: Id,
        zoom_label: &'static str,
        cx: &Context<Self>,
    ) -> Vec<MenuEntry> {
        // Resolve the captured pane at selection time, even if focus or membership changed while the menu was open.
        let item = |label: &'static str,
                    glyph: LucideIcon,
                    action: fn(&mut Self, Id, &mut Window, &mut Context<Self>)| {
            MenuEntry::item_with_icon(
                label,
                glyph,
                cx.listener(move |s, _, w, cx| {
                    if s.panes.contains_key(&id) {
                        s.select(id, w, cx);
                        action(s, id, w, cx);
                    }
                }),
            )
        };
        let mut entries = vec![
            item("Split side by side", LucideIcon::Columns2, |s, _, w, cx| {
                s.split(Axis::Across, w, cx)
            }),
            item("Split top and bottom", LucideIcon::Rows2, |s, _, w, cx| {
                s.split(Axis::Down, w, cx)
            }),
            item(
                zoom_label,
                if self.tabs[self.current].zoom {
                    LucideIcon::Minimize2
                } else {
                    LucideIcon::Maximize2
                },
                Self::toggle_zoom,
            ),
            MenuEntry::Separator,
            item(
                "Move pane to its own tab",
                LucideIcon::PanelTop,
                |s, _, w, cx| s.place_selected(false, Destination::Tab, w, cx),
            ),
            item(
                "Move pane to new window",
                LucideIcon::AppWindow,
                |s, _, w, cx| s.detach(false, w, cx),
            ),
        ];
        for other in cx.windows().into_iter().filter(|h| *h != self.handle) {
            let Some(target) = other.downcast::<Workspace>() else {
                continue;
            };
            let Ok(workspace) = target.read(cx) else {
                continue;
            };
            let title = workspace
                .active()
                .map(|p| p.read(cx).title.clone())
                .unwrap_or_else(|| "Outpost".into());
            let label = format!("Move to window {} · {title}", workspace.id);
            entries.push(MenuEntry::item_with_icon(
                label,
                LucideIcon::AppWindow,
                cx.listener(move |s, _, w, cx| {
                    if s.panes.contains_key(&id) {
                        s.select(id, w, cx);
                        if let Some(item) = s.selected_item(false, cx) {
                            s.transfer_to(&item, target, Destination::Tab, w, cx);
                        }
                    }
                }),
            ));
        }
        entries.extend([
            MenuEntry::Separator,
            item("Reload terminal", LucideIcon::RotateCw, |s, _, w, cx| {
                s.reload_selected(w, cx)
            }),
            item(
                "Terminal actions…",
                LucideIcon::Ellipsis,
                |s, _, w, cx| s.manage(w, cx),
            ),
            MenuEntry::destructive_item(
                "Close pane",
                Some(LucideIcon::X),
                cx.listener(move |s, _, w, cx| s.close(id, w, cx)),
            ),
        ]);
        entries
    }

    pub(super) fn open_context_menu(
        &mut self,
        id: Id,
        position: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if let Some(i) = self.tabs.iter().position(|t| t.layout.contains(id)) {
            self.current = i;
            self.tabs[i].active = id;
        }
        self.new_tab_menu_open = false;
        self.pane_menu = None;
        self.files_menu = None;
        self.context_menu = Some((id, position));
        cx.notify();
    }

    pub(super) fn context_menu_overlay(&self, cx: &Context<Self>) -> impl IntoElement + use<> {
        let active = self.context_menu.and_then(|(id, pos)| {
            self.panes.get(&id).map(|pane| (id, pos, pane.read(cx)))
        });
        let position = active.map(|(_, pos, _)| pos);
        let mut menu = popup_menu("terminal-context-menu", position)
            .min_width(px(232.))
            .on_close(cx.listener(|s, _, _, cx| {
                if s.context_menu.take().is_some() {
                    cx.notify();
                }
            }));

        if let Some((id, _, pane)) = active {
            let can_copy = pane.can_copy();
            let managed = pane.server.is_some();
            let mac = cfg!(target_os = "macos");

            menu = menu
                .entry(
                    MenuEntry::item_with_icon(
                        "Copy",
                        LucideIcon::Copy,
                        cx.listener(move |s, _, _, cx| {
                            if let Some(p) = s.panes.get(&id).cloned()
                                && p.update(cx, |p, cx| p.copy(cx))
                            {
                                s.show_toast(Some(id), "Copied to clipboard".into(), false, cx);
                            }
                        }),
                    )
                    .with_shortcut(if mac { "⌘C" } else { "Ctrl+C" })
                    .with_disabled(!can_copy),
                )
                .entry(
                    MenuEntry::item_with_icon(
                        "Paste",
                        LucideIcon::ClipboardPaste,
                        cx.listener(move |s, _, _, cx| {
                            if let Some(p) = s.panes.get(&id).cloned() {
                                p.update(cx, |p, cx| p.paste_clipboard(cx));
                            }
                        }),
                    )
                    .with_shortcut(if mac { "⌘V" } else { "Ctrl+V" }),
                );
            if managed {
                menu = menu.entry(MenuEntry::item_with_icon(
                    "Paste image as file path",
                    LucideIcon::ImagePlus,
                    cx.listener(move |s, _, _, cx| {
                        if let Some(p) = s.panes.get(&id).cloned() {
                            p.update(cx, |p, cx| p.paste_image_path(cx));
                        }
                    }),
                ));
            }
            menu = menu
                .entry(
                    MenuEntry::item_with_icon(
                        "Select all",
                        LucideIcon::ScanText,
                        cx.listener(move |s, _, _, cx| {
                            if let Some(p) = s.panes.get(&id).cloned() {
                                p.update(cx, |p, cx| p.select_all(cx));
                            }
                        }),
                    )
                    .with_shortcut(if mac { "⌘A" } else { "Ctrl+Shift+A" }),
                )
                .entry(MenuEntry::Separator)
                .entry(
                    MenuEntry::item_with_icon(
                        "Find…",
                        LucideIcon::Search,
                        cx.listener(move |s, _, w, cx| {
                            s.select(id, w, cx);
                            s.show(Page::Find, w, cx);
                        }),
                    )
                    .with_shortcut(if mac { "⌘F" } else { "Ctrl+Shift+F" }),
                )
                .entry(
                    MenuEntry::item_with_icon(
                        "Write a message…",
                        LucideIcon::MessageSquareText,
                        cx.listener(move |s, _, w, cx| {
                            s.select(id, w, cx);
                            s.show(Page::Compose, w, cx);
                        }),
                    )
                    .with_shortcut(if mac { "⌘↵" } else { "Ctrl+Shift+Enter" }),
                )
                .entry(
                    MenuEntry::item_with_icon(
                        "Clear screen",
                        LucideIcon::Eraser,
                        cx.listener(move |s, _, _, cx| {
                            if let Some(p) = s.panes.get(&id).cloned() {
                                p.update(cx, |p, cx| p.clear_screen(true, cx));
                            }
                        }),
                    )
                    .with_shortcut(if mac { "⌘K" } else { "Ctrl+Shift+K" }),
                )
                .entry(MenuEntry::Separator)
                .entry(
                    MenuEntry::item_with_icon(
                        "Split side by side",
                        LucideIcon::Columns2,
                        cx.listener(move |s, _, w, cx| {
                            s.select(id, w, cx);
                            s.split(Axis::Across, w, cx);
                        }),
                    )
                    .with_shortcut(if mac { "⌘D" } else { "Ctrl+Shift+D" }),
                )
                .entry(
                    MenuEntry::item_with_icon(
                        "Split top and bottom",
                        LucideIcon::Rows2,
                        cx.listener(move |s, _, w, cx| {
                            s.select(id, w, cx);
                            s.split(Axis::Down, w, cx);
                        }),
                    )
                    .with_shortcut(if mac { "⌘⇧D" } else { "Ctrl+Alt+D" }),
                )
                .entry(MenuEntry::item_with_icon(
                    "Terminal actions…",
                    LucideIcon::Ellipsis,
                    cx.listener(move |s, _, w, cx| {
                        s.select(id, w, cx);
                        s.manage(w, cx);
                    }),
                ));
        }

        menu
    }
}

//! Keep ownership in the source window until release. The destination can paint
//! the current terminal frame without registering a second input handler or
//! resizing a PTY during hover.
use super::*;

const DRAG_BADGE_MAX_W: f32 = 276.;
const DRAG_BADGE_H: f32 = 34.;

pub(super) struct Gesture {
    item: DragItem,
    start: Point<Pixels>,
    cursor: Point<Pixels>,
    outside: bool,
    active: bool,
    generation: Id,
    hover: Option<WindowHandle<Workspace>>,
}
#[derive(Default)]
pub(super) struct DragState {
    pub(super) gesture: Option<Gesture>,
    pub(super) strip: ScrollHandle,
    pub(super) rendered_tabs: Vec<Option<Id>>,
    ghost: Option<(WindowHandle<DragLabel>, Point<Pixels>)>,
    pub(super) empty_bar: SnapshotSource,
    pub(super) preview: Option<Preview>,
}
impl DragState {
    pub(super) fn is_active(&self) -> bool {
        self.gesture.as_ref().is_some_and(|g| g.active)
    }
    pub(super) fn dragged_pane(&self) -> Option<Id> {
        self.gesture
            .as_ref()
            .filter(|g| g.active && !g.item.whole)
            .map(|g| g.item.pane)
    }
}
pub(super) struct Preview {
    pub(super) destination: Destination,
    moving_tab: Option<Id>,
    bounds: Bounds<Pixels>,
    pub(super) label: DragLabel,
    body: Option<LivePreview>,
    cursor: Option<Point<Pixels>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DropHint {
    icon: LucideIcon,
    label: &'static str,
    accent: bool,
}

fn drop_hint_for(destination: Option<Destination>) -> DropHint {
    match destination {
        Some(Destination::Split(_, Axis::Across, true)) => DropHint {
            icon: LucideIcon::Columns2,
            label: "Split left",
            accent: true,
        },
        Some(Destination::Split(_, Axis::Across, false)) => DropHint {
            icon: LucideIcon::Columns2,
            label: "Split right",
            accent: true,
        },
        Some(Destination::Split(_, Axis::Down, true)) => DropHint {
            icon: LucideIcon::Rows2,
            label: "Split top",
            accent: true,
        },
        Some(Destination::Split(_, Axis::Down, false)) => DropHint {
            icon: LucideIcon::Rows2,
            label: "Split bottom",
            accent: true,
        },
        Some(Destination::Before(_) | Destination::Tab) => DropHint {
            icon: LucideIcon::PanelTop,
            label: "Move to tab",
            accent: true,
        },
        None => DropHint {
            icon: LucideIcon::GripVertical,
            label: "Drag to split or tab bar",
            accent: false,
        },
    }
}

fn clamp_drag_badge_origin(
    cursor: Point<Pixels>,
    viewport: Size<Pixels>,
    badge_w: f32,
    badge_h: f32,
) -> Point<Pixels> {
    let margin = 8.0_f32;
    let vw = f32::from(viewport.width);
    let vh = f32::from(viewport.height);
    let cx = f32::from(cursor.x);
    let cy = f32::from(cursor.y);

    let mut x = cx + 14.0;
    if x + badge_w + margin > vw {
        x = (cx - badge_w - 12.0).max(margin);
    }
    x = x.clamp(margin, (vw - badge_w - margin).max(margin));

    let mut y = cy + 16.0;
    if y + badge_h + margin > vh {
        y = (cy - badge_h - 12.0).max(margin);
    }
    y = y.clamp(margin, (vh - badge_h - margin).max(margin));

    point(px(x), px(y))
}
#[derive(Clone, Copy)]
enum Landing {
    Place(WindowHandle<Workspace>, Destination, Bounds<Pixels>),
    Outside,
    Cancel,
}

// Window placement is display-relative on macOS and uses per-monitor
// logical pixels on Windows. Only desktop coordinates cross window boundaries.
fn map_point(p: Point<Pixels>, from: Bounds<Pixels>, to: Bounds<Pixels>) -> Point<Pixels> {
    to.origin
        + point(
            to.size.width * ((p.x - from.left()) / from.size.width),
            to.size.height * ((p.y - from.top()) / from.size.height),
        )
}
pub(super) fn to_desktop(w: &Window, pos: Point<Pixels>, cx: &App) -> Point<Pixels> {
    let p = w.bounds().origin + pos;
    w.display(cx)
        .map_or(p, |d| map_point(p, d.bounds(), d.desktop_bounds()))
}
pub(super) fn from_desktop(w: &Window, p: Point<Pixels>, cx: &App) -> Point<Pixels> {
    w.display(cx)
        .map_or(p, |d| map_point(p, d.desktop_bounds(), d.bounds()))
        - w.bounds().origin
}

impl Workspace {
    pub(super) fn arm(
        &mut self,
        pane: Id,
        whole: bool,
        start: Point<Pixels>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_drag(cx);
        self.select(pane, w, cx);
        let tab = &self.tabs[self.current];
        let label = if whole && !tab.name.is_empty() {
            tab.name.clone()
        } else {
            self.panes[&pane].read(cx).title.clone()
        };
        let status = if whole {
            panes::pane_activity_state(panes::tab_representative(tab, &self.panes, cx))
        } else {
            panes::pane_activity_state(self.panes[&pane].read(cx))
        };
        self.drag.gesture = Some(Gesture {
            item: DragItem {
                pane,
                whole,
                label: DragLabel::new(label, self.panes[&pane].read(cx).mark, status),
                window: self.id,
            },
            start,
            cursor: start,
            outside: false,
            active: false,
            generation: next_id(),
            hover: None,
        });
    }

    // Window-level capture sees the release even outside the original hitbox.
    pub(super) fn drag_listener(&self, cx: &Context<Self>) -> impl IntoElement + use<> {
        let owner = cx.weak_entity();
        canvas(
            |_, _, _| (),
            move |_, (), w, _| {
                let source = owner.clone();
                w.on_mouse_event(move |e: &MouseMoveEvent, phase, w, cx| {
                    if phase != DispatchPhase::Capture {
                        return;
                    }
                    let _ = source.update(cx, |s, cx| {
                        if let Some((id, axis)) = s.resizing {
                            if e.pressed_button != Some(MouseButton::Left) {
                                s.resizing = None;
                                return;
                            }
                            if let Some(b) = s.bounds.get(&id)
                                && let Some(tab) = s.tabs.get_mut(s.current)
                            {
                                let ratio = if axis == Axis::Across {
                                    (e.position.x - b.left() - px(crate::layout::GAP / 2.))
                                        / (b.size.width - px(crate::layout::GAP)).max(px(1.))
                                } else {
                                    (e.position.y - b.top() - px(crate::layout::GAP / 2.))
                                        / (b.size.height - px(crate::layout::GAP)).max(px(1.))
                                };
                                tab.layout.resize(id, ratio);
                                cx.notify();
                                cx.stop_propagation();
                            }
                            return;
                        }
                        let Some(g) = s.drag.gesture.as_mut() else {
                            return;
                        };
                        if e.pressed_button != Some(MouseButton::Left) {
                            s.cancel_drag(cx);
                            return;
                        }
                        if !g.active
                            && f32::from(e.position.x - g.start.x)
                                .hypot(f32::from(e.position.y - g.start.y))
                                >= 8.
                        {
                            g.active = true;
                            g.cursor = e.position;
                            s.drag_tick(w, cx);
                            cx.notify();
                        } else if g.active && g.cursor != e.position {
                            let show_local_badge = !g.item.whole && !g.outside;
                            g.cursor = e.position;
                            if show_local_badge {
                                cx.notify();
                            }
                        }
                        if s.drag.gesture.as_ref().is_some_and(|g| g.active) {
                            cx.stop_propagation();
                        }
                    });
                });
                w.on_mouse_event(move |e: &MouseUpEvent, phase, w, cx| {
                    if phase == DispatchPhase::Capture && e.button == MouseButton::Left {
                        let _ = owner.update(cx, |s, cx| {
                            s.resizing = None;
                            s.release_drag(e.position, w, cx)
                        });
                    }
                });
            },
        )
        .absolute()
        .size_0()
    }
    fn drag_tick(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some(g) = self.drag.gesture.as_ref().filter(|g| g.active) else {
            return;
        };
        let generation = g.generation;
        let pos = w.mouse_position();
        let landing = self.landing(g, pos, w, cx);
        let target = match landing {
            Landing::Place(h, _, _) => Some(h),
            _ => None,
        };
        let old = g.hover;
        let mut label = g.item.label.clone();
        label.status = if g.item.whole {
            self.tabs
                .iter()
                .find(|t| t.layout.contains(g.item.pane))
                .and_then(|t| {
                    panes::pane_activity_state(panes::tab_representative(t, &self.panes, cx))
                })
        } else {
            self.panes
                .get(&g.item.pane)
                .and_then(|p| panes::pane_activity_state(p.read(cx)))
        };
        let moving_tab = self
            .tabs
            .iter()
            .find(|t| {
                t.layout.contains(g.item.pane)
                    && (g.item.whole || matches!(t.layout, Layout::Pane(_)))
            })
            .map(|t| t.id);
        let snapshot = match landing {
            Landing::Place(h, Destination::Before(_) | Destination::Tab, _)
                if AnyWindowHandle::from(h) != w.window_handle() =>
            {
                self.tabs
                    .iter()
                    .find(|t| t.layout.contains(g.item.pane))
                    .map(|t| {
                        let layout = if g.item.whole && !t.zoom {
                            t.layout.clone()
                        } else {
                            Layout::Pane(g.item.pane)
                        };
                        let panes = self
                            .panes
                            .iter()
                            .filter(|(id, _)| layout.contains(**id))
                            .map(|(id, p)| (*id, p.clone()))
                            .collect();
                        LivePreview { layout, panes }
                    })
            }
            _ => None,
        };
        let outside = matches!(landing, Landing::Outside);
        let show_cursor_badge =
            !g.item.whole || matches!(landing, Landing::Place(_, Destination::Split(..), _));
        self.update_ghost(outside, &label, to_desktop(w, pos, cx), cx);
        let cursor_changed = {
            let g_mut = self.drag.gesture.as_mut().unwrap();
            let changed = g_mut.cursor != pos || g_mut.outside != outside;
            g_mut.cursor = pos;
            g_mut.outside = outside;
            g_mut.hover = target;
            changed
        };
        if old != target {
            self.clear_preview(old, cx);
            cx.notify();
        } else if cursor_changed && show_cursor_badge && !outside {
            cx.notify();
        }
        if let Landing::Place(h, destination, bounds) = landing {
            let screen = to_desktop(w, pos, cx);
            if AnyWindowHandle::from(h) == w.window_handle() {
                let preview = Some(Preview {
                    moving_tab,
                    destination,
                    bounds,
                    label,
                    body: snapshot,
                    cursor: show_cursor_badge.then_some(pos),
                });
                self.preview_at(preview, pos, cx);
            } else {
                let _ = h.update(cx, |s, w, cx| {
                    let local = from_desktop(w, screen, cx);
                    let preview = Some(Preview {
                        moving_tab,
                        destination,
                        bounds,
                        label,
                        body: snapshot,
                        cursor: show_cursor_badge.then_some(local),
                    });
                    s.preview_at(preview, local, cx)
                });
            }
        }
        let weak = cx.weak_entity();
        w.on_next_frame(move |w, cx| {
            let _ = weak.update(cx, |s, cx| {
                if s.drag
                    .gesture
                    .as_ref()
                    .is_some_and(|g| g.generation == generation)
                {
                    s.drag_tick(w, cx)
                }
            });
        });
    }
    fn preview_at(&mut self, preview: Option<Preview>, pos: Point<Pixels>, cx: &mut Context<Self>) {
        let mut scrolled = false;
        if preview
            .as_ref()
            .is_some_and(|p| !matches!(p.destination, Destination::Split(..)))
        {
            let strip = &self.drag.strip;
            let b = strip.bounds();
            let max_x = strip.max_offset().x;
            if max_x > px(0.) && pos.y >= px(0.) && pos.y < px(56.) {
                let dx = if pos.x < b.left() + px(24.) {
                    px(6.)
                } else if pos.x > b.right() - px(24.) && pos.x < b.right() + px(60.) {
                    -px(6.)
                } else {
                    px(0.)
                };
                if dx != px(0.) {
                    let prev = strip.offset();
                    let mut offset = prev;
                    offset.x = (offset.x + dx).clamp(-max_x, px(0.));
                    if offset != prev {
                        strip.set_offset(offset);
                        scrolled = true;
                    }
                }
            }
        }
        let changed = self.drag.preview.as_ref().map(|p| {
            (
                p.destination,
                p.moving_tab,
                p.bounds,
                p.label.status,
                p.body.is_some(),
                p.cursor,
            )
        }) != preview.as_ref().map(|p| {
            (
                p.destination,
                p.moving_tab,
                p.bounds,
                p.label.status,
                p.body.is_some(),
                p.cursor,
            )
        });
        let has_live_body = preview.as_ref().is_some_and(|p| p.body.is_some());
        self.drag.preview = preview;
        if changed || scrolled || has_live_body {
            cx.notify();
        }
    }
    fn clear_preview(&mut self, target: Option<WindowHandle<Self>>, cx: &mut App) {
        self.drag.preview = None;
        if let Some(h) = target
            && AnyWindowHandle::from(h) != self.handle
        {
            let _ = h.update(cx, |s, _, cx| {
                s.drag.preview = None;
                cx.notify()
            });
        }
    }
    pub(super) fn cancel_drag(&mut self, cx: &mut Context<Self>) {
        if self.drag.gesture.is_some() {
            self.end_preview(cx);
            cx.notify();
        }
    }
    pub(super) fn end_preview(&mut self, cx: &mut App) {
        self.hide_ghost(cx);
        if let Some(g) = self.drag.gesture.take() {
            self.clear_preview(g.hover, cx);
        }
    }
    fn landing(
        &self,
        g: &Gesture,
        pos: Point<Pixels>,
        w: &Window,
        cx: &mut Context<Self>,
    ) -> Landing {
        let screen = to_desktop(w, pos, cx);
        let windows = cx.window_stack().unwrap_or_else(|| {
            let mut windows = cx.windows();
            windows.sort_by_cached_key(|h| {
                let order = if *h == w.window_handle() {
                    self.active_order
                } else {
                    h.downcast::<Self>()
                        .and_then(|h| h.read(cx).ok())
                        .map_or(0, |s| s.active_order)
                };
                std::cmp::Reverse(order)
            });
            windows
        });
        for raw in windows {
            let Some(h) = raw.downcast::<Self>() else {
                continue;
            };
            if raw == w.window_handle() {
                if Bounds::new(Point::default(), w.viewport_size()).contains(&pos) {
                    return self.hit(g, pos, h);
                }
            } else if let Ok(Some(landing)) = h.update(cx, |s, w, cx| {
                let local = from_desktop(w, screen, cx);
                let frame = Bounds::new(Point::default(), w.viewport_size());
                (w.is_visible() && frame.contains(&local)).then(|| s.hit(g, local, h))
            }) {
                return landing;
            }
        }
        Landing::Outside
    }
    fn hit(&self, g: &Gesture, pos: Point<Pixels>, h: WindowHandle<Self>) -> Landing {
        let reordering_same_tab = g.item.whole
            && g.item.window == self.id
            && self
                .tabs
                .get(self.current)
                .is_some_and(|t| t.layout.contains(g.item.pane));
        let bar_bottom = if reordering_same_tab {
            px(56.)
        } else {
            px(40.)
        };
        if pos.y >= px(0.) && pos.y < bar_bottom && pos.x >= px(0.) {
            let moving_tab = (g.item.window == self.id)
                .then(|| {
                    self.tabs
                        .iter()
                        .find(|t| {
                            t.layout.contains(g.item.pane)
                                && (g.item.whole || matches!(t.layout, Layout::Pane(_)))
                        })
                        .map(|t| t.id)
                })
                .flatten();
            let offset = self.drag.strip.offset();
            let slots: Vec<_> = self
                .drag
                .rendered_tabs
                .iter()
                .copied()
                .enumerate()
                .filter_map(|(i, slot)| {
                    let mut b = self.drag.strip.bounds_for_item(i)?;
                    b.origin += offset;
                    Some((slot, b))
                })
                .collect();
            let dest = resolve_tab_strip_drop(pos.x, &slots, moving_tab);
            return Landing::Place(h, dest, Bounds::default());
        }
        if self.page != Page::Terminal {
            return Landing::Cancel;
        }
        let Some(tab) = self.tabs.get(self.current) else {
            return Landing::Cancel;
        };
        for (&id, (_, source)) in &self.watches {
            if !tab.layout.contains(id) || tab.zoom && id != tab.active {
                continue;
            }
            let Some(mut b) = source.bounds().filter(|b| b.contains(&pos)) else {
                continue;
            };
            if g.item.window == self.id
                && (id == g.item.pane || g.item.whole && tab.layout.contains(g.item.pane))
            {
                return if g.item.whole {
                    Landing::Outside
                } else {
                    Landing::Cancel
                };
            }
            let x = (pos.x - b.left()) / b.size.width - 0.5;
            let y = (pos.y - b.top()) / b.size.height - 0.5;
            let (axis, before) = if x.abs() >= y.abs() {
                b.size.width /= 2.;
                if x > 0. {
                    b.origin.x += b.size.width;
                }
                (Axis::Across, x <= 0.)
            } else {
                b.size.height /= 2.;
                if y > 0. {
                    b.origin.y += b.size.height;
                }
                (Axis::Down, y <= 0.)
            };
            return Landing::Place(h, Destination::Split(id, axis, before), b);
        }
        Landing::Cancel
    }
    fn release_drag(&mut self, pos: Point<Pixels>, w: &mut Window, cx: &mut Context<Self>) {
        let Some(g) = self.drag.gesture.take() else {
            return;
        };
        if !g.active {
            return;
        }
        cx.stop_propagation();
        let dest = self.landing(&g, pos, w, cx);
        self.hide_ghost(cx);
        self.clear_preview(g.hover, cx);
        cx.notify();
        match dest {
            Landing::Outside => {
                let screen = to_desktop(w, pos, cx);
                let placement = cx.displays().into_iter().find_map(|d| {
                    let b = d.desktop_bounds();
                    if !b.contains(&screen) {
                        return None;
                    }
                    let visible = d.visible_bounds();
                    let sz = w.bounds().size.min(&visible.size);
                    let origin = map_point(screen, b, d.bounds()) - point(px(96.), px(18.));
                    let origin = point(
                        origin.x.clamp(visible.left(), visible.right() - sz.width),
                        origin.y.clamp(visible.top(), visible.bottom() - sz.height),
                    );
                    Some((Bounds::new(origin, sz), Some(d.id())))
                });
                if self.tabs.len() == 1
                    && (g.item.whole || self.panes.len() == 1)
                    && !w.is_fullscreen()
                    && !w.is_maximized()
                    && let Some((b, Some(id))) = placement
                    && let Some(d) = cx.find_display(id)
                    && w.move_on_display(d.as_ref(), b.origin - d.bounds().origin)
                {
                    if w.bounds().size != b.size {
                        w.resize(b.size);
                    }
                    return;
                }
                self.detach_item(&g.item, placement, w, cx);
            }
            Landing::Place(h, dest, _) if AnyWindowHandle::from(h) == w.window_handle() => {
                if let Destination::Before(at) = dest
                    && self
                        .tabs
                        .iter()
                        .any(|t| t.id == at && t.layout.contains(g.item.pane))
                    && (g.item.whole || matches!(self.tabs[self.current].layout, Layout::Pane(_)))
                {
                    return;
                }
                if let Some(t) = self.take_item(&g.item) {
                    self.receive(t, dest, w, cx);
                }
            }
            Landing::Place(h, dest, _) => self.transfer_to(&g.item, h, dest, w, cx),
            Landing::Cancel => {}
        }
    }
    pub(super) fn transfer_to(
        &mut self,
        item: &DragItem,
        h: WindowHandle<Self>,
        dest: Destination,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let moved = h.update(cx, |s, w, cx| {
            if let Some(t) = self.take_item(item) {
                s.receive(t, dest, w, cx);
                w.activate_window();
                true
            } else {
                false
            }
        });
        if matches!(moved, Ok(true)) {
            if self.tabs.is_empty() {
                w.remove_window()
            } else {
                self.show(Page::Terminal, w, cx)
            }
        }
    }
    pub(super) fn detach_item(
        &mut self,
        item: &DragItem,
        placement: Option<(Bounds<Pixels>, Option<DisplayId>)>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match crate::open_workspace_at(false, placement, cx) {
            Ok(h) => self.transfer_to(item, h, Destination::Tab, w, cx),
            Err(e) => {
                self.message = e.to_string();
                cx.notify()
            }
        }
    }
    fn update_ghost(
        &mut self,
        outside: bool,
        label: &DragLabel,
        screen: Point<Pixels>,
        cx: &mut Context<Self>,
    ) {
        if !outside {
            self.hide_ghost(cx);
            return;
        }
        let Some(d) = cx
            .displays()
            .into_iter()
            .find(|d| d.desktop_bounds().contains(&screen))
        else {
            return;
        };
        let offset = map_point(screen, d.desktop_bounds(), d.bounds()) - d.bounds().origin
            + point(px(12.), px(16.));
        if let Some((h, last)) = &mut self.drag.ghost {
            if *last != screen {
                *last = screen;
                let _ = h.update(cx, |_, w, _| w.move_on_display(d.as_ref(), offset));
            }
        } else {
            let opts = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    d.bounds().origin + offset,
                    size(px(268.), px(38.)),
                ))),
                display_id: Some(d.id()),
                kind: WindowKind::PopUp,
                focus: false,
                is_resizable: false,
                titlebar: None,
                ..Default::default()
            };
            if let Ok(h) = cx.open_window(opts, |_, cx| cx.new(|_| label.clone())) {
                self.drag.ghost = Some((h, screen))
            }
        }
    }
    pub(super) fn hide_ghost(&mut self, cx: &mut App) {
        if let Some((h, _)) = self.drag.ghost.take() {
            let _ = h.update(cx, |_, w, _| w.remove_window());
        }
    }
    // A provisional tab participates in layout, while the underlying ownership
    // tree stays intact. Hit testing its own slot keeps the previous anchor.
    pub(super) fn strip_slots(&self) -> Vec<Option<usize>> {
        let mut slots: Vec<_> = (0..self.tabs.len()).map(Some).collect();
        let Some(p) = &self.drag.preview else {
            return slots;
        };
        if matches!(p.destination, Destination::Split(..)) {
            return slots;
        }
        let anchor = match p.destination {
            Destination::Before(id) => self.tabs.iter().position(|t| t.id == id),
            _ => None,
        };
        let mut index = anchor.unwrap_or(slots.len());
        if let Some(source) = self.tabs.iter().position(|t| Some(t.id) == p.moving_tab) {
            slots.remove(source);
            if source < index {
                index -= 1;
            }
        }
        slots.insert(index, None);
        slots
    }
    pub(super) fn drag_overlay(&self, w: &Window) -> Option<AnyElement> {
        let preview = self.drag.preview.as_ref();
        let is_split = preview.is_some_and(|p| matches!(p.destination, Destination::Split(..)));
        let has_body = preview.is_some_and(|p| p.body.is_some());

        // Cursor-following floating card: shown during pane drags (both over drop targets and neutral
        // areas) and when dragging a tab over a split drop zone. Hidden while outside the window
        // because the OS popup ghost takes over seamlessly there.
        let cursor_card: Option<(&DragLabel, Point<Pixels>, Option<Destination>)> =
            if let Some(p) = preview
                && let Some(cursor) = p.cursor
            {
                Some((&p.label, cursor, Some(p.destination)))
            } else if let Some(g) = self.drag.gesture.as_ref()
                && g.active
                && !g.item.whole
                && !g.outside
                && g.hover.is_none()
            {
                Some((&g.item.label, g.cursor, None))
            } else {
                None
            };

        if !is_split && !has_body && cursor_card.is_none() {
            return None;
        }

        let mut layer = div().absolute().inset_0().overflow_hidden();
        if let Some(p) = preview
            && let Some(body) = &p.body
        {
            layer = layer.child(
                div()
                    .absolute()
                    .top(px(40.))
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .overflow_hidden()
                    .bg(rgb(BG))
                    .child(body.render(&body.layout)),
            );
        }
        if let Some(p) = preview
            && is_split
        {
            let b = p.bounds;
            let inset = px(4.);
            let w_box = (b.size.width - inset * 2.).max(px(12.));
            let h_box = (b.size.height - inset * 2.).max(px(12.));
            layer = layer.child(
                div()
                    .absolute()
                    .left(b.left() + inset)
                    .top(b.top() + inset)
                    .w(w_box)
                    .h(h_box)
                    .rounded(px(8.))
                    .bg(rgba(0x60a5fa24))
                    .border_2()
                    .border_color(rgba(0x60a5fad8)),
            );
        }
        if let Some((label, cursor, dest)) = cursor_card {
            let hint = drop_hint_for(dest);
            let origin = clamp_drag_badge_origin(
                cursor,
                w.viewport_size(),
                DRAG_BADGE_MAX_W,
                DRAG_BADGE_H,
            );
            layer = layer.child(
                row()
                    .absolute()
                    .left(origin.x)
                    .top(origin.y)
                    .max_w(px(DRAG_BADGE_MAX_W))
                    .h(px(DRAG_BADGE_H))
                    .px(px(10.))
                    .gap(px(7.))
                    .rounded(px(8.))
                    .backdrop_blur(px(12.))
                    .bg(rgba(0x18181cf0))
                    .border_1()
                    .border_color(if hint.accent {
                        rgba(0x60a5fa88)
                    } else {
                        rgba(0xffffff2c)
                    })
                    .shadow_lg()
                    .text_size(px(12.))
                    .text_color(rgb(0xf0f0f0))
                    .child(
                        lucide_icon(hint.icon)
                            .size(px(13.5))
                            .flex_none()
                            .text_color(if hint.accent {
                                rgb(0x93c5fd)
                            } else {
                                rgb(MUTED)
                            }),
                    )
                    .child(div().flex_1().min_w_0().child(label.tab_content()))
                    .when(hint.accent, |e| {
                        e.child(
                            div()
                                .flex_none()
                                .px(px(6.))
                                .py(px(1.5))
                                .rounded(px(4.))
                                .bg(rgba(0x3b82f630))
                                .text_size(px(10.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(rgb(0x93c5fd))
                                .child(hint.label),
                        )
                    }),
            );
        }
        Some(layer.into_any_element())
    }
}

/// Resolve the drop destination along the horizontal tab strip without oscillation.
///
/// When the dragged tab (or its provisional preview slot `None`) is present in `slots`,
/// the pointer stays anchored to that slot until it decisively crosses the horizontal
/// center of a neighboring real tab to the left or right. Because swapping shifts the
/// crossed tab by the preview slot's width, the pointer cannot immediately bounce back.
fn resolve_tab_strip_drop(
    pos_x: Pixels,
    slots: &[(Option<Id>, Bounds<Pixels>)],
    moving_tab: Option<Id>,
) -> Destination {
    let active_idx = slots
        .iter()
        .position(|(slot, _)| slot.is_none() || (moving_tab.is_some() && *slot == moving_tab));
    if let Some(pivot) = active_idx {
        for &(slot, bounds) in &slots[..pivot] {
            if let Some(tab) = slot
                && pos_x < bounds.center().x
            {
                return Destination::Before(tab);
            }
        }
        let mut after = None;
        for (offset, &(slot, bounds)) in slots[pivot + 1..].iter().enumerate() {
            if slot.is_some() && pos_x > bounds.center().x {
                after = Some(pivot + 1 + offset);
            }
        }
        let search_from = after.map_or(pivot + 1, |idx| idx + 1);
        slots[search_from..]
            .iter()
            .find_map(|&(slot, _)| slot.map(Destination::Before))
            .unwrap_or(Destination::Tab)
    } else {
        slots
            .iter()
            .find_map(|&(slot, bounds)| {
                let tab = slot?;
                (pos_x < bounds.center().x).then_some(Destination::Before(tab))
            })
            .unwrap_or(Destination::Tab)
    }
}

#[derive(Clone)]
pub(super) struct DragLabel {
    title: String,
    mark: Option<&'static AgentMark>,
    status: Option<ActivityState>,
}
impl DragLabel {
    pub(super) fn new(
        title: String,
        mark: Option<&'static AgentMark>,
        status: Option<ActivityState>,
    ) -> Self {
        Self {
            title,
            mark,
            status,
        }
    }
    pub(super) fn tab_content(&self) -> Div {
        row()
            .flex_1()
            .min_w_0()
            .gap(px(6.))
            .children(
                self.status
                    .map(|state| panes::activity_state_badge(state, px(16.), true)),
            )
            .children(self.mark.map(|m| m.icon(14.)))
            .child(div().flex_1().truncate().child(self.title.clone()))
    }
}
impl Render for DragLabel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        row()
            .size_full()
            .items_center()
            .px(px(10.))
            .gap(px(7.))
            .rounded(px(8.))
            .bg(rgb(0x18181c))
            .border_1()
            .border_color(rgba(0x60a5fa88))
            .text_size(px(12.))
            .text_color(rgb(0xf0f0f0))
            .child(
                lucide_icon(LucideIcon::AppWindow)
                    .size(px(13.5))
                    .flex_none()
                    .text_color(rgb(0x93c5fd)),
            )
            .child(div().flex_1().min_w_0().child(self.tab_content()))
            .child(
                div()
                    .flex_none()
                    .px(px(6.))
                    .py(px(1.5))
                    .rounded(px(4.))
                    .bg(rgba(0x3b82f630))
                    .text_size(px(10.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgb(0x93c5fd))
                    .child("New window"),
            )
    }
}
struct LivePreview {
    layout: Layout,
    panes: BTreeMap<Id, Entity<Pane>>,
}
impl LivePreview {
    fn render(&self, node: &Layout) -> AnyElement {
        match node {
            Layout::Pane(id) => {
                let p = self.panes[id].clone();
                col()
                    .size_full()
                    .overflow_hidden()
                    .p(px(5.))
                    .child(
                        canvas(
                            |_, _, _| (),
                            move |b, _, w, cx| {
                                p.update(cx, |pane, cx| pane.draw_at(b.origin, w, cx))
                            },
                        )
                        .size_full(),
                    )
                    .into_any_element()
            }
            Layout::Split {
                axis,
                ratio,
                first,
                second,
                ..
            } => div()
                .size_full()
                .flex()
                .when(*axis == Axis::Down, |e| e.flex_col())
                .child(
                    col()
                        .flex_none()
                        .when(*axis == Axis::Across, |e| e.w(relative(*ratio)).h_full())
                        .when(*axis == Axis::Down, |e| e.h(relative(*ratio)).w_full())
                        .child(self.render(first)),
                )
                .child(col().flex_1().child(self.render(second)))
                .into_any_element(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_bounds(x: f32, width: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(4.)), size(px(width), px(36.)))
    }

    #[::core::prelude::v1::test]
    fn tab_strip_drop_stays_stable_across_preview_and_adjacent_gaps() {
        // [A (42..252), PREVIEW (254..464), C (466..676)]
        let slots = vec![
            (Some(1), slot_bounds(42., 210.)),
            (None, slot_bounds(254., 210.)),
            (Some(3), slot_bounds(466., 210.)),
        ];

        // Anywhere between A.center (147) and C.center (571) stays anchored before C,
        // including the right half of A, the 2px gaps, the preview itself, and the left half of C.
        for x in [147., 200., 253., 254., 359., 464., 465., 466., 570., 571.] {
            assert_eq!(
                resolve_tab_strip_drop(px(x), &slots, Some(2)),
                Destination::Before(3),
                "unexpected jump at x={x}"
            );
        }
        // Crossing A.center to the left (including far-left over the logo) moves before A.
        assert_eq!(
            resolve_tab_strip_drop(px(146.), &slots, Some(2)),
            Destination::Before(1)
        );
        assert_eq!(
            resolve_tab_strip_drop(px(8.), &slots, Some(2)),
            Destination::Before(1)
        );
        // Crossing C.center to the right appends at the end.
        assert_eq!(
            resolve_tab_strip_drop(px(572.), &slots, Some(2)),
            Destination::Tab
        );
    }

    #[::core::prelude::v1::test]
    fn tab_strip_drop_never_oscillates_after_swap_even_with_variable_widths() {
        // Before swap: [A (42..172, w=130, center=107), PREVIEW (174..414, w=240)]
        let before_left = vec![
            (Some(1), slot_bounds(42., 130.)),
            (None, slot_bounds(174., 240.)),
        ];
        let trigger_left = px(106.);
        assert_eq!(
            resolve_tab_strip_drop(trigger_left, &before_left, Some(2)),
            Destination::Before(1)
        );
        // After swap: [PREVIEW (42..282, w=240), A (284..414, w=130, center=349)]
        let after_left = vec![
            (None, slot_bounds(42., 240.)),
            (Some(1), slot_bounds(284., 130.)),
        ];
        assert_eq!(
            resolve_tab_strip_drop(trigger_left, &after_left, Some(2)),
            Destination::Before(1),
            "holding pointer at trigger point must not bounce back right"
        );

        // Now drag back right past A's new center (349):
        let trigger_right = px(350.);
        assert_eq!(
            resolve_tab_strip_drop(trigger_right, &after_left, Some(2)),
            Destination::Tab
        );
        // After swapping right, layout returns to before_left where A.center=107:
        assert_eq!(
            resolve_tab_strip_drop(trigger_right, &before_left, Some(2)),
            Destination::Tab,
            "holding pointer at trigger point must not bounce back left"
        );
    }

    #[::core::prelude::v1::test]
    fn tab_strip_drop_handles_frame_zero_same_window_and_cross_window() {
        let slots = vec![
            (Some(1), slot_bounds(42., 210.)),
            (Some(2), slot_bounds(254., 210.)),
            (Some(3), slot_bounds(466., 210.)),
        ];

        // Frame 0 dragging tab 2 within its own window stays in place (Before(3)), never Before(2).
        assert_eq!(
            resolve_tab_strip_drop(px(260.), &slots, Some(2)),
            Destination::Before(3)
        );
        assert_eq!(
            resolve_tab_strip_drop(px(450.), &slots, Some(2)),
            Destination::Before(3)
        );
        // Fast jump across tab 1 center immediately moves to Before(1).
        assert_eq!(
            resolve_tab_strip_drop(px(100.), &slots, Some(2)),
            Destination::Before(1)
        );

        // Frame 0 cross-window drag (moving_tab = None) inserts before whichever tab center it's left of.
        assert_eq!(
            resolve_tab_strip_drop(px(100.), &slots, None),
            Destination::Before(1)
        );
        assert_eq!(
            resolve_tab_strip_drop(px(300.), &slots, None),
            Destination::Before(2)
        );
        assert_eq!(
            resolve_tab_strip_drop(px(500.), &slots, None),
            Destination::Before(3)
        );
        assert_eq!(
            resolve_tab_strip_drop(px(700.), &slots, None),
            Destination::Tab
        );
    }

    #[::core::prelude::v1::test]
    fn tab_strip_drop_handles_multi_tab_jumps_and_empty_strip() {
        let slots = vec![
            (None, slot_bounds(42., 210.)),
            (Some(1), slot_bounds(254., 210.)),
            (Some(2), slot_bounds(466., 210.)),
            (Some(3), slot_bounds(678., 210.)),
        ];
        // Jump from slot 0 past tab 1 (center 359) into tab 2 left half -> Before(2).
        assert_eq!(
            resolve_tab_strip_drop(px(400.), &slots, Some(9)),
            Destination::Before(2)
        );
        // Jump past tab 2 (center 571) into tab 3 left half -> Before(3).
        assert_eq!(
            resolve_tab_strip_drop(px(620.), &slots, Some(9)),
            Destination::Before(3)
        );
        // Jump past tab 3 (center 783) -> Tab.
        assert_eq!(
            resolve_tab_strip_drop(px(800.), &slots, Some(9)),
            Destination::Tab
        );
        // Empty strip always lands as Tab.
        assert_eq!(resolve_tab_strip_drop(px(100.), &[], None), Destination::Tab);
    }

    #[::core::prelude::v1::test]
    fn drag_badge_clamps_inside_viewport_and_describes_drop_targets() {
        let vp = size(px(800.), px(600.));

        // Mid-window cursor places the floating card cleanly below-right of the pointer.
        assert_eq!(
            clamp_drag_badge_origin(point(px(200.), px(150.)), vp, 240., 34.),
            point(px(214.), px(166.))
        );

        // Near right & bottom edges flips/clamps so the card never clips off-screen.
        let corner = clamp_drag_badge_origin(point(px(780.), px(590.)), vp, 240., 34.);
        assert!(f32::from(corner.x) + 240. <= 792. + 0.01);
        assert!(f32::from(corner.y) + 34. <= 592. + 0.01);
        assert!(f32::from(corner.x) >= 8. && f32::from(corner.y) >= 8.);

        // Drop hints distinguish every split direction, tab-bar drop, and neutral drag.
        assert_eq!(
            drop_hint_for(Some(Destination::Split(1, Axis::Across, true))).label,
            "Split left"
        );
        assert_eq!(
            drop_hint_for(Some(Destination::Split(1, Axis::Across, false))).label,
            "Split right"
        );
        assert_eq!(
            drop_hint_for(Some(Destination::Split(1, Axis::Down, true))).label,
            "Split top"
        );
        assert_eq!(
            drop_hint_for(Some(Destination::Split(1, Axis::Down, false))).label,
            "Split bottom"
        );
        assert_eq!(drop_hint_for(Some(Destination::Tab)).label, "Move to tab");
        assert!(!drop_hint_for(None).accent);
    }
}

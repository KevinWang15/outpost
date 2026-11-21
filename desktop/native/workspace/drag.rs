//! Keep ownership in the source window until release. The destination can paint
//! the current terminal frame without registering a second input handler or
//! resizing a PTY during hover.
use super::*;

pub(super) struct Gesture {
    item: DragItem,
    start: Point<Pixels>,
    active: bool,
    generation: Id,
    hover: Option<WindowHandle<Workspace>>,
}
#[derive(Default)]
pub(super) struct DragState {
    pub(super) gesture: Option<Gesture>,
    pub(super) strip: ScrollHandle,
    pub(super) rendered_tabs: Vec<Option<Id>>,
    pub(super) rendered_anchor: Option<Destination>,
    ghost: Option<(WindowHandle<DragLabel>, Point<Pixels>)>,
    pub(super) empty_bar: SnapshotSource,
    pub(super) preview: Option<Preview>,
}
pub(super) struct Preview {
    pub(super) destination: Destination,
    moving_tab: Option<Id>,
    bounds: Bounds<Pixels>,
    pub(super) label: String,
    body: Option<LivePreview>,
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
        self.drag.gesture = Some(Gesture {
            item: DragItem {
                pane,
                whole,
                label,
                window: self.id,
            },
            start,
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
                            s.drag_tick(w, cx);
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
        let label = g.item.label.clone();
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
        self.update_ghost(
            matches!(landing, Landing::Outside),
            &label,
            to_desktop(w, pos, cx),
            cx,
        );
        if old != target {
            self.clear_preview(old, cx);
            cx.notify();
        }
        self.drag.gesture.as_mut().unwrap().hover = target;
        if let Landing::Place(h, destination, bounds) = landing {
            let preview = Some(Preview {
                moving_tab,
                destination,
                bounds,
                label,
                body: snapshot,
            });
            let screen = to_desktop(w, pos, cx);
            if AnyWindowHandle::from(h) == w.window_handle() {
                self.preview_at(preview, pos, cx);
            } else {
                let _ = h.update(cx, |s, w, cx| {
                    s.preview_at(preview, from_desktop(w, screen, cx), cx)
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
        if preview
            .as_ref()
            .is_some_and(|p| !matches!(p.destination, Destination::Split(..)))
        {
            let strip = &self.drag.strip;
            let b = strip.bounds();
            if b.contains(&pos) {
                let dx = if pos.x < b.left() + px(24.) {
                    px(6.)
                } else if pos.x > b.right() - px(24.) {
                    -px(6.)
                } else {
                    px(0.)
                };
                let mut offset = strip.offset();
                offset.x = (offset.x + dx).clamp(-strip.max_offset().x, px(0.));
                strip.set_offset(offset);
            }
        }
        self.drag.preview = preview;
        cx.notify()
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
        let strip = self.drag.strip.bounds();
        let end = self
            .drag
            .empty_bar
            .bounds()
            .map_or(strip.right(), |b| b.right());
        if pos.y >= px(0.) && pos.y < px(40.) && pos.x >= strip.left() && pos.x < end {
            let mut marker = strip.right();
            let mut dest = Destination::Tab;
            for (i, slot) in self.drag.rendered_tabs.iter().copied().enumerate() {
                let Some(mut b) = self.drag.strip.bounds_for_item(i) else {
                    continue;
                };
                b.origin += self.drag.strip.offset();
                if let Some(tab) = slot {
                    if pos.x < b.center().x {
                        dest = Destination::Before(tab);
                        marker = b.left();
                        break;
                    }
                } else if pos.x >= b.left() && pos.x < b.right() {
                    dest = self.drag.rendered_anchor.unwrap_or(Destination::Tab);
                    marker = b.left();
                    break;
                }
                marker = b.right();
            }
            marker = marker.clamp(strip.left(), end);
            return Landing::Place(
                h,
                dest,
                Bounds::new(point(marker, px(3.)), size(px(3.), px(34.))),
            );
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
        label: &str,
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
                    size(px(240.), px(40.)),
                ))),
                display_id: Some(d.id()),
                kind: WindowKind::PopUp,
                focus: false,
                is_resizable: false,
                titlebar: None,
                ..Default::default()
            };
            if let Ok(h) = cx.open_window(opts, |_, cx| cx.new(|_| DragLabel(label.to_owned()))) {
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
    pub(super) fn drag_overlay(&self) -> Option<AnyElement> {
        let p = self.drag.preview.as_ref()?;
        let b = p.bounds;
        let mut layer = div().absolute().inset_0().overflow_hidden();
        if let Some(preview) = &p.body {
            layer = layer.child(
                div()
                    .absolute()
                    .top(px(40.))
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .overflow_hidden()
                    .bg(rgb(BG))
                    .child(preview.render(&preview.layout)),
            );
        }
        layer = layer.child(
            div()
                .absolute()
                .left(b.left())
                .top(b.top())
                .w(b.size.width)
                .h(b.size.height)
                .bg(rgba(0xa5c9ff38))
                .border_2()
                .border_color(rgb(0xa5c9ff)),
        );
        Some(layer.into_any_element())
    }
}

struct DragLabel(String);
impl Render for DragLabel {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        row()
            .size_full()
            .items_center()
            .px(px(12.))
            .bg(rgb(0x1a1a1a))
            .border_1()
            .border_color(rgb(0x5a5a5a))
            .text_color(rgb(TEXT))
            .truncate()
            .child(self.0.clone())
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

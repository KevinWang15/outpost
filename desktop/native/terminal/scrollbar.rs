use super::Pane;
use alacritty_terminal::{
    grid::{Dimensions, Scroll},
    term::TermMode,
};
use gpui::*;
use std::time::{Duration, Instant};

const SCROLLBAR_HIT_REST_W: f32 = 12.0;
const SCROLLBAR_HIT_HOVER_W: f32 = 14.0;
const SCROLLBAR_TRACK_W: f32 = 14.0;
const SCROLLBAR_THUMB_IDLE_W: f32 = 4.0;
const SCROLLBAR_THUMB_ACTIVE_W: f32 = 6.0;
const SCROLLBAR_THUMB_HOVER_W: f32 = 8.0;
const SCROLLBAR_THUMB_RIGHT_PAD: f32 = 3.0;
const SCROLLBAR_PAD_Y: f32 = 2.0;
const SCROLLBAR_MIN_THUMB_H: f32 = 28.0;
const SCROLLBAR_HOLD_MS: u64 = 1_000;
const SCROLLBAR_FADE_MS: f32 = 260.0;
const SCROLLBAR_HOVER_MS: f32 = 110.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct ScrollbarGeometry {
    pub(super) track_top: f32,
    pub(super) thumb_top: f32,
    pub(super) thumb_h: f32,
    pub(super) max_travel: f32,
    history: usize,
    pub(super) display_offset: usize,
}

impl ScrollbarGeometry {
    pub(super) fn compute(
        bounds_top: f32,
        bounds_h: f32,
        history: usize,
        screen_lines: usize,
        display_offset: usize,
    ) -> Option<Self> {
        if history == 0 || screen_lines == 0 || bounds_h < 16.0 {
            return None;
        }
        let track_top = bounds_top + SCROLLBAR_PAD_Y;
        let track_h = (bounds_h - 2.0 * SCROLLBAR_PAD_Y).max(1.0);
        let total_lines = (history + screen_lines) as f32;
        let raw_thumb_h = (screen_lines as f32 / total_lines) * track_h;
        let thumb_h = raw_thumb_h.clamp(SCROLLBAR_MIN_THUMB_H.min(track_h), track_h);
        let max_travel = (track_h - thumb_h).max(0.0);
        let clamped_offset = display_offset.min(history);
        let top_frac = 1.0 - (clamped_offset as f32 / history as f32);
        let thumb_top = track_top + top_frac * max_travel;
        Some(Self {
            track_top,
            thumb_top,
            thumb_h,
            max_travel,
            history,
            display_offset: clamped_offset,
        })
    }

    pub(super) fn offset_for_thumb_top(&self, thumb_top: f32) -> usize {
        if self.max_travel <= 0.0 || self.history == 0 {
            return 0;
        }
        let frac = ((thumb_top - self.track_top) / self.max_travel).clamp(0.0, 1.0);
        ((1.0 - frac) * self.history as f32).round() as usize
    }

    pub(super) fn contains_thumb_y(&self, y: f32) -> bool {
        y >= self.thumb_top && y <= self.thumb_top + self.thumb_h
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct ScrollbarDrag {
    pub(super) grab_offset: f32,
}

#[derive(Default)]
pub(super) struct ScrollbarState {
    pub(super) hovered: bool,
    hover_t: f32,
    hover_anim_from: f32,
    hover_anim_at: Option<Instant>,
    pub(super) drag: Option<ScrollbarDrag>,
    activity_at: Option<Instant>,
    fade_token: u64,
}

fn ease_out_cubic(t: f32) -> f32 {
    let u = 1.0 - t.clamp(0.0, 1.0);
    1.0 - u * u * u
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

fn white_alpha(alpha: f32) -> Rgba {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgba(0xffffff00 | a)
}

fn black_alpha(alpha: f32) -> Rgba {
    let a = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    rgba(a)
}

impl Pane {
    pub(super) fn scrollbar_visible(&self) -> bool {
        !self.term.mode().contains(TermMode::ALT_SCREEN) && self.term.history_size() > 0
    }

    pub(super) fn scrollbar_geometry(&self) -> Option<ScrollbarGeometry> {
        if !self.scrollbar_visible() {
            return None;
        }
        ScrollbarGeometry::compute(
            f32::from(self.bounds.top()),
            f32::from(self.bounds.size.height),
            self.term.history_size(),
            self.term.screen_lines(),
            self.term.grid().display_offset(),
        )
    }

    pub(super) fn scrollbar_hit_contains(&self, pos: Point<Pixels>) -> bool {
        if !self.scrollbar_visible() || f32::from(self.bounds.size.height) < 16.0 {
            return false;
        }
        let hit_w = if self.scrollbar.hovered || self.scrollbar.drag.is_some() {
            SCROLLBAR_HIT_HOVER_W
        } else {
            SCROLLBAR_HIT_REST_W
        };
        pos.x >= self.bounds.right() - px(hit_w)
            && pos.x <= self.bounds.right()
            && pos.y >= self.bounds.top()
            && pos.y <= self.bounds.bottom()
    }

    pub(super) fn set_display_offset(&mut self, target_offset: usize) -> bool {
        let clamped = target_offset.min(self.term.history_size()) as i32;
        let current = self.term.grid().display_offset() as i32;
        let delta = clamped - current;
        if delta != 0 {
            self.term.scroll_display(Scroll::Delta(delta));
            return true;
        }
        false
    }

    pub(super) fn scroll_display_and_notify(&mut self, scroll: Scroll, cx: &mut Context<Self>) {
        self.term.scroll_display(scroll);
        self.note_scroll_activity(cx);
        cx.notify();
    }

    pub(super) fn set_scrollbar_hovered(&mut self, hovered: bool, cx: &mut Context<Self>) {
        let next = hovered && self.scrollbar_visible();
        if self.scrollbar.hovered == next {
            return;
        }
        self.scrollbar.hover_anim_from = self.scrollbar.hover_t;
        self.scrollbar.hover_anim_at = Some(Instant::now());
        self.scrollbar.hovered = next;
        cx.notify();
    }

    pub(super) fn note_scroll_activity(&mut self, cx: &mut Context<Self>) {
        if !self.scrollbar_visible() {
            return;
        }
        self.scrollbar.activity_at = Some(Instant::now());
        self.scrollbar.fade_token = self.scrollbar.fade_token.wrapping_add(1);
        let token = self.scrollbar.fade_token;
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(SCROLLBAR_HOLD_MS))
                .await;
            let _ = this.update(cx, |s, cx| {
                if s.scrollbar.fade_token == token {
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn paint_scrollbar(&mut self, w: &mut Window) {
        let h = f32::from(self.bounds.size.height);
        if h < 16. {
            return;
        }
        let show_bar = self.scrollbar_visible();
        let show_marks = self.search.active && !self.search.matches.is_empty();
        if !show_bar {
            self.scrollbar.hovered = false;
            self.scrollbar.drag = None;
            self.scrollbar.hover_t = 0.0;
            self.scrollbar.hover_anim_at = None;
            self.scrollbar.activity_at = None;
        }
        if !show_bar && !show_marks {
            return;
        }

        let now = Instant::now();
        let hover_target = if show_bar && (self.scrollbar.hovered || self.scrollbar.drag.is_some())
        {
            1.0
        } else {
            0.0
        };
        if let Some(started) = self.scrollbar.hover_anim_at {
            let t = (now.saturating_duration_since(started).as_secs_f32() * 1000.0
                / SCROLLBAR_HOVER_MS)
                .clamp(0.0, 1.0);
            self.scrollbar.hover_t = lerp(
                self.scrollbar.hover_anim_from,
                hover_target,
                ease_out_cubic(t),
            );
            if t < 1.0 {
                w.request_animation_frame();
            } else {
                self.scrollbar.hover_t = hover_target;
                self.scrollbar.hover_anim_at = None;
            }
        } else {
            self.scrollbar.hover_t = hover_target;
        }
        let hover_t = self.scrollbar.hover_t;

        let activity_t = if let Some(at) = self.scrollbar.activity_at {
            let elapsed_ms = now.saturating_duration_since(at).as_secs_f32() * 1000.0;
            let hold_ms = SCROLLBAR_HOLD_MS as f32;
            if elapsed_ms < hold_ms {
                1.0
            } else {
                let fade_t = ((elapsed_ms - hold_ms) / SCROLLBAR_FADE_MS).clamp(0.0, 1.0);
                if fade_t < 1.0 {
                    w.request_animation_frame();
                    1.0 - ease_out_cubic(fade_t)
                } else {
                    self.scrollbar.activity_at = None;
                    0.0
                }
            }
        } else {
            0.0
        };

        let bounds_top = f32::from(self.bounds.top());
        let bounds_right = f32::from(self.bounds.right());
        let track_top = bounds_top + SCROLLBAR_PAD_Y;
        let track_h = (h - 2.0 * SCROLLBAR_PAD_Y).max(1.0);
        let track_x = bounds_right - SCROLLBAR_TRACK_W;

        // Subtle macOS / iTerm2 overlay track that softly fades in on hover or search marks.
        let track_alpha = (if show_bar { hover_t * 0.065 } else { 0.0 })
            .max(if show_marks { 0.04 } else { 0.0 });
        if track_alpha > 0.004 {
            w.paint_quad(fill(
                Bounds::new(
                    point(px(track_x), px(bounds_top)),
                    size(px(SCROLLBAR_TRACK_W), px(h)),
                ),
                white_alpha(track_alpha),
            ));
        }
        if show_bar && hover_t > 0.02 {
            w.paint_quad(fill(
                Bounds::new(point(px(track_x), px(bounds_top)), size(px(1.), px(h))),
                white_alpha(hover_t * 0.11),
            ));
        }

        let history = self.term.history_size();
        let screen_lines = self.term.screen_lines().max(1);
        let total_lines = (history + screen_lines) as f32;

        // Paint search match tick marks inside the scrollbar lane (behind the thumb).
        if show_marks {
            let mark_w = lerp(4.0, 10.0, hover_t);
            let mark_x =
                bounds_right - SCROLLBAR_THUMB_RIGHT_PAD - mark_w.min(SCROLLBAR_TRACK_W - 4.0);
            let mut last_y = i32::MIN;
            for m in &self.search.matches {
                let line_idx = (m.start().line.0 + history as i32).max(0) as f32;
                let frac = (line_idx / total_lines).clamp(0.0, 1.0);
                let y = (track_top + frac * (track_h - 2.0).max(0.0)).round() as i32;
                if y - last_y < 2 {
                    continue;
                }
                last_y = y;
                w.paint_quad(fill(
                    Bounds::new(point(px(mark_x), px(y as f32)), size(px(mark_w), px(2.))),
                    rgba(0xe09f1fc4),
                ));
            }
        }

        // Paint capsule overlay thumb pill.
        if let Some(geom) = self.scrollbar_geometry() {
            let scrolled_up = geom.display_offset > 0;
            let active_factor = activity_t.max(if scrolled_up { 0.45 } else { 0.0 });
            let rest_w = lerp(SCROLLBAR_THUMB_IDLE_W, SCROLLBAR_THUMB_ACTIVE_W, active_factor);
            let thumb_w = lerp(rest_w, SCROLLBAR_THUMB_HOVER_W, hover_t);
            let thumb_x = bounds_right - SCROLLBAR_THUMB_RIGHT_PAD - thumb_w;
            let base_alpha = if scrolled_up {
                lerp(0.30, 0.42, activity_t)
            } else {
                lerp(0.18, 0.38, activity_t)
            };
            let thumb_alpha = if self.scrollbar.drag.is_some() {
                0.66
            } else {
                lerp(base_alpha, 0.50, hover_t)
            };
            let radius = px(thumb_w * 0.5);
            w.paint_quad(quad(
                Bounds::new(
                    point(px(thumb_x), px(geom.thumb_top)),
                    size(px(thumb_w), px(geom.thumb_h)),
                ),
                Corners::all(radius),
                white_alpha(thumb_alpha),
                Edges::all(px(1.0)),
                black_alpha(thumb_alpha * 0.45),
                BorderStyle::Solid,
            ));
        }

        // Paint the active search match marker on top so it always stays unmistakable.
        if show_marks
            && let Some(active) = self.search.current.and_then(|i| self.search.matches.get(i))
        {
            let line_idx = (active.start().line.0 + history as i32).max(0) as f32;
            let frac = (line_idx / total_lines).clamp(0.0, 1.0);
            let y = (track_top + frac * (track_h - 3.0).max(0.0)).round();
            let mark_w = lerp(6.0, 11.0, hover_t);
            let mark_x = bounds_right - 2.0 - mark_w;
            w.paint_quad(quad(
                Bounds::new(point(px(mark_x), px(y)), size(px(mark_w), px(3.))),
                Corners::all(px(1.5)),
                rgb(0xfacc15),
                Edges::default(),
                transparent_black(),
                BorderStyle::Solid,
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{SCROLLBAR_MIN_THUMB_H, SCROLLBAR_PAD_Y, ScrollbarGeometry};

    #[test]
    fn scrollbar_geometry_maps_top_bottom_clamped_thumb_and_drag_bijectively() {
        // Hidden when there is no scrollback or collapsed viewport.
        assert_eq!(ScrollbarGeometry::compute(0.0, 400.0, 0, 24, 0), None);
        assert_eq!(ScrollbarGeometry::compute(0.0, 10.0, 100, 24, 0), None);

        // Live bottom (offset = 0) aligns flush with bottom of track; top (offset = history) aligns with top.
        let bottom = ScrollbarGeometry::compute(10.0, 400.0, 500, 25, 0).unwrap();
        let track_bottom = 10.0 + 400.0 - SCROLLBAR_PAD_Y;
        assert!((bottom.track_top - (10.0 + SCROLLBAR_PAD_Y)).abs() < 1e-4);
        assert!(((bottom.thumb_top + bottom.thumb_h) - track_bottom).abs() < 1e-4);
        assert_eq!(bottom.offset_for_thumb_top(bottom.thumb_top), 0);

        let top = ScrollbarGeometry::compute(10.0, 400.0, 500, 25, 500).unwrap();
        assert!((top.thumb_top - top.track_top).abs() < 1e-4);
        assert_eq!(top.offset_for_thumb_top(top.thumb_top), 500);

        // Huge 100,000-line scrollback clamps thumb to SCROLLBAR_MIN_THUMB_H while preserving exact top/mid/bottom mapping.
        let huge = ScrollbarGeometry::compute(0.0, 500.0, 100_000, 30, 0).unwrap();
        assert!((huge.thumb_h - SCROLLBAR_MIN_THUMB_H).abs() < 1e-4);
        assert_eq!(huge.offset_for_thumb_top(huge.track_top), 100_000);
        assert_eq!(
            huge.offset_for_thumb_top(huge.track_top + huge.max_travel),
            0
        );
        assert_eq!(
            huge.offset_for_thumb_top(huge.track_top + huge.max_travel * 0.5),
            50_000
        );
        // Overshooting beyond track clamps cleanly to history / 0.
        assert_eq!(huge.offset_for_thumb_top(huge.track_top - 200.0), 100_000);
        assert_eq!(huge.offset_for_thumb_top(huge.track_top + 2_000.0), 0);
    }
}

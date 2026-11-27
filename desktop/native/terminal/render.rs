use super::{
    FAMILY, Pane,
    search::{SEARCH_ACTIVE_BG, SEARCH_ACTIVE_FG, SEARCH_MATCH_BG, match_contains_cell},
};
use crate::{box_glyphs, colors};
use alacritty_terminal::{
    grid::Dimensions,
    index::{Line, Point as CellPoint},
    term::{RenderableContent, cell::Flags},
    vte::ansi::CursorShape,
};
use gpui::*;
use std::ops::RangeInclusive;

fn terminal_font_features() -> FontFeatures {
    static FEATURES: std::sync::LazyLock<FontFeatures> = std::sync::LazyLock::new(|| {
        FontFeatures(std::sync::Arc::new(vec![
            ("calt".into(), 0),
            ("liga".into(), 0),
            ("clig".into(), 0),
        ]))
    });
    FEATURES.clone()
}

pub(super) fn terminal_font(flags: Flags) -> Font {
    let mut face = font(FAMILY);
    face.features = terminal_font_features();
    if flags.contains(Flags::BOLD) {
        face.weight = FontWeight::BOLD;
    }
    if flags.contains(Flags::ITALIC) {
        face.style = FontStyle::Italic;
    }
    face
}

fn is_batchable_ascii(c: char) -> bool {
    matches!(c, ' '..='~')
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) struct BgRun {
    pub(super) line: i32,
    pub(super) col: usize,
    pub(super) width: usize,
    pub(super) color: u32,
}

impl BgRun {
    fn paint(self, pane: &Pane, grid_origin: Point<Pixels>, w: &mut Window) {
        let bounds = box_glyphs::snapped_cell_bounds(
            grid_origin,
            pane.cell,
            self.line,
            self.col,
            self.width,
            w.scale_factor(),
        );
        w.paint_quad(fill(bounds, rgb(self.color)));
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(super) struct Ink {
    pub(super) fg: u32,
    pub(super) flags: Flags,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct GlyphRun {
    pub(super) line: i32,
    pub(super) col: usize,
    pub(super) width: usize,
    pub(super) cells: usize,
    pub(super) isolated: bool,
    pub(super) ink: Ink,
    pub(super) text: String,
}

impl GlyphRun {
    pub(super) fn shape(
        &self,
        font_size: Pixels,
        cell_width: Pixels,
        ts: &WindowTextSystem,
    ) -> ShapedLine {
        let face = terminal_font(self.ink.flags);
        let run = TextRun {
            len: self.text.len(),
            font: face,
            color: rgb(self.ink.fg).into(),
            background_color: None,
            underline: self.ink.flags.intersects(Flags::ALL_UNDERLINES).then_some(
                UnderlineStyle {
                    thickness: px(1.),
                    ..Default::default()
                },
            ),
            strikethrough: self.ink.flags.contains(Flags::STRIKEOUT).then_some(
                StrikethroughStyle {
                    thickness: px(1.),
                    ..Default::default()
                },
            ),
        };
        let force_width = (!self.isolated && self.cells > 1).then_some(cell_width);
        ts.shape_line(self.text.clone().into(), font_size, &[run], force_width)
    }

    fn paint(self, pane: &Pane, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        if self.isolated && self.width == 1 {
            let mut chars = self.text.chars();
            if let (Some(ch), None) = (chars.next(), chars.next())
                && box_glyphs::paint(
                    ch,
                    grid_origin,
                    pane.cell,
                    self.line,
                    self.col,
                    self.ink.fg,
                    self.ink.flags.intersects(Flags::ALL_UNDERLINES),
                    self.ink.flags.contains(Flags::STRIKEOUT),
                    w,
                )
            {
                return;
            }
        }
        let base = grid_origin
            + point(
                pane.cell.width * self.col as f32,
                pane.cell.height * self.line as f32,
            );
        let line = self.shape(px(pane.font_size), pane.cell.width, w.text_system());
        let _ = line.paint(base, pane.cell.height, TextAlign::Left, None, w, cx);
    }
}

pub(super) fn plan_draw_runs(
    view: RenderableContent<'_>,
    focused: bool,
    search_matches: &[RangeInclusive<CellPoint>],
    active_match: Option<&RangeInclusive<CellPoint>>,
    screen_lines: usize,
) -> (Vec<BgRun>, Vec<GlyphRun>) {
    let cursor = view.cursor.point;
    let block_cursor = focused && view.cursor.shape == CursorShape::Block;
    let mut bgs = Vec::new();
    let mut glyphs = Vec::new();
    let mut pending_bg: Option<BgRun> = None;
    let mut pending_glyph: Option<GlyphRun> = None;

    let visible_top = Line(-(view.display_offset as i32));
    let visible_bottom = Line(screen_lines as i32 - 1 - view.display_offset as i32);
    let visible_matches = if search_matches.is_empty() {
        &[][..]
    } else {
        let lo = search_matches.partition_point(|m| m.end().line < visible_top);
        let hi = search_matches.partition_point(|m| m.start().line <= visible_bottom);
        &search_matches[lo.min(hi)..hi]
    };
    let mut match_cursor = 0usize;

    let push_bg = |pending: &mut Option<BgRun>, out: &mut Vec<BgRun>, row, col, width, color| {
        if color == colors::BG {
            if let Some(r) = pending.take() {
                out.push(r);
            }
            return;
        }
        if let Some(r) = pending.as_mut()
            && r.line == row
            && r.col + r.width == col
            && r.color == color
        {
            r.width += width;
            return;
        }
        if let Some(r) = pending.take() {
            out.push(r);
        }
        *pending = Some(BgRun {
            line: row,
            col,
            width,
            color,
        });
    };

    let flush_glyph = |pending: &mut Option<GlyphRun>, out: &mut Vec<GlyphRun>| {
        let Some(mut run) = pending.take() else {
            return;
        };
        if !run
            .ink
            .flags
            .intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT)
        {
            if !run.isolated {
                let trimmed = run.text.trim_end_matches(' ').len();
                if trimmed == 0 {
                    return;
                }
                run.text.truncate(trimmed);
                run.width = trimmed;
                run.cells = trimmed;
            } else if run.text.trim().is_empty() {
                return;
            }
        }
        out.push(run);
    };

    for item in view.display_iter {
        let cell = item.cell;
        let row = item.point.line.0 + view.display_offset as i32;
        let col = item.point.column.0;
        if cell
            .flags
            .intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER)
        {
            continue;
        }
        let mut fg = colors::resolve(cell.fg, view.colors);
        let mut bg = colors::resolve(cell.bg, view.colors);
        if cell.flags.contains(Flags::DIM) {
            fg = colors::dim(fg)
        }
        if cell.flags.contains(Flags::INVERSE) {
            std::mem::swap(&mut fg, &mut bg)
        }
        let wide = cell.flags.contains(Flags::WIDE_CHAR);
        let selected = view.selection.is_some_and(|s| {
            s.contains(item.point)
                || (wide && s.contains(CellPoint::new(item.point.line, item.point.column + 1)))
        });
        while match_cursor < visible_matches.len()
            && *visible_matches[match_cursor].end() < item.point
        {
            match_cursor += 1;
        }
        let in_search_match = visible_matches
            .get(match_cursor)
            .is_some_and(|m| match_contains_cell(m, item.point, wide))
            || (wide
                && visible_matches
                    .get(match_cursor + 1)
                    .is_some_and(|m| match_contains_cell(m, item.point, wide)));
        let in_active_match = active_match.is_some_and(|m| match_contains_cell(m, item.point, wide));
        if selected {
            bg = 0x2b4c7e;
            if cell.flags.contains(Flags::INVERSE) {
                fg = colors::FG;
            }
        } else if in_active_match {
            bg = SEARCH_ACTIVE_BG;
            fg = SEARCH_ACTIVE_FG;
        } else if in_search_match {
            bg = SEARCH_MATCH_BG;
            if cell.flags.contains(Flags::INVERSE) || fg == bg {
                fg = colors::FG;
            }
        }
        if block_cursor && item.point == cursor {
            fg = colors::BG;
            bg = colors::FG;
        }
        let width = if wide { 2 } else { 1 };
        push_bg(&mut pending_bg, &mut bgs, row, col, width, bg);

        let flags =
            cell.flags & (Flags::BOLD | Flags::ITALIC | Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
        let ink = Ink { fg, flags };
        let decorated = flags.intersects(Flags::ALL_UNDERLINES | Flags::STRIKEOUT);
        let hidden = cell.flags.contains(Flags::HIDDEN);
        let ch = if hidden { ' ' } else { cell.c };
        let has_zerowidth = !hidden && cell.zerowidth().is_some();
        // Fallback fonts, combining clusters, and wide glyphs have independent advances and
        // must be anchored to their own grid cell so following columns never drift.
        let isolated = width == 2 || has_zerowidth || !is_batchable_ascii(ch);
        if isolated {
            flush_glyph(&mut pending_glyph, &mut glyphs);
            let mut text = String::new();
            if hidden {
                for _ in 0..width {
                    text.push(' ');
                }
            } else {
                text.push(ch);
                if let Some(extra) = cell.zerowidth() {
                    text.extend(extra.iter().copied());
                }
            }
            if decorated || !text.trim().is_empty() {
                glyphs.push(GlyphRun {
                    line: row,
                    col,
                    width,
                    cells: if hidden { width } else { 1 },
                    isolated: !hidden,
                    ink,
                    text,
                });
            }
            continue;
        }
        if let Some(r) = pending_glyph.as_mut()
            && r.line == row
            && r.col + r.width == col
            && r.ink == ink
        {
            r.width += 1;
            r.cells += 1;
            r.text.push(ch);
        } else {
            flush_glyph(&mut pending_glyph, &mut glyphs);
            if ch != ' ' || decorated {
                let mut text = String::new();
                text.push(ch);
                pending_glyph = Some(GlyphRun {
                    line: row,
                    col,
                    width: 1,
                    cells: 1,
                    isolated: false,
                    ink,
                    text,
                });
            }
        }
    }
    if let Some(r) = pending_bg {
        bgs.push(r);
    }
    flush_glyph(&mut pending_glyph, &mut glyphs);
    (bgs, glyphs)
}

impl Pane {
    pub(crate) fn draw_at(&mut self, grid_origin: Point<Pixels>, w: &mut Window, cx: &mut App) {
        if !self.grid_visible {
            return;
        }
        self.refresh_search_if_dirty();
        let screen_lines = self.term.screen_lines();
        let view = self.term.renderable_content();
        let cursor = view.cursor.point;
        let cursor_shape = view.cursor.shape;
        let cursor_row = cursor.line.0 + view.display_offset as i32;
        let cursor_origin = grid_origin
            + point(
                self.cell.width * cursor.column.0 as f32,
                self.cell.height * cursor_row as f32,
            );
        let focused = self.focus.is_focused(w);
        let active_match = self
            .search
            .current
            .and_then(|i| self.search.matches.get(i));
        let (bgs, glyphs) = plan_draw_runs(
            view,
            focused,
            &self.search.matches,
            active_match,
            screen_lines,
        );
        for bg in bgs {
            bg.paint(self, grid_origin, w);
        }
        for glyph in glyphs {
            glyph.paint(self, grid_origin, w, cx);
        }
        if cursor_row >= 0 && (cursor_row as usize) < self.term.screen_lines() {
            if cursor_shape != CursorShape::Hidden {
                let cursor_cells = if cursor.line.0 >= -(self.term.history_size() as i32)
                    && cursor.line.0 < self.term.screen_lines() as i32
                    && cursor.column.0 < self.term.columns()
                    && self.term.grid()[cursor].flags.contains(Flags::WIDE_CHAR)
                {
                    2
                } else {
                    1
                };
                let cursor_bounds = box_glyphs::snapped_cell_bounds(
                    grid_origin,
                    self.cell,
                    cursor_row,
                    cursor.column.0,
                    cursor_cells,
                    w.scale_factor(),
                );
                let overlay = match cursor_shape {
                    CursorShape::Beam => Some(Bounds::new(
                        cursor_bounds.origin,
                        size(px(2.), cursor_bounds.size.height),
                    )),
                    CursorShape::Underline => Some(Bounds::new(
                        point(cursor_bounds.left(), cursor_bounds.bottom() - px(2.)),
                        size(cursor_bounds.size.width, px(2.)),
                    )),
                    _ if !focused => Some(Bounds::new(
                        point(cursor_bounds.left(), cursor_bounds.bottom() - px(1.)),
                        size(cursor_bounds.size.width, px(1.)),
                    )),
                    _ => None,
                };
                if let Some(bounds) = overlay {
                    w.paint_quad(fill(bounds, rgb(colors::FG)));
                }
            }
            if !self.marked.is_empty() {
                let marked_run = GlyphRun {
                    line: cursor_row,
                    col: cursor.column.0,
                    width: self.marked.chars().count(),
                    cells: 1,
                    isolated: true,
                    ink: Ink {
                        fg: colors::FG,
                        flags: Flags::UNDERLINE,
                    },
                    text: self.marked.clone(),
                };
                let line = marked_run.shape(px(self.font_size), self.cell.width, w.text_system());
                w.paint_quad(fill(
                    Bounds::new(
                        cursor_origin,
                        size(line.width().max(self.cell.width), self.cell.height),
                    ),
                    rgb(colors::BG),
                ));
                let _ = line.paint(cursor_origin, self.cell.height, TextAlign::Left, None, w, cx);
            }
        }
        self.paint_scrollbar(w);
    }
}

#[cfg(test)]
mod tests {
    use super::{plan_draw_runs, terminal_font};
    use crate::{colors, terminal::tests::term_with};
    use alacritty_terminal::{
        index::{Column, Line, Point as CellPoint, Side},
        selection::{Selection, SelectionType},
        term::cell::Flags,
    };
    use gpui::{TextSystem, WindowTextSystem, px};
    use std::sync::Arc;

    #[test]
    fn non_ascii_fallback_and_combining_glyphs_stay_isolated_from_ascii_runs() {
        let term = term_with("🖼 Image: Cute Cat → /root/.gemini".as_bytes(), 60, 4);
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
        let summary: Vec<(usize, usize, bool, &str)> = glyphs
            .iter()
            .map(|r| (r.col, r.width, r.isolated, r.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (0, 1, true, "🖼"),
                (2, 15, false, "Image: Cute Cat"),
                (18, 1, true, "→"),
                (20, 13, false, "/root/.gemini"),
            ]
        );

        // Combining marks / VS16 must break both before and after the cluster.
        let term = term_with("ab⚠\u{fe0f}cd".as_bytes(), 20, 2);
        let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 2);
        let summary: Vec<(usize, usize, bool, &str)> = glyphs
            .iter()
            .map(|r| (r.col, r.width, r.isolated, r.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                (0, 2, false, "ab"),
                (2, 1, true, "⚠\u{fe0f}"),
                (3, 2, false, "cd"),
            ]
        );
    }

    #[test]
    fn selection_merges_into_single_background_and_does_not_shift_adjacent_text() {
        let mut term = term_with("🖼 Image: Cute Cat → /root".as_bytes(), 60, 4);
        let mut sel = Selection::new(
            SelectionType::Simple,
            CellPoint::new(Line(0), Column(3)),
            Side::Left,
        );
        sel.update(CellPoint::new(Line(0), Column(19)), Side::Right);
        term.selection = Some(sel);

        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
        assert_eq!(bgs.len(), 1);
        assert_eq!(bgs[0].col, 3);
        assert_eq!(bgs[0].width, 17);
        assert_eq!(bgs[0].color, 0x2b4c7e);

        // 'I' at col 2 stays anchored at col 2 instead of drifting under the selection at col 3.
        assert_eq!(glyphs[0].col, 0);
        assert_eq!(glyphs[0].text, "🖼");
        assert_eq!(glyphs[1].col, 2);
        assert_eq!(glyphs[1].text, "Image: Cute Cat");
    }

    #[test]
    fn focused_block_cursor_on_wide_char_covers_both_columns() {
        let mut term = term_with("中a".as_bytes(), 20, 2);
        // Alacritty normalizes a cursor on a wide-char spacer back to the wide cell.
        term.grid_mut().cursor.point = CellPoint::new(Line(0), Column(1));
        let (bgs, glyphs) = plan_draw_runs(term.renderable_content(), true, &[], None, 2);
        assert_eq!(bgs.len(), 1);
        assert_eq!(bgs[0].col, 0);
        assert_eq!(bgs[0].width, 2);
        assert_eq!(bgs[0].color, colors::FG);
        assert_eq!(glyphs[0].col, 0);
        assert_eq!(glyphs[0].width, 2);
        assert_eq!(glyphs[0].ink.fg, colors::BG);
        assert_eq!(glyphs[1].col, 2);
        assert_eq!(glyphs[1].text, "a");
    }

    #[test]
    fn shaped_ascii_positions_align_with_cell_grid_after_fallback_glyphs() {
        let platform = gpui_platform::current_platform(false);
        let ts = WindowTextSystem::new(Arc::new(TextSystem::new(platform.text_system())));
        let font_size = px(13.5);
        let id = ts.resolve_font(&terminal_font(Flags::empty()));
        let cw = ts.advance(id, font_size, 'M').unwrap().width;

        for sample in [
            "🖼 Image: Cute Cat → /root/.gemini",
            "➜ hello world",
            "❯\u{a0}hello world",
            "⚠ warning text",
            "⏺ agent output",
            "❘ narrow symbol text",
            "中文 hello",
        ] {
            let term = term_with(sample.as_bytes(), 80, 4);
            let (_, glyphs) = plan_draw_runs(term.renderable_content(), false, &[], None, 4);
            for run in &glyphs {
                if run.isolated {
                    continue;
                }
                let shaped = run.shape(font_size, cw, &ts);
                for (i, ch) in run.text.char_indices() {
                    if ch == ' ' {
                        continue;
                    }
                    let rendered_x =
                        f32::from(cw) * run.col as f32 + f32::from(shaped.x_for_index(i));
                    let expected_x = f32::from(cw) * (run.col + i) as f32;
                    assert!(
                        (rendered_x - expected_x).abs() < 0.05,
                        "sample={sample:?} run={:?} char={ch:?} at col {}: rendered={rendered_x:.3} expected={expected_x:.3}",
                        run.text,
                        run.col + i
                    );
                }
            }
        }
    }
}

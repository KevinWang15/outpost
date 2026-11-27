use super::Pane;
use alacritty_terminal::{
    grid::{Dimensions, Scroll},
    index::{Boundary, Column, Direction, Line, Point as CellPoint, Side},
    selection::{Selection, SelectionType},
    term::{
        Term,
        cell::Flags,
        search::{RegexIter, RegexSearch},
    },
};
use gpui::*;
use std::ops::RangeInclusive;

pub const MAX_SEARCH_MATCHES: usize = 10_000;
const SEARCH_CHUNK_LINES: i32 = 4_096;
pub(super) const SEARCH_MATCH_BG: u32 = 0x5c4616;
pub(super) const SEARCH_ACTIVE_BG: u32 = 0xe09f1f;
pub(super) const SEARCH_ACTIVE_FG: u32 = 0x0c0c0c;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SearchOptions {
    pub case_sensitive: bool,
    pub regex: bool,
    pub whole_word: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchStatus {
    pub total: usize,
    pub active: Option<usize>,
    pub truncated: bool,
    pub invalid_regex: bool,
}

#[derive(Default)]
pub(super) struct SearchState {
    pub(super) active: bool,
    pub(super) query: String,
    pub(super) options: SearchOptions,
    pub(super) matches: Vec<RangeInclusive<CellPoint>>,
    pub(super) current: Option<usize>,
    pub(super) truncated: bool,
    pub(super) invalid_regex: bool,
    pub(super) dirty: bool,
    pub(super) anchor: Option<CellPoint>,
}

fn escape_regex_literal(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for c in query.chars() {
        if "\\.+*?()|[]{}^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn build_search_pattern(query: &str, options: SearchOptions) -> Option<String> {
    if query.is_empty() {
        return None;
    }
    let core = if options.regex {
        query.to_owned()
    } else {
        escape_regex_literal(query)
    };
    Some(if options.case_sensitive {
        format!("(?-i:{core})")
    } else {
        format!("(?i:{core})")
    })
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn primary_cell_char<T>(term: &Term<T>, point: CellPoint) -> char {
    let cell = &term.grid()[point];
    if cell.flags.contains(Flags::WIDE_CHAR_SPACER) && point.column > Column(0) {
        term.grid()[CellPoint::new(point.line, point.column - 1)].c
    } else {
        cell.c
    }
}

fn matches_whole_word<T>(term: &Term<T>, m: &RangeInclusive<CellPoint>) -> bool {
    let start = *m.start();
    let end = *m.end();
    let last_col = term.last_column();
    let top_line = term.topmost_line();
    let bottom_line = Line(term.screen_lines() as i32 - 1);

    if is_word_char(primary_cell_char(term, start)) {
        let prev = if start.column > Column(0) {
            Some(CellPoint::new(start.line, start.column - 1))
        } else if start.line > top_line
            && term.grid()[start.line - 1i32][last_col]
                .flags
                .contains(Flags::WRAPLINE)
        {
            Some(CellPoint::new(start.line - 1i32, last_col))
        } else {
            None
        };
        if let Some(prev) = prev
            && is_word_char(primary_cell_char(term, prev))
        {
            return false;
        }
    }

    if is_word_char(primary_cell_char(term, end)) {
        let right_edge = term.expand_wide(end, Direction::Right);
        let next = if right_edge.column < last_col {
            Some(CellPoint::new(right_edge.line, right_edge.column + 1))
        } else if right_edge.line < bottom_line
            && term.grid()[right_edge.line][last_col]
                .flags
                .contains(Flags::WRAPLINE)
        {
            Some(CellPoint::new(right_edge.line + 1i32, Column(0)))
        } else {
            None
        };
        if let Some(mut next) = next {
            if term.grid()[next]
                .flags
                .contains(Flags::LEADING_WIDE_CHAR_SPACER)
                && next.line < bottom_line
            {
                next = CellPoint::new(next.line + 1i32, Column(0));
            }
            if is_word_char(primary_cell_char(term, next)) {
                return false;
            }
        }
    }

    true
}

fn collect_search_matches<T>(
    term: &Term<T>,
    regex: &mut RegexSearch,
    whole_word: bool,
) -> (Vec<RangeInclusive<CellPoint>>, bool) {
    let top_line = term.topmost_line();
    let bottom_line = Line(term.screen_lines() as i32 - 1);
    let last_col = term.last_column();
    if bottom_line < top_line {
        return (Vec::new(), false);
    }

    let mut chunk_end = CellPoint::new(bottom_line, last_col);
    let mut chunks: Vec<Vec<RangeInclusive<CellPoint>>> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;

    loop {
        let raw_top = Line((chunk_end.line.0 - SEARCH_CHUNK_LINES + 1).max(top_line.0));
        let chunk_start = term.line_search_left(CellPoint::new(raw_top, Column(0)));
        let mut chunk_matches = Vec::new();
        let mut last_end: Option<CellPoint> = None;

        for m in RegexIter::new(chunk_start, chunk_end, Direction::Right, term, regex) {
            if *m.start() > *m.end() || last_end.is_some_and(|prev| *m.start() <= prev) {
                break;
            }
            last_end = Some(*m.end());
            if !whole_word || matches_whole_word(term, &m) {
                chunk_matches.push(m);
            }
        }

        if total + chunk_matches.len() > MAX_SEARCH_MATCHES {
            let keep = MAX_SEARCH_MATCHES.saturating_sub(total);
            let drop_prefix = chunk_matches.len().saturating_sub(keep);
            chunk_matches.drain(..drop_prefix);
            total += chunk_matches.len();
            if !chunk_matches.is_empty() {
                chunks.push(chunk_matches);
            }
            truncated = true;
            break;
        }

        total += chunk_matches.len();
        if !chunk_matches.is_empty() {
            chunks.push(chunk_matches);
        }

        if chunk_start.line <= top_line {
            break;
        }
        chunk_end = chunk_start.sub(term, Boundary::Grid, 1);
        if chunk_end >= chunk_start {
            break;
        }
    }

    let mut all = Vec::with_capacity(total);
    for mut chunk in chunks.into_iter().rev() {
        all.append(&mut chunk);
    }
    (all, truncated)
}

fn pick_nearest_match_upward(matches: &[RangeInclusive<CellPoint>], anchor: CellPoint) -> usize {
    let idx = matches.partition_point(|m| *m.start() <= anchor);
    if idx > 0 { idx - 1 } else { 0 }
}

fn next_word_end<T>(term: &Term<T>, current_end: CellPoint) -> CellPoint {
    let mut pt = term.expand_wide(current_end, Direction::Right);
    let bottom = CellPoint::new(Line(term.screen_lines() as i32 - 1), term.last_column());
    while pt < bottom {
        let next = pt.add(term, Boundary::Grid, 1);
        if next.line != pt.line
            && !term.grid()[pt.line][term.last_column()]
                .flags
                .contains(Flags::WRAPLINE)
        {
            break;
        }
        let c = primary_cell_char(term, next);
        if c.is_whitespace() {
            pt = next;
        } else {
            pt = next;
            // Extend through the contiguous non-whitespace token.
            let right = term.semantic_search_right(pt);
            if right >= pt {
                pt = right;
            }
            break;
        }
    }
    pt
}

fn prev_word_start<T>(term: &Term<T>, current_start: CellPoint) -> CellPoint {
    let mut pt = current_start;
    let top = CellPoint::new(term.topmost_line(), Column(0));
    while pt > top {
        let prev = pt.sub(term, Boundary::Grid, 1);
        if prev.line != pt.line
            && !term.grid()[prev.line][term.last_column()]
                .flags
                .contains(Flags::WRAPLINE)
        {
            break;
        }
        let c = primary_cell_char(term, prev);
        if c.is_whitespace() {
            pt = prev;
        } else {
            pt = prev;
            let left = term.semantic_search_left(pt);
            if left <= pt {
                pt = left;
            }
            break;
        }
    }
    pt
}

pub(super) fn match_contains_cell(
    m: &RangeInclusive<CellPoint>,
    point: CellPoint,
    wide: bool,
) -> bool {
    let contains = |p: CellPoint| p >= *m.start() && p <= *m.end();
    contains(point) || (wide && contains(CellPoint::new(point.line, point.column + 1)))
}

impl Pane {
    pub fn search_status(&self) -> SearchStatus {
        SearchStatus {
            total: self.search.matches.len(),
            active: self.search.current,
            truncated: self.search.truncated,
            invalid_regex: self.search.invalid_regex,
        }
    }

    pub fn set_search(
        &mut self,
        query: &str,
        options: SearchOptions,
        reset_anchor: bool,
        cx: &mut Context<Self>,
    ) -> SearchStatus {
        self.search.active = true;
        self.search.query = query.to_owned();
        self.search.options = options;
        if reset_anchor || self.search.anchor.is_none() {
            self.search.anchor = Some(self.viewport_bottom_point());
        }
        if self.recompute_search(true) {
            self.note_scroll_activity(cx);
        }
        cx.notify();
        self.search_status()
    }

    pub fn clear_search(&mut self, cx: &mut Context<Self>) {
        if !self.search.active && self.search.matches.is_empty() && !self.search.invalid_regex {
            return;
        }
        self.search = SearchState::default();
        cx.notify();
    }

    pub fn refresh_search_if_dirty(&mut self) -> bool {
        if !self.search.active || !self.search.dirty {
            return false;
        }
        self.recompute_search(false);
        true
    }

    pub fn step_search(&mut self, next: bool, cx: &mut Context<Self>) -> bool {
        if !self.search.active {
            return false;
        }
        self.refresh_search_if_dirty();
        let len = self.search.matches.len();
        if len == 0 {
            return false;
        }
        let next_idx = match self.search.current {
            Some(i) if next => (i + 1) % len,
            Some(i) => {
                if i == 0 {
                    len - 1
                } else {
                    i - 1
                }
            }
            None if next => 0,
            None => len - 1,
        };
        self.search.current = Some(next_idx);
        let m = self.search.matches[next_idx].clone();
        self.search.anchor = Some(*m.start());
        if self.scroll_to_match(&m) {
            self.note_scroll_activity(cx);
        }
        cx.notify();
        true
    }

    /// iTerm2-style Tab / Shift+Tab: select the active match, or extend the selection
    /// by one word forward (`forward = true`) or backward (`forward = false`), copying it.
    pub fn extend_search_selection(
        &mut self,
        forward: bool,
        cx: &mut Context<Self>,
    ) -> Option<String> {
        self.refresh_search_if_dirty();
        let idx = self.search.current?;
        let m = self.search.matches.get(idx)?.clone();
        let existing = self
            .term
            .selection
            .as_ref()
            .and_then(|s| s.to_range(&self.term))
            .filter(|r| r.start <= *m.start() && r.end >= *m.end());
        let (mut start, mut end) = match existing {
            Some(r) => (r.start, r.end),
            None => (*m.start(), *m.end()),
        };
        if existing.is_some() {
            if forward {
                end = next_word_end(&self.term, end);
            } else {
                start = prev_word_start(&self.term, start);
            }
        }
        let mut sel = Selection::new(SelectionType::Simple, start, Side::Left);
        sel.update(end, Side::Right);
        self.term.selection = Some(sel);
        let text = self.term.selection_to_string().filter(|s| !s.is_empty())?;
        self.pending_copy = None;
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        cx.notify();
        Some(text)
    }

    #[cfg(feature = "ui-tests")]
    pub fn active_match_text(&mut self) -> Option<String> {
        self.refresh_search_if_dirty();
        let idx = self.search.current?;
        let m = self.search.matches.get(idx)?;
        let mut sel = Selection::new(SelectionType::Simple, *m.start(), Side::Left);
        sel.update(*m.end(), Side::Right);
        let saved = self.term.selection.take();
        self.term.selection = Some(sel);
        let text = self.term.selection_to_string();
        self.term.selection = saved;
        text
    }

    #[cfg(feature = "ui-tests")]
    pub fn find(&mut self, query: &str, next: bool, cx: &mut Context<Self>) {
        if query.is_empty() {
            self.clear_search(cx);
            return;
        }
        if !self.search.active || self.search.query != query {
            self.set_search(query, self.search.options, true, cx);
        } else {
            self.step_search(next, cx);
        }
    }

    fn viewport_bottom_point(&self) -> CellPoint {
        let bottom_line = Line(
            self.term.screen_lines() as i32 - 1 - self.term.grid().display_offset() as i32,
        );
        CellPoint::new(
            bottom_line.max(self.term.topmost_line()),
            self.term.last_column(),
        )
    }

    fn recompute_search(&mut self, scroll_to_result: bool) -> bool {
        self.search.dirty = false;
        let prev_active_start = self
            .search
            .current
            .and_then(|i| self.search.matches.get(i))
            .map(|m| *m.start());
        let Some(pattern) = build_search_pattern(&self.search.query, self.search.options) else {
            self.search.matches.clear();
            self.search.current = None;
            self.search.truncated = false;
            self.search.invalid_regex = false;
            return false;
        };
        let Ok(mut regex) = RegexSearch::new(&pattern) else {
            self.search.matches.clear();
            self.search.current = None;
            self.search.truncated = false;
            self.search.invalid_regex = true;
            return false;
        };
        self.search.invalid_regex = false;
        let (matches, truncated) =
            collect_search_matches(&self.term, &mut regex, self.search.options.whole_word);
        self.search.matches = matches;
        self.search.truncated = truncated;
        if self.search.matches.is_empty() {
            self.search.current = None;
            return false;
        }
        let target = if scroll_to_result {
            let anchor = self
                .search
                .anchor
                .unwrap_or_else(|| self.viewport_bottom_point());
            pick_nearest_match_upward(&self.search.matches, anchor)
        } else if let Some(prev) = prev_active_start {
            pick_nearest_match_upward(&self.search.matches, prev)
        } else {
            self.search.matches.len() - 1
        };
        self.search.current = Some(target);
        if scroll_to_result {
            let m = self.search.matches[target].clone();
            return self.scroll_to_match(&m);
        }
        false
    }

    fn scroll_to_match(&mut self, m: &RangeInclusive<CellPoint>) -> bool {
        let screen_lines = self.term.screen_lines() as i32;
        if screen_lines <= 0 {
            return false;
        }
        let history = self.term.history_size() as i32;
        let offset = self.term.grid().display_offset() as i32;
        let line = m.start().line.0;
        let row = line + offset;
        let top_pad = 2.min(screen_lines / 3);
        let bot_pad = 1.min(screen_lines / 4);
        if row < top_pad || row >= screen_lines - bot_pad {
            let center = (screen_lines / 2).max(top_pad);
            let target_offset = (center - line).clamp(0, history);
            let delta = target_offset - offset;
            if delta != 0 {
                self.term.scroll_display(Scroll::Delta(delta));
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_SEARCH_MATCHES, SEARCH_ACTIVE_BG, SEARCH_ACTIVE_FG, SEARCH_MATCH_BG, SearchOptions,
        build_search_pattern, collect_search_matches,
    };
    use crate::terminal::{Events, SizeHint, render::plan_draw_runs, tests::term_with};
    use alacritty_terminal::{
        grid::Dimensions,
        index::Line,
        term::{Config, Term, search::RegexSearch},
        vte::ansi::Processor,
    };

    #[test]
    fn search_collects_case_word_regex_wrapped_and_highlights_active_vs_other() {
        let term = term_with(
            b"Error error ERROR\r\nerr_code error-msg myerror\r\nwrapped_token_across_edge\r\n",
            20,
            6,
        );

        // Case-insensitive matches all case variations even when query contains uppercase.
        let pat = build_search_pattern("ERROR", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (all, truncated) = collect_search_matches(&term, &mut rx, false);
        assert!(!truncated);
        assert_eq!(all.len(), 5);

        // Explicit case-sensitive with lowercase query excludes "Error" and "ERROR".
        let pat = build_search_pattern(
            "error",
            SearchOptions {
                case_sensitive: true,
                ..Default::default()
            },
        )
        .unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (cs, _) = collect_search_matches(&term, &mut rx, false);
        assert_eq!(cs.len(), 3);

        // Whole word matches standalone "error" and "error-msg" (hyphen is non-word), excludes "myerror".
        let (ww, _) = collect_search_matches(&term, &mut rx, true);
        assert_eq!(ww.len(), 2);

        // Wrapped line match spans across row boundary.
        let pat = build_search_pattern("wrapped_token_across_edge", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (wrapped, _) = collect_search_matches(&term, &mut rx, true);
        assert_eq!(wrapped.len(), 1);
        assert_ne!(wrapped[0].start().line, wrapped[0].end().line);

        // Regex search with alternation and invalid regex rejection.
        let pat = build_search_pattern(
            "err_[a-z]+|ERROR",
            SearchOptions {
                case_sensitive: true,
                regex: true,
                whole_word: false,
            },
        )
        .unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (rx_matches, _) = collect_search_matches(&term, &mut rx, false);
        assert_eq!(rx_matches.len(), 2);
        let bad = build_search_pattern(
            "(unclosed",
            SearchOptions {
                regex: true,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(RegexSearch::new(&bad).is_err());

        // Highlighting distinguishes active match (gold + dark ink) from other matches (amber).
        let (bgs, glyphs) = plan_draw_runs(
            term.renderable_content(),
            false,
            &all,
            all.get(1),
            term.screen_lines(),
        );
        assert!(bgs.iter().any(|bg| bg.color == SEARCH_ACTIVE_BG));
        assert!(bgs.iter().any(|bg| bg.color == SEARCH_MATCH_BG));
        assert!(glyphs.iter().any(|g| g.ink.fg == SEARCH_ACTIVE_FG));

        // Capping on large scrollback preserves the MAX_SEARCH_MATCHES most recent matches.
        let mut big = Term::new(
            Config {
                scrolling_history: 15_000,
                ..Default::default()
            },
            &SizeHint { cols: 10, rows: 4 },
            Events::default(),
        );
        let mut parser: Processor = Default::default();
        parser.advance(&mut big, &b"x\r\n".repeat(12_000));
        let pat = build_search_pattern("x", SearchOptions::default()).unwrap();
        let mut rx = RegexSearch::new(&pat).unwrap();
        let (capped, truncated) = collect_search_matches(&big, &mut rx, false);
        assert!(truncated);
        assert_eq!(capped.len(), MAX_SEARCH_MATCHES);
        // The newest match on the visible screen must be retained.
        assert!(capped.last().unwrap().start().line >= Line(0));
    }
}

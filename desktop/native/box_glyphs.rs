//! Pixel-snapped geometric rendering for Unicode Block Elements (`U+2580..=U+259F`)
//! and Box Drawing characters (`U+2500..=U+257F`).
//!
//! Font glyphs for block and box characters rarely span the full cell box (especially
//! with line-height padding or fallback fonts like `Segoe UI Symbol` for quadrants
//! `▛▜▝▘` and rounded corners `╭╮╯╰`), leaving vertical/horizontal seams and height
//! mismatches. Drawing them directly as cell-aligned GPUI quads snapped to shared
//! device-pixel grid edges guarantees seamless joins at every font size and DPI.

use gpui::{
    BorderStyle, Bounds, ContentMask, Corners, Edges, Pixels, Point, Size, Window, fill, point, px,
    quad, rgb, rgba, transparent_black,
};

#[inline]
pub fn snap_px(value: Pixels, scale: f32) -> Pixels {
    let scale = scale.max(1.0);
    px((f32::from(value) * scale).round() / scale)
}

#[inline]
pub fn snapped_cell_bounds(
    grid_origin: Point<Pixels>,
    cell: Size<Pixels>,
    row: i32,
    col: usize,
    width: usize,
    scale: f32,
) -> Bounds<Pixels> {
    let x0 = snap_px(grid_origin.x + cell.width * col as f32, scale);
    let x1 = snap_px(grid_origin.x + cell.width * (col + width) as f32, scale);
    let y0 = snap_px(grid_origin.y + cell.height * row as f32, scale);
    let y1 = snap_px(grid_origin.y + cell.height * (row + 1) as f32, scale);
    Bounds::from_corners(point(x0, y0), point(x1, y1))
}

/// Returns `true` if `ch` is rendered geometrically by [`paint`].
#[cfg(test)]
fn is_supported(ch: char) -> bool {
    matches!(ch, '\u{2580}'..='\u{259F}')
        || (matches!(ch, '\u{2500}'..='\u{257F}') && !matches!(ch, '\u{2571}'..='\u{2573}'))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct RectPiece {
    bounds: Bounds<Pixels>,
    alpha: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArcCorner {
    TopLeft,     // ╭ down + right
    TopRight,    // ╮ down + left
    BottomRight, // ╯ up + left
    BottomLeft,  // ╰ up + right
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stroke {
    None,
    Light,
    Heavy,
    Double,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoxSpec {
    Arms {
        up: Stroke,
        right: Stroke,
        down: Stroke,
        left: Stroke,
    },
    Dashed {
        horizontal: bool,
        heavy: bool,
        dashes: u8,
    },
    Arc(ArcCorner),
}

fn box_spec(ch: char) -> Option<BoxSpec> {
    use Stroke::{Double as D, Heavy as H, Light as L, None as N};
    let arms = |up, right, down, left| {
        Some(BoxSpec::Arms {
            up,
            right,
            down,
            left,
        })
    };
    let dashed = |horizontal, heavy, dashes| {
        Some(BoxSpec::Dashed {
            horizontal,
            heavy,
            dashes,
        })
    };
    match ch {
        // Basic straight lines
        '\u{2500}' => arms(N, L, N, L),
        '\u{2501}' => arms(N, H, N, H),
        '\u{2502}' => arms(L, N, L, N),
        '\u{2503}' => arms(H, N, H, N),
        // Triple & quadruple dash lines
        '\u{2504}' => dashed(true, false, 3),
        '\u{2505}' => dashed(true, true, 3),
        '\u{2506}' => dashed(false, false, 3),
        '\u{2507}' => dashed(false, true, 3),
        '\u{2508}' => dashed(true, false, 4),
        '\u{2509}' => dashed(true, true, 4),
        '\u{250A}' => dashed(false, false, 4),
        '\u{250B}' => dashed(false, true, 4),
        // Down & Right corners
        '\u{250C}' => arms(N, L, L, N),
        '\u{250D}' => arms(N, H, L, N),
        '\u{250E}' => arms(N, L, H, N),
        '\u{250F}' => arms(N, H, H, N),
        // Down & Left corners
        '\u{2510}' => arms(N, N, L, L),
        '\u{2511}' => arms(N, N, L, H),
        '\u{2512}' => arms(N, N, H, L),
        '\u{2513}' => arms(N, N, H, H),
        // Up & Right corners
        '\u{2514}' => arms(L, L, N, N),
        '\u{2515}' => arms(L, H, N, N),
        '\u{2516}' => arms(H, L, N, N),
        '\u{2517}' => arms(H, H, N, N),
        // Up & Left corners
        '\u{2518}' => arms(L, N, N, L),
        '\u{2519}' => arms(L, N, N, H),
        '\u{251A}' => arms(H, N, N, L),
        '\u{251B}' => arms(H, N, N, H),
        // Vertical & Right tees
        '\u{251C}' => arms(L, L, L, N),
        '\u{251D}' => arms(L, H, L, N),
        '\u{251E}' => arms(H, L, L, N),
        '\u{251F}' => arms(L, L, H, N),
        '\u{2520}' => arms(H, L, H, N),
        '\u{2521}' => arms(H, H, L, N),
        '\u{2522}' => arms(L, H, H, N),
        '\u{2523}' => arms(H, H, H, N),
        // Vertical & Left tees
        '\u{2524}' => arms(L, N, L, L),
        '\u{2525}' => arms(L, N, L, H),
        '\u{2526}' => arms(H, N, L, L),
        '\u{2527}' => arms(L, N, H, L),
        '\u{2528}' => arms(H, N, H, L),
        '\u{2529}' => arms(H, N, L, H),
        '\u{252A}' => arms(L, N, H, H),
        '\u{252B}' => arms(H, N, H, H),
        // Down & Horizontal tees
        '\u{252C}' => arms(N, L, L, L),
        '\u{252D}' => arms(N, L, L, H),
        '\u{252E}' => arms(N, H, L, L),
        '\u{252F}' => arms(N, H, L, H),
        '\u{2530}' => arms(N, L, H, L),
        '\u{2531}' => arms(N, L, H, H),
        '\u{2532}' => arms(N, H, H, L),
        '\u{2533}' => arms(N, H, H, H),
        // Up & Horizontal tees
        '\u{2534}' => arms(L, L, N, L),
        '\u{2535}' => arms(L, L, N, H),
        '\u{2536}' => arms(L, H, N, L),
        '\u{2537}' => arms(L, H, N, H),
        '\u{2538}' => arms(H, L, N, L),
        '\u{2539}' => arms(H, L, N, H),
        '\u{253A}' => arms(H, H, N, L),
        '\u{253B}' => arms(H, H, N, H),
        // Crosses
        '\u{253C}' => arms(L, L, L, L),
        '\u{253D}' => arms(L, L, L, H),
        '\u{253E}' => arms(L, H, L, L),
        '\u{253F}' => arms(L, H, L, H),
        '\u{2540}' => arms(H, L, L, L),
        '\u{2541}' => arms(L, L, H, L),
        '\u{2542}' => arms(H, L, H, L),
        '\u{2543}' => arms(H, L, L, H),
        '\u{2544}' => arms(H, H, L, L),
        '\u{2545}' => arms(L, L, H, H),
        '\u{2546}' => arms(L, H, H, L),
        '\u{2547}' => arms(H, H, L, H),
        '\u{2548}' => arms(L, H, H, H),
        '\u{2549}' => arms(H, L, H, H),
        '\u{254A}' => arms(H, H, H, L),
        '\u{254B}' => arms(H, H, H, H),
        // Double dash lines
        '\u{254C}' => dashed(true, false, 2),
        '\u{254D}' => dashed(true, true, 2),
        '\u{254E}' => dashed(false, false, 2),
        '\u{254F}' => dashed(false, true, 2),
        // Double & mixed single/double lines
        '\u{2550}' => arms(N, D, N, D),
        '\u{2551}' => arms(D, N, D, N),
        '\u{2552}' => arms(N, D, L, N),
        '\u{2553}' => arms(N, L, D, N),
        '\u{2554}' => arms(N, D, D, N),
        '\u{2555}' => arms(N, N, L, D),
        '\u{2556}' => arms(N, N, D, L),
        '\u{2557}' => arms(N, N, D, D),
        '\u{2558}' => arms(L, D, N, N),
        '\u{2559}' => arms(D, L, N, N),
        '\u{255A}' => arms(D, D, N, N),
        '\u{255B}' => arms(L, N, N, D),
        '\u{255C}' => arms(D, N, N, L),
        '\u{255D}' => arms(D, N, N, D),
        '\u{255E}' => arms(L, D, L, N),
        '\u{255F}' => arms(D, L, D, N),
        '\u{2560}' => arms(D, D, D, N),
        '\u{2561}' => arms(L, N, L, D),
        '\u{2562}' => arms(D, N, D, L),
        '\u{2563}' => arms(D, N, D, D),
        '\u{2564}' => arms(N, D, L, D),
        '\u{2565}' => arms(N, L, D, L),
        '\u{2566}' => arms(N, D, D, D),
        '\u{2567}' => arms(L, D, N, D),
        '\u{2568}' => arms(D, L, N, L),
        '\u{2569}' => arms(D, D, N, D),
        '\u{256A}' => arms(L, D, L, D),
        '\u{256B}' => arms(D, L, D, L),
        '\u{256C}' => arms(D, D, D, D),
        // Rounded corners
        '\u{256D}' => Some(BoxSpec::Arc(ArcCorner::TopLeft)),
        '\u{256E}' => Some(BoxSpec::Arc(ArcCorner::TopRight)),
        '\u{256F}' => Some(BoxSpec::Arc(ArcCorner::BottomRight)),
        '\u{2570}' => Some(BoxSpec::Arc(ArcCorner::BottomLeft)),
        // Half-lines and mixed light/heavy straight lines
        '\u{2574}' => arms(N, N, N, L),
        '\u{2575}' => arms(L, N, N, N),
        '\u{2576}' => arms(N, L, N, N),
        '\u{2577}' => arms(N, N, L, N),
        '\u{2578}' => arms(N, N, N, H),
        '\u{2579}' => arms(H, N, N, N),
        '\u{257A}' => arms(N, H, N, N),
        '\u{257B}' => arms(N, N, H, N),
        '\u{257C}' => arms(N, H, N, L),
        '\u{257D}' => arms(L, N, H, N),
        '\u{257E}' => arms(N, L, N, H),
        '\u{257F}' => arms(H, N, L, N),
        _ => None,
    }
}

fn rect_from(x0: Pixels, y0: Pixels, x1: Pixels, y1: Pixels, alpha: u8) -> RectPiece {
    RectPiece {
        bounds: Bounds::from_corners(point(x0, y0), point(x1, y1)),
        alpha,
    }
}

fn block_element_pieces(ch: char, cell: Bounds<Pixels>, scale: f32) -> Vec<RectPiece> {
    let x0 = cell.left();
    let x1 = cell.right();
    let y0 = cell.top();
    let y1 = cell.bottom();
    let w = x1 - x0;
    let h = y1 - y0;
    let fx = |n: u32, d: u32| snap_px(x0 + w * (n as f32 / d as f32), scale);
    let fy = |n: u32, d: u32| snap_px(y0 + h * (n as f32 / d as f32), scale);

    let cp = ch as u32;
    match cp {
        0x2580 => vec![rect_from(x0, y0, x1, fy(1, 2), 0xff)], // ▀
        0x2581..=0x2587 => {
            let k = cp - 0x2580; // 1..=7 eighths from bottom
            vec![rect_from(x0, fy(8 - k, 8), x1, y1, 0xff)]
        }
        0x2588 => vec![rect_from(x0, y0, x1, y1, 0xff)], // █
        0x2589..=0x258F => {
            let k = 0x2590 - cp; // 7..=1 eighths from left
            vec![rect_from(x0, y0, fx(k, 8), y1, 0xff)]
        }
        0x2590 => vec![rect_from(fx(1, 2), y0, x1, y1, 0xff)], // ▐
        0x2591 => vec![rect_from(x0, y0, x1, y1, 0x40)],       // ░
        0x2592 => vec![rect_from(x0, y0, x1, y1, 0x80)],       // ▒
        0x2593 => vec![rect_from(x0, y0, x1, y1, 0xc0)],       // ▓
        0x2594 => vec![rect_from(x0, y0, x1, fy(1, 8), 0xff)], // ▔
        0x2595 => vec![rect_from(fx(7, 8), y0, x1, y1, 0xff)], // ▕
        0x2596..=0x259F => {
            const TL: u8 = 1;
            const TR: u8 = 2;
            const BL: u8 = 4;
            const BR: u8 = 8;
            let mask = match cp {
                0x2596 => BL,           // ▖
                0x2597 => BR,           // ▗
                0x2598 => TL,           // ▘
                0x2599 => TL | BL | BR, // ▙
                0x259A => TL | BR,      // ▚
                0x259B => TL | TR | BL, // ▛
                0x259C => TL | TR | BR, // ▜
                0x259D => TR,           // ▝
                0x259E => TR | BL,      // ▞
                0x259F => TR | BL | BR, // ▟
                _ => 0,
            };
            let xm = fx(1, 2);
            let ym = fy(1, 2);
            let mut out = Vec::with_capacity(2);
            match mask & (TL | TR) {
                m if m == (TL | TR) => out.push(rect_from(x0, y0, x1, ym, 0xff)),
                TL => out.push(rect_from(x0, y0, xm, ym, 0xff)),
                TR => out.push(rect_from(xm, y0, x1, ym, 0xff)),
                _ => {}
            }
            match mask & (BL | BR) {
                m if m == (BL | BR) => out.push(rect_from(x0, ym, x1, y1, 0xff)),
                BL => out.push(rect_from(x0, ym, xm, y1, 0xff)),
                BR => out.push(rect_from(xm, ym, x1, y1, 0xff)),
                _ => {}
            }
            out
        }
        _ => Vec::new(),
    }
}

struct StrokeMetrics {
    light: Pixels,
    cx0: Pixels,
    cx1: Pixels,
    cy0: Pixels,
    cy1: Pixels,
    hcx0: Pixels,
    hcx1: Pixels,
    hcy0: Pixels,
    hcy1: Pixels,
    vx_l0: Pixels,
    vx_l1: Pixels,
    vx_r0: Pixels,
    vx_r1: Pixels,
    hy_t0: Pixels,
    hy_t1: Pixels,
    hy_b0: Pixels,
    hy_b1: Pixels,
}

impl StrokeMetrics {
    fn for_cell(cell: Bounds<Pixels>, scale: f32) -> Self {
        let scale = scale.max(1.0);
        let light_dev = (1.0 * scale).round().max(1.0);
        let heavy_dev = (light_dev * 2.0).max(2.0);
        let light = px(light_dev / scale);
        let heavy = px(heavy_dev / scale);
        let mid_x = cell.left() + cell.size.width * 0.5;
        let mid_y = cell.top() + cell.size.height * 0.5;

        let cx0 = snap_px(mid_x - light * 0.5, scale);
        let cx1 = cx0 + light;
        let cy0 = snap_px(mid_y - light * 0.5, scale);
        let cy1 = cy0 + light;

        let hcx0 = snap_px(mid_x - heavy * 0.5, scale);
        let hcx1 = hcx0 + heavy;
        let hcy0 = snap_px(mid_y - heavy * 0.5, scale);
        let hcy1 = hcy0 + heavy;

        // Place double-line rails symmetrically around the center with at least `light` gap.
        let gap = light;
        let vx_l0 = cx0 - light;
        let vx_l1 = cx0;
        let vx_r0 = cx0 + gap;
        let vx_r1 = vx_r0 + light;

        let hy_t0 = cy0 - light;
        let hy_t1 = cy0;
        let hy_b0 = cy0 + gap;
        let hy_b1 = hy_b0 + light;

        Self {
            light,
            cx0,
            cx1,
            cy0,
            cy1,
            hcx0,
            hcx1,
            hcy0,
            hcy1,
            vx_l0,
            vx_l1,
            vx_r0,
            vx_r1,
            hy_t0,
            hy_t1,
            hy_b0,
            hy_b1,
        }
    }
}

fn box_arm_pieces(
    cell: Bounds<Pixels>,
    m: &StrokeMetrics,
    up: Stroke,
    right: Stroke,
    down: Stroke,
    left: Stroke,
) -> Vec<RectPiece> {
    use Stroke::{Double, Heavy, Light, None};
    let x0 = cell.left();
    let x1 = cell.right();
    let y0 = cell.top();
    let y1 = cell.bottom();

    let mut out = Vec::with_capacity(4);
    let mut push = |ax0, ay0, ax1, ay1| {
        if ax1 > ax0 && ay1 > ay0 {
            out.push(rect_from(ax0, ay0, ax1, ay1, 0xff));
        }
    };

    // Vertical span bounds for single/heavy arms so corners join cleanly without gaps.
    let v_join_top = match (left, right) {
        (Double, _) | (_, Double) => m.hy_t0,
        (Heavy, _) | (_, Heavy) => m.hcy0,
        _ => m.cy0,
    };
    let v_join_bottom = match (left, right) {
        (Double, _) | (_, Double) => m.hy_b1,
        (Heavy, _) | (_, Heavy) => m.hcy1,
        _ => m.cy1,
    };
    let h_join_left = match (up, down) {
        (Double, _) | (_, Double) => m.vx_l0,
        (Heavy, _) | (_, Heavy) => m.hcx0,
        _ => m.cx0,
    };
    let h_join_right = match (up, down) {
        (Double, _) | (_, Double) => m.vx_r1,
        (Heavy, _) | (_, Heavy) => m.hcx1,
        _ => m.cx1,
    };

    // Up arm
    let up_single_end = if down == None && left == Double && right == Double {
        m.hy_t1
    } else {
        v_join_bottom
    };
    match up {
        None => {}
        Light => push(m.cx0, y0, m.cx1, up_single_end),
        Heavy => push(m.hcx0, y0, m.hcx1, up_single_end),
        Double => {
            let left_end = match (left, right, down) {
                (Double, _, _) => m.hy_t1,
                (None, Double, None) => m.hy_b1,
                _ => m.cy1,
            };
            let right_end = match (left, right, down) {
                (_, Double, _) => m.hy_t1,
                (Double, None, None) => m.hy_b1,
                _ => m.cy1,
            };
            push(m.vx_l0, y0, m.vx_l1, left_end);
            push(m.vx_r0, y0, m.vx_r1, right_end);
        }
    }

    // Down arm
    let down_single_start = if up == None && left == Double && right == Double {
        m.hy_b0
    } else {
        v_join_top
    };
    match down {
        None => {}
        Light => push(m.cx0, down_single_start, m.cx1, y1),
        Heavy => push(m.hcx0, down_single_start, m.hcx1, y1),
        Double => {
            let left_start = match (left, right, up) {
                (Double, _, _) => m.hy_b0,
                (None, Double, None) => m.hy_t0,
                _ => m.cy0,
            };
            let right_start = match (left, right, up) {
                (_, Double, _) => m.hy_b0,
                (Double, None, None) => m.hy_t0,
                _ => m.cy0,
            };
            push(m.vx_l0, left_start, m.vx_l1, y1);
            push(m.vx_r0, right_start, m.vx_r1, y1);
        }
    }

    // Left arm
    let left_single_end = if right == None && up == Double && down == Double {
        m.vx_l1
    } else {
        h_join_right
    };
    match left {
        None => {}
        Light => push(x0, m.cy0, left_single_end, m.cy1),
        Heavy => push(x0, m.hcy0, left_single_end, m.hcy1),
        Double => {
            let top_end = match (up, down, right) {
                (Double, _, _) => m.vx_l1,
                (None, Double, None) => m.vx_r1,
                _ => m.cx1,
            };
            let bottom_end = match (up, down, right) {
                (_, Double, _) => m.vx_l1,
                (Double, None, None) => m.vx_r1,
                _ => m.cx1,
            };
            push(x0, m.hy_t0, top_end, m.hy_t1);
            push(x0, m.hy_b0, bottom_end, m.hy_b1);
        }
    }

    // Right arm
    let right_single_start = if left == None && up == Double && down == Double {
        m.vx_r0
    } else {
        h_join_left
    };
    match right {
        None => {}
        Light => push(right_single_start, m.cy0, x1, m.cy1),
        Heavy => push(right_single_start, m.hcy0, x1, m.hcy1),
        Double => {
            let top_start = match (up, down, left) {
                (Double, _, _) => m.vx_r0,
                (None, Double, None) => m.vx_l0,
                _ => m.cx0,
            };
            let bottom_start = match (up, down, left) {
                (_, Double, _) => m.vx_r0,
                (Double, None, None) => m.vx_l0,
                _ => m.cx0,
            };
            push(top_start, m.hy_t0, x1, m.hy_t1);
            push(bottom_start, m.hy_b0, x1, m.hy_b1);
        }
    }

    out
}

fn dashed_pieces(
    cell: Bounds<Pixels>,
    m: &StrokeMetrics,
    horizontal: bool,
    heavy: bool,
    dashes: u8,
    scale: f32,
) -> Vec<RectPiece> {
    let count = dashes.max(2) as usize;
    let mut out = Vec::with_capacity(count);
    let min_px = px(1.0 / scale.max(1.0));
    if horizontal {
        let (ay0, ay1) = if heavy {
            (m.hcy0, m.hcy1)
        } else {
            (m.cy0, m.cy1)
        };
        let step = cell.size.width / count as f32;
        let dash = (step * 0.65).max(min_px);
        for i in 0..count {
            let ax0 = snap_px(cell.left() + step * i as f32, scale);
            let ax1 = snap_px(cell.left() + step * i as f32 + dash, scale)
                .max(ax0 + min_px)
                .min(cell.right());
            if ax1 > ax0 {
                out.push(rect_from(ax0, ay0, ax1, ay1, 0xff));
            }
        }
    } else {
        let (ax0, ax1) = if heavy {
            (m.hcx0, m.hcx1)
        } else {
            (m.cx0, m.cx1)
        };
        let step = cell.size.height / count as f32;
        let dash = (step * 0.65).max(min_px);
        for i in 0..count {
            let ay0 = snap_px(cell.top() + step * i as f32, scale);
            let ay1 = snap_px(cell.top() + step * i as f32 + dash, scale)
                .max(ay0 + min_px)
                .min(cell.bottom());
            if ay1 > ay0 {
                out.push(rect_from(ax0, ay0, ax1, ay1, 0xff));
            }
        }
    }
    out
}

fn inset_mask_bounds(bounds: Bounds<Pixels>, scale: f32) -> Bounds<Pixels> {
    // GPUI snaps ContentMask with floor(near) / ceil(far); inset by 0.01 device px so
    // integer device-pixel edges never widen by +1dp due to float representation noise.
    let eps = px(0.01 / scale.max(1.0));
    if bounds.size.width <= eps * 2.0 || bounds.size.height <= eps * 2.0 {
        return bounds;
    }
    Bounds::from_corners(
        point(bounds.left() + eps, bounds.top() + eps),
        point(bounds.right() - eps, bounds.bottom() - eps),
    )
}

fn paint_arc(
    corner: ArcCorner,
    cell: Bounds<Pixels>,
    m: &StrokeMetrics,
    fg: u32,
    scale: f32,
    w: &mut Window,
) {
    // Draw a 2x-sized rounded-border quad clipped to the cell's active quadrant so the
    // quarter-circle arc joins adjacent `─` and `│` strokes at the exact device pixel.
    let (quad_origin, half_w, half_h, clip) = match corner {
        ArcCorner::TopLeft => {
            let hw = (cell.right() - m.cx0).max(m.light);
            let hh = (cell.bottom() - m.cy0).max(m.light);
            (
                point(m.cx0, m.cy0),
                hw,
                hh,
                Bounds::from_corners(point(m.cx0, m.cy0), point(cell.right(), cell.bottom())),
            )
        }
        ArcCorner::TopRight => {
            let hw = (m.cx1 - cell.left()).max(m.light);
            let hh = (cell.bottom() - m.cy0).max(m.light);
            (
                point(m.cx1 - hw * 2.0, m.cy0),
                hw,
                hh,
                Bounds::from_corners(point(cell.left(), m.cy0), point(m.cx1, cell.bottom())),
            )
        }
        ArcCorner::BottomRight => {
            let hw = (m.cx1 - cell.left()).max(m.light);
            let hh = (m.cy1 - cell.top()).max(m.light);
            (
                point(m.cx1 - hw * 2.0, m.cy1 - hh * 2.0),
                hw,
                hh,
                Bounds::from_corners(point(cell.left(), cell.top()), point(m.cx1, m.cy1)),
            )
        }
        ArcCorner::BottomLeft => {
            let hw = (cell.right() - m.cx0).max(m.light);
            let hh = (m.cy1 - cell.top()).max(m.light);
            (
                point(m.cx0, m.cy1 - hh * 2.0),
                hw,
                hh,
                Bounds::from_corners(point(m.cx0, cell.top()), point(cell.right(), m.cy1)),
            )
        }
    };
    let radius = half_w.min(half_h);
    let paint_quad = quad(
        Bounds::new(quad_origin, Size::new(half_w * 2.0, half_h * 2.0)),
        Corners::all(radius),
        transparent_black(),
        Edges::all(m.light),
        rgb(fg),
        BorderStyle::Solid,
    );
    w.with_content_mask(
        Some(ContentMask {
            bounds: inset_mask_bounds(clip, scale),
        }),
        |w| {
            w.paint_quad(paint_quad);
        },
    );
}

/// Paints a supported Block Element or Box Drawing character geometrically inside `cell`.
/// Returns `true` if painted, or `false` if the caller should fall back to font shaping.
pub fn paint(
    ch: char,
    grid_origin: Point<Pixels>,
    cell_size: Size<Pixels>,
    row: i32,
    col: usize,
    fg: u32,
    underline: bool,
    strikethrough: bool,
    w: &mut Window,
) -> bool {
    let scale = w.scale_factor();
    let cell = snapped_cell_bounds(grid_origin, cell_size, row, col, 1, scale);
    if matches!(ch, '\u{2580}'..='\u{259F}') {
        for piece in block_element_pieces(ch, cell, scale) {
            let color = if piece.alpha == 0xff {
                rgb(fg)
            } else {
                rgba((fg << 8) | u32::from(piece.alpha))
            };
            w.paint_quad(fill(piece.bounds, color));
        }
    } else if let Some(spec) = box_spec(ch) {
        let m = StrokeMetrics::for_cell(cell, scale);
        match spec {
            BoxSpec::Arms {
                up,
                right,
                down,
                left,
            } => {
                for piece in box_arm_pieces(cell, &m, up, right, down, left) {
                    w.paint_quad(fill(piece.bounds, rgb(fg)));
                }
            }
            BoxSpec::Dashed {
                horizontal,
                heavy,
                dashes,
            } => {
                for piece in dashed_pieces(cell, &m, horizontal, heavy, dashes, scale) {
                    w.paint_quad(fill(piece.bounds, rgb(fg)));
                }
            }
            BoxSpec::Arc(corner) => paint_arc(corner, cell, &m, fg, scale, w),
        }
    } else {
        return false;
    }

    let line_h = px((1.0 * scale.max(1.0)).round() / scale.max(1.0));
    if underline {
        let uy = snap_px(cell.bottom() - line_h * 2.0, scale).max(cell.top());
        w.paint_quad(fill(
            Bounds::from_corners(point(cell.left(), uy), point(cell.right(), uy + line_h)),
            rgb(fg),
        ));
    }
    if strikethrough {
        let sy = snap_px(cell.top() + cell.size.height * 0.5, scale);
        w.paint_quad(fill(
            Bounds::from_corners(point(cell.left(), sy), point(cell.right(), sy + line_h)),
            rgb(fg),
        ));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::size;

    #[test]
    fn adjacent_block_cells_share_exact_device_pixel_boundaries() {
        let origin = point(px(5.0), px(45.0));
        let cell = size(px(7.422_363_3), px(17.0));
        for scale in [1.0f32, 1.25, 1.5, 1.75, 2.0] {
            for col in 0..10 {
                let left = snapped_cell_bounds(origin, cell, 0, col, 1, scale);
                let right = snapped_cell_bounds(origin, cell, 0, col + 1, 1, scale);
                assert_eq!(left.right(), right.left(), "horizontal seam at scale {scale} col {col}");
            }
            for row in 0..5 {
                let top = snapped_cell_bounds(origin, cell, row, 0, 1, scale);
                let bottom = snapped_cell_bounds(origin, cell, row + 1, 0, 1, scale);
                assert_eq!(top.bottom(), bottom.top(), "vertical seam at scale {scale} row {row}");
            }
        }
    }

    #[test]
    fn claude_code_mascot_quadrants_and_blocks_cover_exact_edges() {
        let origin = point(px(5.0), px(45.0));
        let cell = size(px(7.422_363_3), px(17.0));
        let scale = 1.25;
        let c1 = snapped_cell_bounds(origin, cell, 0, 1, 1, scale);
        let c2 = snapped_cell_bounds(origin, cell, 0, 2, 1, scale);
        let c3 = snapped_cell_bounds(origin, cell, 0, 3, 1, scale);
        let c2_below = snapped_cell_bounds(origin, cell, 1, 2, 1, scale);

        let right_half = block_element_pieces('▐', c1, scale);
        let upper_left_three = block_element_pieces('▛', c2, scale);
        let full = block_element_pieces('█', c3, scale);
        let below_full = block_element_pieces('█', c2_below, scale);

        assert_eq!(right_half.len(), 1);
        assert_eq!(upper_left_three.len(), 2);
        assert_eq!(full.len(), 1);
        // ▐ in col 1 joins ▛ in col 2 with zero horizontal gap.
        assert_eq!(right_half[0].bounds.right(), upper_left_three[0].bounds.left());
        // ▛ top half in col 2 joins █ in col 3 with zero horizontal gap.
        assert_eq!(upper_left_three[0].bounds.right(), full[0].bounds.left());
        // ▛ bottom-left in row 0 joins █ in row 1 with zero vertical gap.
        assert_eq!(upper_left_three[1].bounds.bottom(), below_full[0].bounds.top());
    }

    #[test]
    fn supports_all_block_elements_and_non_diagonal_box_drawing() {
        for cp in 0x2580..=0x259F {
            let ch = char::from_u32(cp).unwrap();
            assert!(is_supported(ch), "block element U+{cp:04X} must be supported");
            let pieces = block_element_pieces(
                ch,
                Bounds::new(point(px(0.), px(0.)), size(px(8.), px(16.))),
                1.0,
            );
            assert!(!pieces.is_empty(), "block element U+{cp:04X} produced no rects");
        }
        for cp in 0x2500..=0x257F {
            let ch = char::from_u32(cp).unwrap();
            let diagonal = matches!(cp, 0x2571..=0x2573);
            assert_eq!(is_supported(ch), !diagonal, "box char U+{cp:04X}");
            if !diagonal {
                assert!(box_spec(ch).is_some(), "missing box_spec for U+{cp:04X}");
            }
        }
    }

    #[test]
    fn mixed_single_double_tees_keep_double_rail_gap_hollow() {
        let cell = Bounds::new(point(px(0.), px(0.)), size(px(9.), px(17.)));
        let m = StrokeMetrics::for_cell(cell, 1.0);
        // ╟: vertical double + right single must start the right arm at the right rail (vx_r0),
        // leaving the gap [vx_l1, vx_r0] open.
        let Some(BoxSpec::Arms {
            up,
            right,
            down,
            left,
        }) = box_spec('╟')
        else {
            panic!("missing ╟");
        };
        let pieces = box_arm_pieces(cell, &m, up, right, down, left);
        let right_arm = pieces
            .iter()
            .find(|p| p.bounds.right() == cell.right())
            .expect("right arm present");
        assert_eq!(right_arm.bounds.left(), m.vx_r0);

        // ╤: horizontal double + down single must start the down arm at the bottom rail (hy_b0).
        let Some(BoxSpec::Arms {
            up,
            right,
            down,
            left,
        }) = box_spec('╤')
        else {
            panic!("missing ╤");
        };
        let pieces = box_arm_pieces(cell, &m, up, right, down, left);
        let down_arm = pieces
            .iter()
            .find(|p| p.bounds.bottom() == cell.bottom())
            .expect("down arm present");
        assert_eq!(down_arm.bounds.top(), m.hy_b0);
    }

    #[test]
    fn inset_mask_bounds_covers_exact_device_pixel_edges() {
        let origin = point(px(5.0), px(45.0));
        let cell = size(px(7.422_363_3), px(17.0));
        for scale in [1.0f32, 1.25, 1.5, 1.75, 2.0] {
            for col in 0..12 {
                let bounds = snapped_cell_bounds(origin, cell, 3, col, 1, scale);
                let masked = inset_mask_bounds(bounds, scale);
                assert_eq!(
                    (f32::from(masked.left()) * scale).floor(),
                    (f32::from(bounds.left()) * scale).round(),
                    "left cover mismatch at scale {scale} col {col}"
                );
                assert_eq!(
                    (f32::from(masked.right()) * scale).ceil(),
                    (f32::from(bounds.right()) * scale).round(),
                    "right cover mismatch at scale {scale} col {col}"
                );
                assert_eq!(
                    (f32::from(masked.top()) * scale).floor(),
                    (f32::from(bounds.top()) * scale).round(),
                    "top cover mismatch at scale {scale} col {col}"
                );
                assert_eq!(
                    (f32::from(masked.bottom()) * scale).ceil(),
                    (f32::from(bounds.bottom()) * scale).round(),
                    "bottom cover mismatch at scale {scale} col {col}"
                );
            }
        }
    }
}

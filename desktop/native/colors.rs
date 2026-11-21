use alacritty_terminal::{term::color::Colors, vte::ansi::Color};
pub const BG: u32 = 0x0c0c0c;
pub const FG: u32 = 0xe6e6e6;
const ANSI: [u32; 16] = [
    0x262626, 0xf87171, 0x4ade80, 0xfacc15, 0x60a5fa, 0xc084fc, 0x22d3ee, 0xd4d4d4, 0x737373,
    0xfca5a5, 0x86efac, 0xfde68a, 0x93c5fd, 0xd8b4fe, 0x67e8f9, 0xfafafa,
];
pub fn indexed(index: usize) -> u32 {
    let levels = [0u32, 95, 135, 175, 215, 255];
    match index {
        0..16 => ANSI[index],
        16..232 => {
            let n = index - 16;
            levels[n / 36] << 16 | levels[n / 6 % 6] << 8 | levels[n % 6]
        }
        232..=255 => ((8 + 10 * (index - 232)) as u32) * 0x010101,
        257 => BG,
        259..=266 => dim(ANSI[index - 259]),
        268 => dim(FG),
        _ => FG,
    }
}
pub fn dim(v: u32) -> u32 {
    ((v >> 16) * 2 / 3) << 16 | (((v >> 8) & 255) * 2 / 3) << 8 | ((v & 255) * 2 / 3)
}
pub fn resolve(c: Color, overrides: &Colors) -> u32 {
    let index = match c {
        Color::Spec(rgb) => return u32::from_be_bytes([0, rgb.r, rgb.g, rgb.b]),
        Color::Indexed(n) => n as usize,
        Color::Named(n) => n as usize,
    };
    overrides[index]
        .map(|v| u32::from_be_bytes([0, v.r, v.g, v.b]))
        .unwrap_or_else(|| indexed(index))
}

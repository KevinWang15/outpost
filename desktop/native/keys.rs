use alacritty_terminal::term::TermMode;
use gpui::Keystroke;

/// Printable, unmodified text is committed by the platform input method.
pub fn encode(k: &Keystroke, mode: TermMode) -> Option<Vec<u8>> {
    let m = k.modifiers;
    if m.platform {
        return None;
    }
    let param = 1 + u8::from(m.shift) + 2 * u8::from(m.alt) + 4 * u8::from(m.control);
    let key = k.key.as_str();
    let data = match key {
        "enter" if m.shift || param > 1 && mode.contains(TermMode::DISAMBIGUATE_ESC_CODES) => {
            format!("\x1b[13;{param}u")
        }
        "enter" => "\r".into(),
        "escape" => "\x1b".into(),
        "backspace" if m.alt => "\x1b\x7f".into(),
        "backspace" => "\x7f".into(),
        "tab" if m.shift => "\x1b[Z".into(),
        "tab" => "\t".into(),
        "up" | "down" | "right" | "left" | "home" | "end" | "f1" | "f2" | "f3" | "f4" => {
            let code = match key {
                "up" => "A",
                "down" => "B",
                "right" => "C",
                "left" => "D",
                "home" => "H",
                "end" => "F",
                "f1" => "P",
                "f2" => "Q",
                "f3" => "R",
                _ => "S",
            };
            if param != 1 {
                format!("\x1b[1;{param}{code}")
            } else if key.starts_with('f') || mode.contains(TermMode::APP_CURSOR) {
                format!("\x1bO{code}")
            } else {
                format!("\x1b[{code}")
            }
        }
        "insert" | "delete" | "pageup" | "pagedown" | "f5" | "f6" | "f7" | "f8" | "f9" | "f10"
        | "f11" | "f12" => {
            let n = match key {
                "insert" => 2,
                "delete" => 3,
                "pageup" => 5,
                "pagedown" => 6,
                "f5" => 15,
                "f6" => 17,
                "f7" => 18,
                "f8" => 19,
                "f9" => 20,
                "f10" => 21,
                "f11" => 23,
                _ => 24,
            };
            if param == 1 {
                format!("\x1b[{n}~")
            } else {
                format!("\x1b[{n};{param}~")
            }
        }
        _ if m.control => {
            let c = match key {
                "space" | "@" | "2" => 0,
                "?" | "8" => 127,
                "3" => 27,
                "4" => 28,
                "5" => 29,
                "6" => 30,
                "7" => 31,
                _ if key.len() == 1
                    && (b'@'..=b'_').contains(&key.as_bytes()[0].to_ascii_uppercase()) =>
                {
                    key.as_bytes()[0].to_ascii_uppercase() & 31
                }
                _ => return None,
            };
            return Some(if m.alt { vec![27, c] } else { vec![c] });
        }
        _ if m.alt => format!("\x1b{}", k.key_char.as_deref().unwrap_or(key)),
        _ => return None,
    };
    Some(data.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(key: &'static str, mode: TermMode) -> Option<Vec<u8>> {
        encode(&Keystroke::parse(key).unwrap(), mode)
    }
    #[test]
    fn shell_controls_and_application_cursor_keys() {
        assert_eq!(input("ctrl-c", TermMode::empty()), Some(vec![3]));
        assert_eq!(input("up", TermMode::APP_CURSOR), Some(b"\x1bOA".to_vec()));
        assert_eq!(input("up", TermMode::empty()), Some(b"\x1b[A".to_vec()));
        assert_eq!(
            input("shift-enter", TermMode::empty()),
            Some(b"\x1b[13;2u".to_vec())
        );
        assert_eq!(input("a", TermMode::empty()), None);
    }
}

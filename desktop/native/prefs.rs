use crate::terminal::{DEFAULT_HISTORY, MAX_HISTORY};
use serde::Deserialize;
use serde_json::{Value, json};

pub const DEFAULT_FONT_SIZE: f32 = 13.5;
pub const MIN_FONT_SIZE: f32 = 10.0;
pub const MAX_FONT_SIZE: f32 = 28.0;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellProfile {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Preferences {
    pub font_size: f32,
    pub sound: bool,
    pub local_shell: Option<String>,
    pub scrollback_lines: usize,
    pub unlimited_scrollback: bool,
    pub profiles: Vec<ShellProfile>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            font_size: DEFAULT_FONT_SIZE,
            sound: true,
            local_shell: None,
            scrollback_lines: DEFAULT_HISTORY,
            unlimited_scrollback: false,
            profiles: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePreferences {
    #[serde(default)]
    font_size: Option<f32>,
    #[serde(default)]
    sound: Option<bool>,
    #[serde(default)]
    local_shell: Option<String>,
    #[serde(default)]
    scrollback_lines: Option<usize>,
    #[serde(default)]
    unlimited_scrollback: Option<bool>,
    #[serde(default)]
    profiles: Vec<ShellProfile>,
}

impl Preferences {
    pub fn from_event(value: &Value) -> Self {
        let Ok(wire) = serde_json::from_value::<WirePreferences>(value.clone()) else {
            return Self::default();
        };
        Self {
            font_size: wire
                .font_size
                .filter(|v| v.is_finite())
                .map_or(DEFAULT_FONT_SIZE, |v| v.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE)),
            sound: wire.sound.unwrap_or(true),
            local_shell: wire.local_shell.filter(|s| !s.is_empty()),
            scrollback_lines: wire
                .scrollback_lines
                .map_or(DEFAULT_HISTORY, |n| n.min(MAX_HISTORY)),
            unlimited_scrollback: wire.unlimited_scrollback.unwrap_or(false),
            profiles: wire.profiles,
        }
    }

    pub fn to_command(&self) -> Value {
        json!({
            "op": "prefs",
            "fontSize": self.font_size,
            "sound": self.sound,
            "localShell": self.local_shell,
            "scrollbackLines": self.scrollback_lines,
            "unlimitedScrollback": self.unlimited_scrollback,
        })
    }

    #[cfg(feature = "ui-tests")]
    pub fn to_event(&self) -> Value {
        let profiles: Vec<Value> = self
            .profiles
            .iter()
            .map(|p| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "executable": p.executable,
                    "args": p.args,
                })
            })
            .collect();
        json!({
            "event": "prefs",
            "fontSize": self.font_size,
            "sound": self.sound,
            "localShell": self.local_shell,
            "scrollbackLines": self.scrollback_lines,
            "unlimitedScrollback": self.unlimited_scrollback,
            "profiles": profiles,
        })
    }

    pub fn history(&self) -> usize {
        if self.unlimited_scrollback {
            MAX_HISTORY
        } else {
            self.scrollback_lines
        }
    }

    pub fn local_profile(&self, id: Option<&str>) -> Option<&ShellProfile> {
        let preferred = id.or(self.local_shell.as_deref());
        self.profiles
            .iter()
            .find(|profile| preferred == Some(profile.id.as_str()))
            .or_else(|| self.profiles.first())
    }

    pub fn is_custom(&self) -> bool {
        (self.font_size - DEFAULT_FONT_SIZE).abs() > 0.01
            || !self.sound
            || self.unlimited_scrollback
            || self.scrollback_lines != DEFAULT_HISTORY
    }

    pub fn reset_terminal_defaults(&mut self) {
        self.font_size = DEFAULT_FONT_SIZE;
        self.sound = true;
        self.scrollback_lines = DEFAULT_HISTORY;
        self.unlimited_scrollback = false;
    }
}

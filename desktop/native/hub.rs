use crate::{bridge::Bridge, workspace::Workspace};
use gpui::*;
use serde_json::{Value, json};

/// All windows share the same login store, connection registry and link handler.
pub struct Hub {
    pub bridge: Option<Bridge>,
    pub prefs: Value,
    pub accounts: Value,
    pub error: String,
}
impl Global for Hub {}
impl Hub {
    pub fn start(links: async_channel::Receiver<String>, cx: &mut App) {
        let mut error = String::new();
        let bridge = match Bridge::start() {
            Ok((bridge, events)) => {
                cx.spawn(async move |cx| {
                    while let Ok(event) = events.recv().await {
                        cx.update(|cx| Self::dispatch(event, cx));
                    }
                })
                .detach();
                Some(bridge)
            }
            Err(e) => {
                error = e.to_string();
                None
            }
        };
        let b = bridge.clone();
        cx.spawn(async move |cx| {
            while let Ok(url) = links.recv().await {
                if !url.is_empty()
                    && let Some(b) = &b
                {
                    b.call(json!({"op":"link","value":url}))
                }
                cx.update(|cx| {
                    cx.activate(true);
                    if let Some(w) = cx.active_window().or_else(|| cx.windows().first().copied()) {
                        let _ = w.update(cx, |_, w, _| w.activate_window());
                    }
                })
            }
        })
        .detach();
        cx.set_global(Self {
            bridge,
            prefs: Value::Null,
            accounts: Value::Null,
            error,
        });
    }
    fn dispatch(e: Value, cx: &mut App) {
        let kind = e["event"].as_str().unwrap_or("");
        let windows: Vec<_> = cx
            .windows()
            .into_iter()
            .filter_map(|h| h.downcast::<Workspace>())
            .collect();
        if kind == "prefs" || kind == "accounts" {
            let hub = cx.global_mut::<Self>();
            if kind == "prefs" {
                hub.prefs = e.clone()
            } else {
                hub.accounts = e.clone()
            }
            for w in windows {
                let _ = w.update(cx, |s, w, cx| s.event(e.clone(), w, cx));
            }
            return;
        }
        let remote = e["pane"].as_u64();
        let owner = remote.and_then(|n| {
            windows
                .iter()
                .find(|h| h.read(cx).is_ok_and(|s| s.remote.contains_key(&n)))
                .copied()
        });
        let request = e["window"].as_u64().and_then(|id| {
            windows
                .iter()
                .find(|h| h.read(cx).is_ok_and(|s| s.id == id))
                .copied()
        });
        let window = owner
            .or(request)
            .or_else(|| cx.active_window()?.downcast::<Workspace>())
            .or_else(|| windows.first().copied());
        if let Some(w) = window {
            let _ = w.update(cx, |s, w, cx| s.event(e, w, cx));
        }
    }
}

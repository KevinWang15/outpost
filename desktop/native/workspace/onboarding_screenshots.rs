use super::*;
use crate::prefs::{Preferences, ShellProfile};
use std::path::Path;

/// Capture deterministic, high-DPI GPUI screenshots of Outpost Desktop for the
/// onboarding guide. Runs cleanly inside a Linux GUI container (Xvfb + Mesa
/// lavapipe Vulkan) via `gpui_platform::current_headless_renderer`.
pub fn capture_onboarding_screenshots(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;

    let mut test = HeadlessAppContext::with_platform(
        gpui_platform::current_platform(true).text_system(),
        Arc::new(gpui::icons::LucideAssetSource::new()),
        gpui_platform::current_headless_renderer,
    );

    let shell_profile = ShellProfile {
        id: "zsh".into(),
        name: "Local shell (zsh)".into(),
        executable: "/bin/sh".into(),
        args: vec![],
    };

    test.update(|cx| {
        crate::init(cx);
        cx.set_global(crate::hub::Hub {
            bridge: None,
            prefs: Some(Preferences {
                sound: false,
                profiles: vec![shell_profile],
                ..Default::default()
            }),
            accounts: Value::Null,
            error: String::new(),
        });
    });

    let (bridge, _commands) = Bridge::recording();
    let window = test.open_window(size(px(1120.), px(720.)), |w, cx| {
        cx.new(|cx| {
            let mut ws = Workspace::new(false, w, cx);
            ws.bridge = Some(bridge);
            ws
        })
    })?;

    let draw = |test: &mut HeadlessAppContext| -> anyhow::Result<()> {
        test.run_until_parked();
        test.update_window(window.into(), |_, w, cx| {
            w.draw(cx).clear(cx);
        })?;
        Ok(())
    };

    let save = |test: &mut HeadlessAppContext, filename: &str| -> anyhow::Result<()> {
        draw(test)?;
        test.capture_screenshot(window.into())?
            .save(dir.join(filename))?;
        Ok(())
    };

    let server = "https://outpost.example.com";

    // 1. Connect a server (Home screen before sign-in, with server URL filled in)
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.accounts = json!({
                "accounts": [],
                "recent": [],
                "sessions": [],
                "signIns": []
            });
            s.show(Page::Home, w, cx);
            s.address
                .update(cx, |input, cx| input.set_value_silent(server, cx));
            cx.notify();
        });
    })?;
    save(&mut test, "desktop-connect-server.png")?;

    // 2. Connected server & recent sessions on Home screen
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.accounts = json!({
                "accounts": [{
                    "origin": server,
                    "account": { "id": "acct-dev", "name": "dev" },
                    "status": "Signed in as dev · expires in 30 days",
                    "canCreate": true
                }],
                "recent": [
                    {
                        "id": "sess-billing",
                        "title": "Billing API refactor · Workstation",
                        "server": server,
                        "tool": "claude"
                    },
                    {
                        "id": "sess-rate-limit",
                        "title": "API rate limiter · Workstation",
                        "server": server,
                        "tool": "codex"
                    },
                    {
                        "id": "sess-release",
                        "title": "Release checklist · GPU Box",
                        "server": server,
                        "tool": "kimi"
                    }
                ],
                "sessions": [
                    {
                        "id": "sess-billing",
                        "title": "Billing API refactor · Workstation",
                        "server": server,
                        "detail": "claude · ~/projects/billing-api · running",
                        "tool": "claude"
                    },
                    {
                        "id": "sess-rate-limit",
                        "title": "API rate limiter · Workstation",
                        "server": server,
                        "detail": "codex · ~/projects/api-gateway · running",
                        "tool": "codex"
                    },
                    {
                        "id": "sess-release",
                        "title": "Release checklist · GPU Box",
                        "server": server,
                        "detail": "kimi · ~/projects/docs · idle",
                        "tool": "kimi"
                    },
                    {
                        "id": "sess-refactor",
                        "title": "Frontend router cleanup · Workstation",
                        "server": server,
                        "detail": "antigravity · ~/projects/web-app · running",
                        "tool": "antigravity"
                    }
                ],
                "signIns": []
            });
            s.address
                .update(cx, |input, cx| input.set_value_silent("", cx));
            s.show(Page::Home, w, cx);
            cx.notify();
        });
    })?;
    save(&mut test, "desktop-connected.png")?;

    // 3. Create a new AI coding session directly inside Outpost Desktop
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.create_form(server.into(), "acct-dev".into(), w, cx);
            s.event(
                json!({
                    "event": "targets",
                    "origin": server,
                    "accountId": "acct-dev",
                    "targets": [
                        { "id": "m1", "name": "Workstation" },
                        { "id": "m2", "name": "GPU Box" }
                    ]
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "options",
                    "origin": server,
                    "accountId": "acct-dev",
                    "target": "m1",
                    "tools": ["claude", "codex", "kimi", "antigravity"],
                    "missing": []
                }),
                w,
                cx,
            );
            s.create.select_tool("claude", cx);
            s.create
                .name
                .update(cx, |name, cx| name.set_value_silent("Billing API refactor", cx));
            s.create
                .set_directory_silent("~/projects/billing-api", cx);
            cx.notify();
        });
    })?;
    save(&mut test, "desktop-create-session.png")?;

    // 4. Split-pane live terminal workspace with two AI coding sessions side by side
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.show(Page::Terminal, w, cx);
            // Open first remote session (Claude Code) in Tab 1
            s.event(
                json!({
                    "event": "opened",
                    "pane": 1,
                    "title": "Billing API refactor · Workstation",
                    "server": server,
                    "tool": "claude",
                    "sessionKey": "sess-billing"
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "connection",
                    "pane": 1,
                    "state": { "kind": "connected" }
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "activity",
                    "pane": 1,
                    "activity": { "state": "working", "detail": "Updating invoice webhook tests" }
                }),
                w,
                cx,
            );

            // Split side by side and open second remote session (Codex)
            let left_id = *s.remote.get(&1).expect("pane 1");
            s.split_at = Some((left_id, Axis::Across));
            s.event(
                json!({
                    "event": "opened",
                    "pane": 2,
                    "title": "API rate limiter · Workstation",
                    "server": server,
                    "tool": "codex",
                    "sessionKey": "sess-rate-limit"
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "connection",
                    "pane": 2,
                    "state": { "kind": "connected" }
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "activity",
                    "pane": 2,
                    "activity": { "state": "finished" }
                }),
                w,
                cx,
            );

            // Open a second tab so the tab bar demonstrates multi-tab workflow
            s.event(
                json!({
                    "event": "opened",
                    "pane": 3,
                    "title": "Release checklist · GPU Box",
                    "server": server,
                    "tool": "kimi",
                    "sessionKey": "sess-release"
                }),
                w,
                cx,
            );
            s.event(
                json!({
                    "event": "connection",
                    "pane": 3,
                    "state": { "kind": "connected" }
                }),
                w,
                cx,
            );

            // Focus back on Tab 1 (left pane)
            s.select(left_id, w, cx);
        });
    })?;
    draw(&mut test)?;

    // Feed crisp realistic ANSI terminal output into both split panes
    test.update_window(window.into(), |root, _w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            let left_id = *s.remote.get(&1).expect("pane 1");
            let right_id = *s.remote.get(&2).expect("pane 2");

            if let Some(p) = s.panes.get(&left_id) {
                p.update(cx, |p, cx| {
                    p.reset(64, 34);
                    p.grid_visible = true;
                    let output = concat!(
                        "\x1b[?25l\r\n",
                        "  \x1b[1;38;5;209mClaude Code\x1b[0m \x1b[90mv2.1 · ~/projects/billing-api\x1b[0m\r\n",
                        "  \x1b[90m──────────────────────────────────────────────────\x1b[0m\r\n\r\n",
                        "  \x1b[1;37m> Refactor webhook retries to use idempotency keys\x1b[0m\r\n\r\n",
                        "  \x1b[32m●\x1b[0m \x1b[1mRead\x1b[0m \x1b[36msrc/billing/webhooks.ts\x1b[0m \x1b[90m(142 lines)\x1b[0m\r\n",
                        "  \x1b[32m●\x1b[0m \x1b[1mEdit\x1b[0m \x1b[36msrc/billing/webhooks.ts\x1b[0m \x1b[32m+34\x1b[0m \x1b[31m-11\x1b[0m\r\n",
                        "    \x1b[90m48\x1b[0m \x1b[32m+ const key = event.idempotencyKey ?? event.id\x1b[0m\r\n",
                        "    \x1b[90m49\x1b[0m \x1b[32m+ if (await store.seen(key)) return skipped()\x1b[0m\r\n",
                        "    \x1b[90m50\x1b[0m \x1b[32m+ await store.record(key, event.receivedAt)\x1b[0m\r\n\r\n",
                        "  \x1b[34m●\x1b[0m \x1b[1mBash\x1b[0m \x1b[90mnpm test -- webhooks.test.ts\x1b[0m\r\n",
                        "    \x1b[32m✔\x1b[0m deduplicates retried invoice.paid events \x1b[90m(18ms)\x1b[0m\r\n",
                        "    \x1b[32m✔\x1b[0m preserves delivery order on burst retries \x1b[90m(24ms)\x1b[0m\r\n",
                        "    \x1b[36m⠋\x1b[0m Running integration suite…"
                    );
                    p.feed(output.as_bytes(), cx);
                });
            }

            if let Some(p) = s.panes.get(&right_id) {
                p.update(cx, |p, cx| {
                    p.reset(64, 34);
                    p.grid_visible = true;
                    let output = concat!(
                        "\r\n",
                        "  \x1b[1;38;5;75mOpenAI Codex\x1b[0m \x1b[90m· ~/projects/api-gateway\x1b[0m\r\n",
                        "  \x1b[90m──────────────────────────────────────────────────\x1b[0m\r\n\r\n",
                        "  \x1b[1;37m> Add sliding-window rate limits per API token\x1b[0m\r\n\r\n",
                        "  \x1b[32m✓\x1b[0m Updated \x1b[36msrc/middleware/rateLimit.ts\x1b[0m\r\n",
                        "  \x1b[32m✓\x1b[0m Added \x1b[36mtests/rateLimit.test.ts\x1b[0m \x1b[90m(6 passing)\x1b[0m\r\n\r\n",
                        "  All 6 rate-limit tests pass with Redis fallback.\r\n",
                        "  Ready for review — press \x1b[1mEnter\x1b[0m to continue.\r\n\r\n",
                        "  \x1b[38;5;75m❯\x1b[0m "
                    );
                    p.feed(output.as_bytes(), cx);
                });
            }
        });
    })?;
    save(&mut test, "desktop-split-workspace.png")?;

    // 5. Outpost sessions picker (showing open & remote sessions across machines)
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            s.show(Page::Choose, w, cx);
            cx.notify();
        });
    })?;
    save(&mut test, "desktop-session-picker.png")?;

    Ok(())
}

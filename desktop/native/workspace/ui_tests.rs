use super::*;
use crate::prefs::{DEFAULT_FONT_SIZE, Preferences, ShellProfile};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub fn exercise_workspace() -> anyhow::Result<()> {
    let mut test = HeadlessAppContext::with_platform(
        gpui_platform::current_platform(true).text_system(),
        Arc::new(gpui::icons::LucideAssetSource::new()),
        gpui_platform::current_headless_renderer,
    );
    let init_test = |cx: &mut App| {
        crate::init(cx);
        let profile = if cfg!(windows) {
            ShellProfile {
                id: "fixture".into(),
                name: "Fixture".into(),
                executable: "cmd.exe".into(),
                args: vec!["/D".into(), "/Q".into()],
            }
        } else {
            ShellProfile {
                id: "fixture".into(),
                name: "Fixture".into(),
                executable: "/bin/sh".into(),
                args: vec![
                    "-c".into(),
                    r#"printf 'INITIAL-SIZE=%s\n' "$(stty size)"; exec /bin/sh -i"#.into(),
                ],
            }
        };
        cx.set_global(crate::hub::Hub {
            bridge: None,
            prefs: Some(Preferences {
                sound: false,
                profiles: vec![profile],
                ..Default::default()
            }),
            accounts: Value::Null,
            error: String::new(),
        })
    };
    test.update(init_test);
    let window = test.open_window(size(px(1024.), px(680.)), |w, cx| {
        cx.new(|cx| Workspace::new(false, w, cx))
    })?;
    let draw = |test: &mut HeadlessAppContext| {
        test.run_until_parked();
        test.update_window(window.into(), |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
    };
    draw(&mut test);
    let click = |test: &mut HeadlessAppContext, x: f32, y: f32| -> anyhow::Result<()> {
        let position = point(px(x), px(y));
        test.update_window(window.into(), |_, w, cx| {
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    position,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        Ok(())
    };
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("home.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.show(Page::Settings, w, cx));
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("scrollback-settings.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                let origin = "https://outpost.ke.wang";
                s.accounts = json!({
                    "accounts": [{
                        "origin": origin,
                        "account": {"id": "acct-1"},
                        "canCreate": true
                    }]
                });
                s.create_form(origin.into(), "acct-1".into(), w, cx);
                s.event(
                    json!({
                        "event": "targets",
                        "origin": origin,
                        "accountId": "acct-1",
                        "targets": [
                            {"id": "m1", "name": "gpui-enhancement"},
                            {"id": "m2", "name": "linux-build-box"}
                        ]
                    }),
                    w,
                    cx,
                );
                s.event(
                    json!({
                        "event": "options",
                        "origin": origin,
                        "accountId": "acct-1",
                        "target": "m1",
                        "tools": ["claude", "codex"],
                        "missing": []
                    }),
                    w,
                    cx,
                );
            });
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("create-session.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.create.open_tool_menu(w, cx));
        })?;
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(&dir).join("create-session-open.png"))?;
        test.update_window(window.into(), |root, w, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .update(cx, |s, cx| s.show(Page::Home, w, cx));
        })?;
        // Only the agent changes. Identical frames would mean the marks failed to paint.
        let mut frames = Vec::new();
        for tool in ["claude", "codex", "kimi", "deepseek", "antigravity"] {
            test.update_window(window.into(), |root, _, cx| {
                root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                    s.accounts = json!({"recent":[{"id":"fixture","title":"Session","server":"example","tool":tool}]});
                    cx.notify();
                });
            })?;
            draw(&mut test);
            let frame = test.capture_screenshot(window.into())?;
            anyhow::ensure!(
                !frames.contains(&frame),
                "Recent sessions did not render a distinct {tool} icon"
            );
            frames.push(frame);
        }
    }
    // Drive remote panes through the same focus and window activation callbacks as the app.
    let (bridge, commands) = Bridge::recording();
    let remote_window = test.open_window(size(px(700.), px(500.)), |w, cx| {
        cx.new(|cx| {
            let mut s = Workspace::new(false, w, cx);
            s.bridge = Some(bridge);
            s
        })
    })?;
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let origin = "https://example.com";
            s.create_form(origin.into(), "first".into(), w, cx);
            assert_eq!(commands.try_recv().unwrap()["accountId"], "first");
            // Receiving targets auto-selects the first machine and probes its coding tools.
            s.event(
                json!({
                    "event":"targets",
                    "origin":origin,
                    "accountId":"first",
                    "targets":[{"id":"machine","name":"dev-box"},{"id":"other","name":"gpu-box"}]
                }),
                w,
                cx,
            );
            assert_eq!(s.create.target, "machine");
            let probe = commands.try_recv().unwrap();
            assert_eq!(probe["op"], "options");
            assert_eq!(probe["target"], "machine");
            s.create
                .name
                .update(cx, |name, cx| name.set_value_silent("Review", cx));
            s.create.set_directory_silent("/work", cx);
            // Remote directory suggestions round-trip through PathInputState.
            s.create.open_directory_suggestions(cx);
            let mut options = json!({"event":"options","origin":origin,"accountId":"first","target":"machine","tools":["codex","claude"],"missing":["bash"]});
            s.event(options.clone(), w, cx);
            s.submit(w, cx);
            assert!(!s.creation_ready());
            assert!(commands.try_recv().is_err());
            // Core software ready, but no coding tools installed yet.
            s.event(
                json!({"event":"options","origin":origin,"accountId":"first","target":"machine","tools":[],"missing":[]}),
                w,
                cx,
            );
            assert!(!s.creation_ready());
            options["missing"] = json!([]);
            s.event(options, w, cx);
            assert!(s.creation_ready());
            assert_eq!(s.create.tool, "codex");
            // Switching coding tool through the searchable ComboBox updates the selected tool.
            s.create.select_tool("claude", cx);
            // Custom program args, createDirectory, and env vars are validated and submitted.
            s.create.set_create_directory(true);
            s.create.set_args_silent("--verbose --model opus", cx);
            s.create.push_env("API_MODE", "fast", cx);
            s.create.push_env("API_MODE", "dup", cx);
            s.submit(w, cx);
            assert!(s.message.contains("Duplicate"));
            assert!(!s.create.creating);
        });
        w.draw(cx).clear(cx);
    })?;
    test.run_until_parked();
    // Drain the debounced directory lookup command if it fired and resolve it.
    std::thread::sleep(Duration::from_millis(260));
    test.run_until_parked();
    if let Ok(dir_cmd) = commands.try_recv() {
        assert_eq!(dir_cmd["op"], "directories");
        assert_eq!(dir_cmd["target"], "machine");
        assert_eq!(dir_cmd["path"], "/work");
        let req_id = dir_cmd["id"].as_u64().unwrap();
        test.update_window(remote_window.into(), |root, w, cx| {
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                s.event(
                    json!({
                        "event": "directories",
                        "id": req_id,
                        "origin": "https://example.com",
                        "accountId": "first",
                        "target": "machine",
                        "path": "/work",
                        "directories": ["/work/outpost/", "/work/gpui/"],
                        "truncated": false
                    }),
                    w,
                    cx,
                );
            });
        })?;
        test.run_until_parked();
        test.update_window(remote_window.into(), |root, _, cx| {
            let entries = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .create
                .directory_entries(cx);
            assert_eq!(entries, vec!["/work/outpost/", "/work/gpui/"]);
        })?;
    }
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let origin = "https://example.com";
            assert_eq!(s.create.tool, "claude");
            // Replace duplicate env with a valid unique variable and submit.
            s.create.cancel_directory_lookups(false, cx);
            s.create.clear_env();
            s.create.set_directory_silent("/work/outpost/", cx);
            s.create.set_create_directory(true);
            s.create.set_args_silent("--verbose --model opus", cx);
            s.create.push_env("API_MODE", "fast", cx);
            s.create.push_env("EXTRA_FLAG", "1", cx);
            s.submit(w, cx);
            let created = commands.try_recv().unwrap();
            assert_eq!(created["op"], "create");
            assert_eq!(created["accountId"], "first");
            assert_eq!(created["input"]["tool"], "claude");
            assert_eq!(created["input"]["rootDir"], "/work/outpost/");
            assert_eq!(created["input"]["createDirectory"], true);
            assert_eq!(created["input"]["args"], "--verbose --model opus");
            assert_eq!(created["input"]["env"]["API_MODE"], "fast");
            assert_eq!(created["input"]["env"]["EXTRA_FLAG"], "1");
            s.event(
                json!({"event":"accounts","accounts":[{"origin":origin,"account":{"id":"second"},"canCreate":true}]}),
                w,
                cx,
            );
            assert!(s.page == Page::Home);
        });
    })?;
    let focused = || {
        std::iter::from_fn(|| commands.try_recv().ok())
            .filter(|c| c["op"] == "focus")
            .map(|c| (c["pane"].as_u64().unwrap(), c["active"].as_bool().unwrap()))
            .collect::<Vec<_>>()
    };
    let open_remote = |test: &mut HeadlessAppContext, id| -> anyhow::Result<()> {
        test.update_window(remote_window.into(), |root, w, cx| {
            root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
                s.event(
                    json!({"event":"opened","pane":id,"title":"test","server":"https://example.com"}),
                    w,
                    cx,
                )
            });
            w.draw(cx).clear(cx);
        })?;
        test.run_until_parked();
        Ok(())
    };
    open_remote(&mut test, 1)?;
    test.update_window(remote_window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(1, true)]);
    open_remote(&mut test, 2)?;
    let mut switched = focused();
    switched.sort_unstable();
    assert_eq!(switched, vec![(1, false), (2, true)]);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            s.show(Page::Settings, w, cx);
            s.prefs.unlimited_scrollback = true;
            s.settings(cx);
            let pane = s.active().unwrap();
            pane.update(cx, |p, cx| {
                p.reset(40, 8);
                p.feed(b"FIRST-RETAINED-ROW\r\n", cx);
                p.feed(&b"row\r\n".repeat(25_000), cx);
                p.geometry(25, 6);
                p.find("FIRST-RETAINED-ROW", true, cx);
                assert_eq!(p.active_match_text().as_deref(), Some("FIRST-RETAINED-ROW"));
                p.feed(b"\x1b[?1049hALT", cx);
            });
            s.prefs.unlimited_scrollback = false;
            s.history_input
                .update(cx, |i, cx| i.set_value_silent("42", cx));
            s.save_history_limit(cx);
            assert_eq!(s.prefs.history(), 42);
            assert!(s.prefs.is_custom());
            pane.update(cx, |p, cx| {
                p.feed(b"\x1b[?1049l", cx);
                p.find("FIRST-RETAINED-ROW", true, cx);
                assert!(p.active_match_text().is_none());
                p.find("row", false, cx);
                assert_eq!(p.active_match_text().as_deref(), Some("row"));
                p.clear_search(cx);
                // Live OSC 7770 open-session request triggers an openSession command over the bridge.
                p.restoring = false;
                p.feed(
                    b"\x1b]7770;outpost;open-session;eyJ2IjoxLCJzZXNzaW9uSWQiOiJhZmIyZjA0YS0yY2ZhLTQ3OTMtYmMyZi02NDc2NWQyZmVhZTciLCJuYW1lIjoia2Utd2FuZyIsInRvb2wiOiJhbnRpZ3Jhdml0eSIsImhvc3RuYW1lIjoiVEstS0UtV0FORyJ9\x07",
                    cx,
                );
            });
            s.reset_terminal_settings(cx);
            assert!(!s.prefs.is_custom());
            assert_eq!(s.prefs.history(), crate::terminal::DEFAULT_HISTORY);
        })
    })?;
    test.run_until_parked();
    let open_cmd = std::iter::from_fn(|| commands.try_recv().ok())
        .find(|c| c["op"] == "openSession")
        .expect("OSC 7770 must emit openSession command");
    assert_eq!(open_cmd["sessionId"], "afb2f04a-2cfa-4793-bc2f-64765d2feae7");
    assert_eq!(open_cmd["name"], "ke-wang");
    assert_eq!(open_cmd["hostname"], "TK-KE-WANG");
    test.update_window(remote_window.into(), |root, w, cx| {
        w.draw(cx).clear(cx);
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.show(Page::Terminal, w, cx));
    })?;
    // A publication on a background tab must refresh that pane while Files is closed.
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"connected"}}),
                w,
                cx,
            );
            s.event(json!({"event":"filesChanged","pane":1}), w, cx);
            s.event(
                json!({"event":"files","pane":1,"files":[{"id":"fixture"}]}),
                w,
                cx,
            );
            assert_eq!(items(&s.panes[&s.remote[&1]].read(cx).files).len(), 1);
            assert!(s.active().unwrap().read(cx).files.is_null());

            // Verify animated tab activity badge states and status labels across lifecycle events.
            let p1 = s.remote[&1];
            let p2 = s.remote[&2];
            assert_eq!(
                panes::pane_activity_state(s.panes[&p1].read(cx)),
                Some(ActivityState::Pending)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p1].read(cx)),
                "Connecting…"
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Ready)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p2].read(cx)),
                "Connected"
            );
            for (activity, expected, label) in [
                (
                    json!({"state":"working"}),
                    ActivityState::Working,
                    "Connected · Working",
                ),
                (
                    json!({"state":"working","progress":42}),
                    ActivityState::Working,
                    "Connected · Working · 42%",
                ),
                (
                    json!({"state":"waiting","blockedKind":"permission","detail":"Allow cargo test?"}),
                    ActivityState::Attention,
                    "Connected · Needs approval · Allow cargo test?",
                ),
                (
                    json!({"state":"waiting","blockedKind":"question"}),
                    ActivityState::Attention,
                    "Connected · Waiting for answer",
                ),
                (
                    json!({"state":"waiting","blockedKind":"auth"}),
                    ActivityState::Attention,
                    "Connected · Needs sign-in",
                ),
                (
                    json!({"state":"waiting","detail":"Approval requested"}),
                    ActivityState::Attention,
                    "Connected · Waiting for you · Approval requested",
                ),
                (
                    json!({"state":"finished"}),
                    ActivityState::Attention,
                    "Connected · Needs you",
                ),
                (
                    json!({"state":"error"}),
                    ActivityState::Error,
                    "Connected · Error",
                ),
                (
                    json!({"state":"idle"}),
                    ActivityState::Idle,
                    "Connected · Idle",
                ),
                (
                    json!({"state":"unknown"}),
                    ActivityState::Unknown,
                    "Connected · Unknown",
                ),
            ] {
                s.event(
                    json!({"event":"activity","pane":2,"activity":activity}),
                    w,
                    cx,
                );
                assert_eq!(
                    panes::pane_activity_state(s.panes[&p2].read(cx)),
                    Some(expected)
                );
                assert_eq!(panes::pane_status_label(s.panes[&p2].read(cx)), label);
            }
            // Terminal bell elevates an idle pane to Attention until cleared.
            s.panes[&p2].update(cx, |p, _| p.bell = true);
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Attention)
            );
            assert!(panes::pane_status_label(s.panes[&p2].read(cx)).contains("Bell rang"));
            s.panes[&p2].update(cx, |p, _| p.bell = false);
            // Disconnecting clears stale activity metadata.
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"reconnecting","message":"Retrying"}}),
                w,
                cx,
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Pending)
            );
            assert_eq!(
                panes::pane_status_label(s.panes[&p2].read(cx)),
                "Reconnecting… · Retrying"
            );
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"closed"}}),
                w,
                cx,
            );
            assert_eq!(s.panes[&p2].read(cx).status, "Disconnected");
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"closed","message":"Session ended"}}),
                w,
                cx,
            );
            assert_eq!(
                panes::pane_activity_state(s.panes[&p2].read(cx)),
                Some(ActivityState::Disconnected)
            );
        });
        // Render the full-pane blurred error overlay before restoring the connection.
        w.draw(cx).clear(cx);
        ws.update(cx, |s, cx| {
            // Restore pane 2 to connected + working for the remaining workspace assertions.
            s.event(
                json!({"event":"connection","pane":2,"state":{"kind":"connected"}}),
                w,
                cx,
            );
            s.event(
                json!({"event":"activity","pane":2,"activity":{"state":"working"}}),
                w,
                cx,
            );
        });
        w.draw(cx).clear(cx);
    })?;
    let lists: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter(|c| c["op"] == "files")
        .map(|c| c["pane"].as_u64().unwrap())
        .collect();
    assert_eq!(lists, [2, 1, 2]);
    let screenshot = include_bytes!("../../../public/favicon-32x32.png");
    test.update_window(remote_window.into(), |root, w, cx| {
        let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
        cx.write_to_clipboard(ClipboardItem::new_image(&image));
        let pane = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .active()
            .unwrap();
        pane.update(cx, |p, cx| {
            let paste = if cfg!(target_os = "macos") {
                "cmd-v"
            } else {
                "ctrl-shift-v"
            };
            p.key_for_test(paste, w, cx);
            p.paste_image_path(cx);
        });
    })?;
    for mode in ["attachment", "path"] {
        let command = commands.try_recv()?;
        assert_eq!(command["op"], "image");
        assert_eq!(command["pane"], 2);
        assert_eq!(command["mime"], "image/png");
        assert_eq!(command["mode"], mode);
        assert_eq!(
            STANDARD.decode(command["data"].as_str().unwrap())?,
            screenshot
        );
    }
    assert!(commands.try_recv().is_err());

    // Exercise clipboard copy/paste shortcuts, bracketed paste normalization,
    // left-to-right & right-to-left copy-on-select, and right-click context menu in mouse mode.
    test.update_window(remote_window.into(), |root, w, cx| {
        let pane = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .active()
            .unwrap();
        pane.update(cx, |p, cx| {
            p.reset(40, 8);
            p.grid_visible = true;
            p.feed(b"\x1b[?2004hhello world\r\nsecond line", cx);
        });
        w.draw(cx).clear(cx);
    })?;
    test.run_until_parked();
    // Drain any resize commands triggered by drawing remote_window.
    while commands.try_recv().is_ok() {}
    #[cfg(not(target_os = "macos"))]
    {
        test.update_window(remote_window.into(), |root, w, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            // Ctrl+V with text pastes using bracketed paste and \r line endings.
            cx.write_to_clipboard(ClipboardItem::new_string("line1\r\nline2\x1b[201~".into()));
            pane.update(cx, |p, cx| {
                p.key_for_test("ctrl-v", w, cx);
                p.key_for_test("shift-insert", w, cx);
            });
            // Ctrl+V with image in remote terminal uploads an attachment.
            let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            pane.update(cx, |p, cx| p.key_for_test("ctrl-v", w, cx));
        })?;
        for _ in 0..2 {
            let cmd = commands.try_recv()?;
            assert_eq!(cmd["op"], "input");
            assert_eq!(
                STANDARD.decode(cmd["data"].as_str().unwrap())?,
                b"\x1b[200~line1\rline2[201~\x1b[201~"
            );
        }
        let img_cmd = commands.try_recv()?;
        assert_eq!(img_cmd["op"], "image");
        assert_eq!(img_cmd["mode"], "attachment");
        assert!(commands.try_recv().is_err());

        // Ctrl+C with selection copies and clears selection without sending \x03;
        // a second Ctrl+C (with no selection) sends \x03.
        test.update_window(remote_window.into(), |root, w, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            pane.update(cx, |p, cx| {
                p.find("hello", true, cx);
                assert_eq!(p.extend_search_selection(true, cx).as_deref(), Some("hello"));
                p.clear_search(cx);
                assert_eq!(p.selected_string().as_deref(), Some("hello"));
                p.key_for_test("ctrl-c", w, cx);
                assert!(!p.has_selection());
                p.key_for_test("ctrl-c", w, cx);
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("hello")
            );
        })?;
        let sigint = commands.try_recv()?;
        assert_eq!(sigint["op"], "input");
        assert_eq!(STANDARD.decode(sigint["data"].as_str().unwrap())?, b"\x03");
        assert!(commands.try_recv().is_err());
    }
    // Mouse drag selection (left-to-right and right-to-left) auto-copies exact cells on release,
    // and right-click opens the floating context menu even when MOUSE_MODE is enabled.
    let (row0_col0_left, row0_col4_right, row0_col6_left, row0_col10_right) =
        test.update_window(remote_window.into(), |root, _, cx| {
            let pane = root
                .downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap();
            let p = pane.read(cx);
            let origin = p.bounds_for_test().origin;
            let cell = p.cell_for_test();
            (
                origin + point(cell.width * 0.1, cell.height * 0.5),
                origin + point(cell.width * 4.9, cell.height * 0.5),
                origin + point(cell.width * 6.1, cell.height * 0.5),
                origin + point(cell.width * 10.9, cell.height * 0.5),
            )
        })?;
    test.update_window(remote_window.into(), |_, w, cx| {
        // Drag left-to-right across "hello" (cols 0..=4)
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col0_left,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: row0_col4_right,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: row0_col4_right,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("hello")
        );
        // Drag right-to-left across "world" (cols 10..=6) — must not drop start or end chars!
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col10_right,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: row0_col6_left,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: row0_col6_left,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("world")
        );
    })?;
    // Enable SGR mouse mode; right-click must open the GPUI PopupMenu, preserve selection,
    // and never send a mouse event to the remote application.
    let draw_remote = |test: &mut HeadlessAppContext| {
        test.run_until_parked();
        test.update_window(remote_window.into(), |_, w, cx| {
            w.draw(cx).clear(cx);
        })
        .unwrap();
        test.run_until_parked();
    };
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        pane.update(cx, |p, cx| p.feed(b"\x1b[?1000h\x1b[?1006h", cx));
        w.draw(cx).clear(cx);
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col6_left,
                button: MouseButton::Right,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(matches!(ws.read(cx).overlay, Some(OverlayMenu::Context(..))));
        assert!(ws.read(cx).page == Page::Terminal);
        assert_eq!(pane.read(cx).selected_string().as_deref(), Some("world"));
        w.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx);
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(ws.read(cx).overlay.is_none());
        assert!(pane.read(cx).focus.is_focused(w));
    })?;
    let leaked_input: Vec<_> = std::iter::from_fn(|| commands.try_recv().ok())
        .filter(|c| c["op"] == "input")
        .collect();
    assert!(
        leaked_input.is_empty(),
        "right-click in mouse mode must not send terminal input: {leaked_input:?}"
    );

    // Re-open the context menu, press Down + Enter to invoke Copy, and verify clipboard & focus.
    test.update_window(remote_window.into(), |_, w, cx| {
        cx.write_to_clipboard(ClipboardItem::new_string("stale".into()));
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: row0_col6_left,
                button: MouseButton::Right,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("down").unwrap(), cx);
        let enter = Keystroke::parse("enter").unwrap();
        w.dispatch_keystroke(enter.clone(), cx);
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: enter }), cx);
    })?;
    draw_remote(&mut test);
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let pane = ws.read(cx).active().unwrap();
        assert!(ws.read(cx).overlay.is_none());
        assert!(pane.read(cx).focus.is_focused(w));
        assert_eq!(
            cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
            Some("world")
        );
    })?;

    // OSC 52 from an inactive background pane must not clobber the clipboard; it queues
    // pending_copy for explicit Copy. OSC 52 from the active pane copies immediately.
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let bg = s.panes[&s.remote[&1]].clone();
            let fg = s.active().unwrap();
            cx.write_to_clipboard(ClipboardItem::new_string("keep-me".into()));
            bg.update(cx, |p, cx| {
                p.restoring = false;
                let osc52 = format!("\x1b]52;c;{}\x07", STANDARD.encode("from-bg"));
                p.feed(osc52.as_bytes(), cx);
                assert!(p.can_copy());
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("keep-me")
            );
            bg.update(cx, |p, cx| {
                assert!(p.copy(cx));
                assert!(!p.can_copy());
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("from-bg")
            );
            fg.update(cx, |p, cx| {
                let osc52 = format!("\x1b]52;c;{}\x07", STANDARD.encode("from-fg"));
                p.feed(osc52.as_bytes(), cx);
            });
            assert_eq!(
                cx.read_from_clipboard().and_then(|i| i.text()).as_deref(),
                Some("from-fg")
            );

            // Sticky upload toast stays until notice or error arrives for that pane.
            let image = gpui::Image::from_bytes(gpui::ImageFormat::Png, screenshot.to_vec());
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            fg.update(cx, |p, cx| p.paste_clipboard(cx));
            s.event(
                json!({"event":"notice","pane":2,"message":"Image attached"}),
                w,
                cx,
            );
            let toast = s.toast.as_ref().expect("notice toast");
            assert_eq!(toast.message, "Image attached");
            assert!(!toast.sticky);

            fg.update(cx, |p, cx| p.paste_clipboard(cx));
            s.show_toast(Some(s.remote[&2]), "Uploading image…".into(), true, cx);
            s.event(
                json!({"event":"error","pane":2,"message":"Upload failed"}),
                w,
                cx,
            );
            assert!(s.toast.is_none(), "error must clear sticky upload toast");
            s.message.clear();
        });
    })?;

    // Status overlay card must wrap long messages strictly inside its 20px padding without
    // overflowing horizontally, while still shrink-wrapping snugly around short messages.
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        let fg = ws.read(cx).active().unwrap();
        let prev_conn = fg.read(cx).connection;
        fg.update(cx, |p, _| {
            p.connection = ConnectionState::Closed;
            p.status =
                "The coding tool exited. Connect again to start it in the same conversation."
                    .into();
        });
        ws.read(cx).status_overlay_bounds.lock().unwrap().clear();
        w.draw(cx).clear(cx);
        let bounds = ws.read(cx).status_overlay_bounds.lock().unwrap().clone();
        let card = bounds["card"];
        let msg_row = bounds["row"];
        let text_box = bounds["text"];
        assert!(
            card.size.width <= px(420.5),
            "long status card must respect 420px max width: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );
        assert!(
            msg_row.left() >= card.left() + px(19.) && msg_row.right() <= card.right() - px(19.),
            "status row must stay inside card padding: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );
        assert!(
            text_box.left() >= card.left() + px(19.) && text_box.right() <= card.right() - px(19.),
            "status text must stay inside card padding: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );
        assert!(
            text_box.size.height > px(24.),
            "long status text must wrap onto multiple lines: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );

        fg.update(cx, |p, _| {
            p.connection = ConnectionState::Reconnecting;
            p.status = "Reconnecting...".into();
        });
        ws.read(cx).status_overlay_bounds.lock().unwrap().clear();
        w.draw(cx).clear(cx);
        let bounds = ws.read(cx).status_overlay_bounds.lock().unwrap().clone();
        let card = bounds["card"];
        let msg_row = bounds["row"];
        let text_box = bounds["text"];
        assert!(
            card.size.width < px(260.),
            "short status card must shrink-wrap snugly: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );
        assert!(
            msg_row.left() >= card.left() + px(19.) && msg_row.right() <= card.right() - px(19.),
            "short status row must stay inside card padding: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );
        assert!(
            text_box.right() <= card.right() - px(19.),
            "short status text must stay inside card padding: card={card:?}, row={msg_row:?}, text={text_box:?}"
        );

        fg.update(cx, |p, _| {
            p.connection = prev_conn;
            p.status.clear();
        });
    })?;

    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            let fg = s.active().unwrap();

            // Session picker (Choose & Switch) deduplicates open remote sessions, cleans up
            // repeated "name · name" titles, supports Up/Down + Enter + Escape, and creates via
            // a single New session action.
            assert_eq!(
                picker::split_session_title("gpui-enhancement · gpui-enhancement"),
                ("gpui-enhancement", None)
            );
            assert_eq!(
                picker::split_session_title("test · Main 114"),
                ("test", Some("Main 114"))
            );
            assert_eq!(
                picker::display_server("https://outpost.zoco.cc/"),
                "outpost.zoco.cc"
            );
            fg.update(cx, |p, _| {
                p.title = "test".into();
                p.server = Some("https://outpost.zoco.cc".into());
                p.session_key = Some("sess-open".into());
            });
            s.accounts = json!({
                "accounts": [
                    {"origin": "https://outpost.zoco.cc", "account": {"id": "a1"}, "canCreate": true},
                    {"origin": "http://localhost:6620", "account": {"id": "a2"}, "canCreate": true}
                ],
                "sessions": [
                    {"id": "sess-open", "title": "test · Main 114", "server": "https://outpost.zoco.cc", "detail": "claude · /work · running", "tool": "claude"},
                    {"id": "sess-other", "title": "gpui-enhancement · gpui-enhancement", "server": "http://localhost:6620", "detail": "antigravity · /repo · running", "tool": "antigravity"}
                ]
            });
            s.show(Page::Choose, w, cx);
            // Open remote pane 2 ("sess-open") is deduplicated into the single catalogue row;
            // open pane 1 ("test" on example.com, not in catalogue) stays reachable as fallback.
            let choose_items = s.picker_items(cx);
            assert_eq!(choose_items.len(), 3);
            assert!(matches!(
                &choose_items[0],
                picker::PickerItem::RemoteSession { id, open_pane, name, machine, .. }
                    if id == "sess-open" && open_pane.is_some() && name == "test" && machine.as_deref() == Some("Main 114")
            ));
            assert!(matches!(
                &choose_items[1],
                picker::PickerItem::RemoteSession { id, open_pane, name, machine, .. }
                    if id == "sess-other" && open_pane.is_none() && name == "gpui-enhancement" && machine.is_none()
            ));
            s.step_picker(1, cx);
            assert_eq!(s.picker.index, 1);
            s.step_picker(-1, cx);
            assert_eq!(s.picker.index, 0);
        });
    })?;
    draw_remote(&mut test);
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(remote_window.into())?
            .save(PathBuf::from(&dir).join("choose-session.png"))?;
    }
    // Pressing real Enter while the picker search Input is focused must submit via InputEvent::Submit
    // and activate the highlighted session (returning to Page::Terminal).
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        assert!(ws.read(cx).page == Page::Choose);
        assert!(
            ws.read(cx)
                .picker
                .query
                .read(cx)
                .focus_handle(cx)
                .is_focused(w)
        );
        w.dispatch_keystroke(Keystroke::parse("enter").unwrap(), cx);
    })?;
    test.run_until_parked();
    test.update_window(remote_window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        ws.update(cx, |s, cx| {
            assert!(
                s.page == Page::Terminal,
                "pressing Enter in the session picker search input must connect/select the highlighted row"
            );

            // Verify iTerm2-style floating Find overlay: live search, modes, navigation, Tab selection, and Esc dismiss.
            let find_pane = s.active().unwrap();
            find_pane.update(cx, |p, cx| {
                p.reset(60, 12);
                p.feed(
                    b"alpha beta Alpha\r\nalphabet https://example.com/path done\r\n",
                    cx,
                );
                p.grid_visible = true;
            });
            s.open_find(w, cx);
            assert!(s.page == Page::Terminal);
            assert!(s.find.open);
            assert!(s.find.query.read(cx).focus_handle(cx).is_focused(w));

            // Incremental live search defaults to case-insensitive and anchors on the most recent match.
            s.find
                .query
                .update(cx, |input, cx| input.set_value("alpha", cx));
            s.sync_find(false, cx);
            let status = find_pane.read(cx).search_status();
            assert_eq!(status.total, 3);
            assert_eq!(status.active, Some(2));
            assert_eq!(
                find_pane
                    .update(cx, |p, _| p.active_match_text())
                    .as_deref(),
                Some("alpha")
            );

            // Stepping next wraps 3 -> 1, stepping previous returns to 3.
            s.step_find(true, cx);
            assert_eq!(find_pane.read(cx).search_status().active, Some(0));
            s.step_find(false, cx);
            assert_eq!(find_pane.read(cx).search_status().active, Some(2));

            // Toggle Match case: excludes "Alpha" (matches only lowercase "alpha" in "alpha" and "alphabet").
            s.toggle_find_case(w, cx);
            assert!(s.find.options.case_sensitive);
            assert_eq!(find_pane.read(cx).search_status().total, 2);

            // Toggle Whole word: excludes "alphabet" (matches only standalone lowercase "alpha").
            s.toggle_find_whole_word(w, cx);
            assert!(s.find.options.whole_word);
            assert_eq!(find_pane.read(cx).search_status().total, 1);

            // Reset case & whole word, enable regex and verify both invalid and valid patterns.
            s.toggle_find_case(w, cx);
            s.toggle_find_whole_word(w, cx);
            s.toggle_find_regex(w, cx);
            assert!(s.find.options.regex);
            s.find
                .query
                .update(cx, |input, cx| input.set_value("[unterminated", cx));
            s.sync_find(false, cx);
            assert!(find_pane.read(cx).search_status().invalid_regex);
            assert_eq!(find_pane.read(cx).search_status().total, 0);

            s.find
                .query
                .update(cx, |input, cx| input.set_value("https://[^ ]+", cx));
            s.sync_find(false, cx);
            assert!(!find_pane.read(cx).search_status().invalid_regex);
            assert_eq!(find_pane.read(cx).search_status().total, 1);

            // Tab while searching selects & copies the active match, and a second Tab extends to the next word.
            s.extend_find_selection(true, cx);
            assert_eq!(
                find_pane.read(cx).selected_string().as_deref(),
                Some("https://example.com/path")
            );
            s.extend_find_selection(true, cx);
            assert_eq!(
                find_pane.read(cx).selected_string().as_deref(),
                Some("https://example.com/path done")
            );

            // Live PTY output marks search dirty and refreshes match count cleanly.
            s.toggle_find_regex(w, cx);
            s.find
                .query
                .update(cx, |input, cx| input.set_value("beta", cx));
            s.sync_find(false, cx);
            assert_eq!(find_pane.read(cx).search_status().total, 1);
            find_pane.update(cx, |p, cx| {
                p.feed(b"another beta line\r\n", cx);
                assert!(p.refresh_search_if_dirty());
            });
            assert_eq!(find_pane.read(cx).search_status().total, 2);

            // Closing Find clears highlights, restores terminal focus, and remembers the last query.
            s.close_find(w, cx);
            assert!(!s.find.open);
            assert_eq!(find_pane.read(cx).search_status().total, 0);
            assert!(find_pane.read(cx).focus.is_focused(w));
            assert_eq!(s.find.query.read(cx).value(), "beta");
            assert!(s.page == Page::Terminal);

            // Verify Write-a-message shortcut reaches Page::Compose on all platforms.
            let compose_key = if cfg!(target_os = "macos") {
                "cmd-enter"
            } else {
                "ctrl-shift-enter"
            };
            s.shortcuts(
                &KeyDownEvent {
                    keystroke: Keystroke::parse(compose_key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            assert!(s.page == Page::Compose);
            s.dismiss_page(w, cx);
            assert!(s.page == Page::Terminal);

            // Verify Reload shortcut cleanly resets transient pane state and reconnects.
            let reload_pane = s.active().unwrap();
            reload_pane.update(cx, |p, _| {
                p.connection = ConnectionState::Closed;
                p.status = "This connection expired.".into();
                p.sending = true;
                p.waiting = 3;
                p.activity = "working".into();
                p.files = json!([{"id": "stale"}]);
            });
            let reload_key = if cfg!(target_os = "macos") {
                "cmd-r"
            } else {
                "ctrl-shift-r"
            };
            s.shortcuts(
                &KeyDownEvent {
                    keystroke: Keystroke::parse(reload_key).unwrap(),
                    is_held: false,
                    prefer_character_input: false,
                },
                w,
                cx,
            );
            {
                let p = reload_pane.read(cx);
                assert_eq!(p.connection, ConnectionState::Connecting);
                assert!(p.restoring);
                assert_eq!(p.status, "Connecting…");
                assert!(!p.sending);
                assert_eq!(p.waiting, 0);
                assert!(p.activity.is_empty());
                assert!(p.files.is_null());
            }
            reload_pane.update(cx, |p, _| {
                p.connection = ConnectionState::Connected;
                p.restoring = false;
                p.status.clear();
            });

            s.show(Page::Switch, w, cx);
            // Switch lists 2 open panes (most recently used first) + only the 1 non-open catalogue session (sess-other).
            let (p1, p2) = (s.remote[&1], s.remote[&2]);
            let switch_items = s.picker_items(cx);
            assert_eq!(switch_items.len(), 3);
            assert!(matches!(switch_items[0], picker::PickerItem::OpenPane(id) if id == p2));
            assert!(matches!(switch_items[1], picker::PickerItem::OpenPane(id) if id == p1));
            s.open_create_session(w, cx);
            assert!(s.page == Page::Create);
            assert_eq!(s.create.origin, "https://outpost.zoco.cc");
            s.show(Page::Terminal, w, cx);
        });
        // Verify iTerm2-style overlay scrollbar: hover reveal, track jump, off-lane thumb drag,
        // Alt+click page scroll, keyboard scrollback shortcuts, and auto-hide in alt-screen.
        let scroll_pane = ws.read(cx).active().unwrap();
        scroll_pane.update(cx, |p, cx| {
            p.reset(60, 12);
            for i in 0..200 {
                p.feed(format!("scrollback line {i}\r\n").as_bytes(), cx);
            }
            p.grid_visible = true;
        });
        w.draw(cx).clear(cx);
        let hist = scroll_pane.read(cx).history_size_for_test();
        assert!(hist >= 180);
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), 0);
        let pb = scroll_pane.read(cx).bounds_for_test();
        let bar_x = pb.right() - px(4.);
        let mid_y = pb.top() + pb.size.height * 0.5;
        let top_y = pb.top() + px(8.);
        let bot_y = pb.bottom() - px(8.);

        // Hovering the right-edge lane expands the scrollbar; moving into text collapses it.
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(bar_x, mid_y),
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        );
        assert!(scroll_pane.read(cx).scrollbar_hovered_for_test());
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(20.), mid_y),
                pressed_button: None,
                modifiers: Default::default(),
            }),
            cx,
        );
        assert!(!scroll_pane.read(cx).scrollbar_hovered_for_test());

        // Clicking top of track jumps straight to top of scrollback, then dragging horizontally
        // off-lane down to middle and bottom scrubs continuously without selecting terminal text.
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: point(bar_x, top_y),
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), hist);
        assert!(!scroll_pane.read(cx).has_selection());
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(10.), mid_y),
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        let mid_offset = scroll_pane.read(cx).display_offset_for_test();
        assert!(
            mid_offset > hist / 4 && mid_offset < hist * 3 / 4,
            "dragging thumb to middle must scrub mid-scrollback, got {mid_offset}/{hist}"
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: point(pb.left() + px(10.), bot_y),
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        assert_eq!(scroll_pane.read(cx).display_offset_for_test(), 0);
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: point(pb.left() + px(10.), bot_y),
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert!(!scroll_pane.read(cx).has_selection());

        // Alt+click above thumb pages up cleanly.
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: point(bar_x, top_y),
                button: MouseButton::Left,
                modifiers: Modifiers::alt(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        let paged = scroll_pane.read(cx).display_offset_for_test();
        assert!(paged > 0 && paged < hist);

        // Keyboard scrollback shortcuts: Shift+Home -> top, Shift+End -> bottom, Shift+PageUp -> page up.
        scroll_pane.update(cx, |p, cx| {
            p.key_for_test("shift-home", w, cx);
            assert_eq!(p.display_offset_for_test(), hist);
            p.key_for_test("shift-end", w, cx);
            assert_eq!(p.display_offset_for_test(), 0);
            p.key_for_test("shift-pageup", w, cx);
            assert!(p.display_offset_for_test() > 0);
            p.key_for_test("shift-pagedown", w, cx);
            assert_eq!(p.display_offset_for_test(), 0);
            // Entering alt-screen hides the scrollbar cleanly.
            p.feed(b"\x1b[?1049h", cx);
        });
        w.draw(cx).clear(cx);
        assert!(!scroll_pane.read(cx).scrollbar_hovered_for_test());
        scroll_pane.update(cx, |p, cx| p.feed(b"\x1b[?1049l", cx));
    })?;
    draw_remote(&mut test);
    let mut saw_reconnect = false;
    while let Ok(cmd) = commands.try_recv() {
        if cmd["op"] == "reconnect" {
            saw_reconnect = true;
        }
    }
    assert!(
        saw_reconnect,
        "reload shortcut must send reconnect for remote pane"
    );

    test.update_window(window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(2, false)]);
    test.update_window(remote_window.into(), |_, w, _| w.activate_window())?;
    test.run_until_parked();
    assert_eq!(focused(), vec![(2, true)], "a hidden tab must stay unread");
    test.update_window(remote_window.into(), |_, w, _| w.remove_window())?;
    test.run_until_parked();

    // Verify startup cloak prevents Page::Home from flashing while waiting for helper prefs,
    // and lifts cleanly on either "prefs" or a helper startup "error".
    {
        let saved_prefs = test.update(|cx| cx.global::<crate::hub::Hub>().prefs.clone());
        let (cloak_bridge, _) = Bridge::recording();
        test.update(|cx| {
            let hub = cx.global_mut::<crate::hub::Hub>();
            hub.bridge = Some(cloak_bridge);
            hub.prefs = None;
        });
        let cloak_win = test.open_window(size(px(700.), px(500.)), |w, cx| {
            cx.new(|cx| Workspace::new(true, w, cx))
        })?;
        test.update_window(cloak_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            assert!(ws.read(cx).startup_cloak);
            assert!(ws.read(cx).startup_local);
            assert!(ws.read(cx).tabs.is_empty());
            w.draw(cx).clear(cx);
            let prefs_event = saved_prefs.as_ref().unwrap().to_event();
            ws.update(cx, |s, cx| s.event(prefs_event, w, cx));
            assert!(!ws.read(cx).startup_cloak);
            assert!(!ws.read(cx).startup_local);
            assert!(ws.read(cx).page == Page::Terminal);
            assert_eq!(ws.read(cx).tabs.len(), 1);
            // Overflow the 700px (compact) title bar with 7 tabs and verify:
            // - compact bar keeps >= 56px window-drag area and generous scrollable tab strip
            // - opening tab 7 auto-scrolls the strip right on frame 0
            // - selecting tab 0 auto-scrolls the strip back to the start
            // - the overflow menu renders cleanly and tooltips stay neutral monochrome.
            let first_pane = ws.read(cx).tabs[0].active;
            ws.update(cx, |s, cx| {
                for _ in 0..6 {
                    s.local(None, w, cx);
                }
            });
            w.draw(cx).clear(cx);
            let drag_bar = ws
                .read(cx)
                .drag
                .empty_bar
                .bounds()
                .expect("window drag area laid out");
            assert!(
                drag_bar.size.width >= px(55.5),
                "compact window-drag-area must keep >= 56px even with overflowing tabs, got {:?}",
                drag_bar.size.width
            );
            let strip_bounds = ws.read(cx).drag.strip.bounds();
            assert!(
                strip_bounds.size.width >= px(240.),
                "compact bar should preserve roomy tab strip, got {:?}",
                strip_bounds.size.width
            );
            assert!(
                ws.read(cx).drag.strip.max_offset().x > px(0.),
                "7 tabs on 700px window should overflow horizontally"
            );
            assert!(
                ws.read(cx).drag.strip.offset().x < px(0.),
                "active last tab should auto-scroll into view on frame 0, got {:?}",
                ws.read(cx).drag.strip.offset().x
            );
            ws.update(cx, |s, cx| s.select(first_pane, w, cx));
            w.draw(cx).clear(cx);
            assert_eq!(
                ws.read(cx).drag.strip.offset().x,
                px(0.),
                "selecting first tab must scroll strip back to 0"
            );
            ws.update(cx, |s, cx| s.set_bar_menu(true, cx));
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).overlay, Some(OverlayMenu::BarOverflow));
            ws.update(cx, |s, cx| s.set_bar_menu(false, cx));
            let theme = cx.theme();
            assert!(
                theme.tooltip_bg.s < 0.01 && theme.tooltip_border.s < 0.01,
                "tooltip colors must stay neutral monochrome, got bg={:?} border={:?}",
                theme.tooltip_bg,
                theme.tooltip_border
            );
        })?;
        test.update_window(cloak_win.into(), |_, w, _| w.remove_window())?;
        test.run_until_parked();

        // If the helper errors before sending prefs, the cloak lifts, the fallback shell opens,
        // and the error banner stays visible.
        let err_win = test.open_window(size(px(700.), px(500.)), |w, cx| {
            cx.new(|cx| Workspace::new(true, w, cx))
        })?;
        test.update_window(err_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            assert!(ws.read(cx).startup_cloak);
            ws.update(cx, |s, cx| {
                s.event(
                    json!({"event":"error","message":"helper crashed"}),
                    w,
                    cx,
                )
            });
            assert!(!ws.read(cx).startup_cloak);
            assert!(ws.read(cx).page == Page::Terminal);
            assert_eq!(ws.read(cx).tabs.len(), 1);
            assert_eq!(ws.read(cx).message, "helper crashed");
        })?;
        test.update_window(err_win.into(), |_, w, _| w.remove_window())?;
        test.update(|cx| {
            let hub = cx.global_mut::<crate::hub::Hub>();
            hub.bridge = None;
            hub.prefs = saved_prefs;
        });
        test.run_until_parked();
    }
    // Verify keyboard shortcuts work reliably across focus loss, Windows shifted keys,
    // tab/pane navigation, font sizing, and close requests.
    {
        let sc_win = test.open_window(size(px(900.), px(600.)), |w, cx| {
            cx.new(|cx| Workspace::new(false, w, cx))
        })?;
        let dispatch_key = |w: &mut Window, cx: &mut App, keystroke: Keystroke, is_held: bool| {
            w.dispatch_event(
                PlatformInput::KeyDown(KeyDownEvent {
                    keystroke,
                    is_held,
                    prefer_character_input: false,
                }),
                cx,
            );
        };
        let mac = cfg!(target_os = "macos");
        let new_tab = Keystroke::parse(if mac { "cmd-t" } else { "ctrl-shift-t" }).unwrap();
        let split_col = Keystroke::parse(if mac { "cmd-d" } else { "ctrl-shift-d" }).unwrap();
        let split_row = Keystroke::parse(if mac { "cmd-shift-d" } else { "ctrl-alt-d" }).unwrap();
        let zoom_key =
            Keystroke::parse(if mac { "cmd-shift-enter" } else { "ctrl-alt-enter" }).unwrap();
        let pane_next =
            Keystroke::parse(if mac { "cmd-alt-right" } else { "ctrl-alt-right" }).unwrap();
        let pane_prev =
            Keystroke::parse(if mac { "cmd-alt-left" } else { "ctrl-alt-left" }).unwrap();
        let settings_key = Keystroke::parse(if mac { "cmd-," } else { "ctrl-," }).unwrap();
        let tab_1 = Keystroke::parse(if mac { "cmd-1" } else { "alt-1" }).unwrap();
        let tab_last = Keystroke::parse(if mac { "cmd-9" } else { "alt-9" }).unwrap();
        let font_up = Keystroke::parse(if mac { "cmd-=" } else { "ctrl-=" }).unwrap();
        let font_down = Keystroke::parse(if mac { "cmd--" } else { "ctrl--" }).unwrap();
        let font_reset = Keystroke::parse(if mac { "cmd-0" } else { "ctrl-0" }).unwrap();
        let close_pane = Keystroke::parse(if mac { "cmd-w" } else { "ctrl-shift-w" }).unwrap();
        let close_tab = Keystroke::parse(if mac { "cmd-alt-w" } else { "ctrl-alt-w" }).unwrap();

        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).page == Page::Home);
            // Shortcuts must work immediately on Page::Home without clicking first.
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 1);
            assert!(ws.read(cx).page == Page::Terminal);
            // Auto-repeat must not spawn extra tabs.
            dispatch_key(w, cx, new_tab.clone(), true);
            assert_eq!(ws.read(cx).tabs.len(), 1);

            // Simulate clicking a non-focusable area (blur) and verify shortcuts still work.
            w.draw(cx).clear(cx);
            w.blur(cx);
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 2);
            dispatch_key(w, cx, new_tab.clone(), false);
            assert_eq!(ws.read(cx).tabs.len(), 3);
            let tab_ids: Vec<Id> = ws.read(cx).tabs.iter().map(|t| t.id).collect();

            // Tab switching: Alt+1 / Cmd+1 -> first, Alt+9 / Cmd+9 -> last, Ctrl+Tab, Ctrl+PageUp/Down.
            dispatch_key(w, cx, tab_1.clone(), false);
            assert_eq!(ws.read(cx).current, 0);
            dispatch_key(w, cx, tab_last.clone(), false);
            assert_eq!(ws.read(cx).current, 2);
            dispatch_key(w, cx, Keystroke::parse("ctrl-tab").unwrap(), false);
            assert_eq!(ws.read(cx).current, 0);
            dispatch_key(w, cx, Keystroke::parse("ctrl-shift-tab").unwrap(), false);
            assert_eq!(ws.read(cx).current, 2);
            dispatch_key(w, cx, Keystroke::parse("ctrl-pageup").unwrap(), false);
            assert_eq!(ws.read(cx).current, 1);
            dispatch_key(w, cx, Keystroke::parse("ctrl-pagedown").unwrap(), false);
            assert_eq!(ws.read(cx).current, 2);

            // Reorder active tab left and back right via Ctrl+Shift+PageUp / PageDown.
            dispatch_key(w, cx, Keystroke::parse("ctrl-shift-pageup").unwrap(), false);
            assert_eq!(ws.read(cx).current, 1);
            assert_eq!(ws.read(cx).tabs[1].id, tab_ids[2]);
            dispatch_key(
                w,
                cx,
                Keystroke::parse("ctrl-shift-pagedown").unwrap(),
                false,
            );
            assert_eq!(ws.read(cx).current, 2);
            assert_eq!(ws.read(cx).tabs[2].id, tab_ids[2]);

            // Splits, pane cycling forward & backward, and zoom toggle.
            let initial_pane = ws.read(cx).tabs[2].active;
            dispatch_key(w, cx, split_col, false);
            let second_pane = ws.read(cx).tabs[2].active;
            assert_ne!(second_pane, initial_pane);
            dispatch_key(w, cx, split_row, false);
            let third_pane = ws.read(cx).tabs[2].active;
            assert_ne!(third_pane, second_pane);
            dispatch_key(w, cx, pane_prev, false);
            assert_eq!(ws.read(cx).tabs[2].active, second_pane);
            dispatch_key(w, cx, pane_next, false);
            assert_eq!(ws.read(cx).tabs[2].active, third_pane);
            dispatch_key(w, cx, zoom_key.clone(), false);
            assert!(ws.read(cx).tabs[2].zoom);
            dispatch_key(w, cx, zoom_key, false);
            assert!(!ws.read(cx).tabs[2].zoom);

            // Settings shortcut (Ctrl+, on Win/Linux, Cmd+, on macOS) + Windows shifted Ctrl+<.
            dispatch_key(w, cx, settings_key, false);
            assert!(ws.read(cx).page == Page::Settings);
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            assert!(ws.read(cx).page == Page::Terminal);
            if !mac {
                dispatch_key(
                    w,
                    cx,
                    Keystroke {
                        modifiers: Modifiers::control(),
                        key: "<".into(),
                        key_char: None,
                    },
                    false,
                );
                assert!(ws.read(cx).page == Page::Settings);
                dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            }

            // Font size shortcuts (+1, shifted +, -1, reset 0) and ensure Ctrl+_ is untouched.
            assert!((ws.read(cx).prefs.font_size - DEFAULT_FONT_SIZE).abs() < 0.01);
            dispatch_key(w, cx, font_up, false);
            assert!((ws.read(cx).prefs.font_size - (DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01);
            dispatch_key(
                w,
                cx,
                Keystroke {
                    modifiers: if mac {
                        Modifiers::command()
                    } else {
                        Modifiers::control()
                    },
                    key: "+".into(),
                    key_char: None,
                },
                false,
            );
            assert!((ws.read(cx).prefs.font_size - (DEFAULT_FONT_SIZE + 2.0)).abs() < 0.01);
            dispatch_key(w, cx, font_down, false);
            assert!((ws.read(cx).prefs.font_size - (DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01);
            if !mac {
                // Ctrl+_ (readline undo) must not be hijacked as font zoom out.
                dispatch_key(
                    w,
                    cx,
                    Keystroke {
                        modifiers: Modifiers::control(),
                        key: "_".into(),
                        key_char: None,
                    },
                    false,
                );
                assert!(
                    (ws.read(cx).prefs.font_size - (DEFAULT_FONT_SIZE + 1.0)).abs() < 0.01
                );
            }
            dispatch_key(w, cx, font_reset, false);
            assert!((ws.read(cx).prefs.font_size - DEFAULT_FONT_SIZE).abs() < 0.01);

            // Close focused pane & close current tab shortcuts open close confirmation.
            assert!(!ws.read(cx).close_pending);
            dispatch_key(w, cx, close_pane, false);
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);
            dispatch_key(w, cx, close_tab, false);
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);

            // Tab right-click context menu must NEVER change the active tab or replace the pane's content.
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).current, 2);
            assert!(ws.read(cx).page == Page::Terminal);
            let first_tab_id = ws.read(cx).tabs[0].id;
            let active_tab_id = ws.read(cx).tabs[2].id;
            let first_tab_x = if mac { 160. } else { 90. };
            // Hovering an inactive tab tracks hovered_tab so dividers hide on both sides.
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(first_tab_x), px(20.)),
                    pressed_button: None,
                    modifiers: Default::default(),
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).hovered_tab, Some(first_tab_id));
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: point(px(first_tab_x), px(200.)),
                    pressed_button: None,
                    modifiers: Default::default(),
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert_eq!(ws.read(cx).hovered_tab, None);
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: point(px(first_tab_x), px(20.)),
                    button: MouseButton::Right,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert!(
                matches!(ws.read(cx).overlay, Some(OverlayMenu::Tab(id, _)) if id == first_tab_id),
                "right-clicking inactive tab must open context menu for that tab"
            );
            assert_eq!(
                ws.read(cx).current,
                2,
                "right-clicking an inactive tab must not switch the active tab"
            );
            assert!(
                ws.read(cx).page == Page::Terminal,
                "right-clicking a tab must never replace the terminal view"
            );
            // Escape closes the tab context menu and leaves the terminal active.
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).overlay.is_none());
            assert!(ws.read(cx).page == Page::Terminal);

            // Moving an inactive tab via tab menu keeps the current active tab selected.
            ws.update(cx, |s, cx| s.move_tab_by_id(first_tab_id, 1, cx));
            assert_eq!(ws.read(cx).tabs[1].id, first_tab_id);
            assert_eq!(ws.read(cx).tabs[ws.read(cx).current].id, active_tab_id);

            // Lightweight tab rename overlay keeps Page::Terminal intact and commits on Enter.
            ws.update(cx, |s, cx| s.open_tab_rename(first_tab_id, w, cx));
            w.draw(cx).clear(cx);
            assert_eq!(
                ws.read(cx).overlay,
                Some(OverlayMenu::TabRename(first_tab_id))
            );
            assert!(ws.read(cx).page == Page::Terminal);
            ws.update(cx, |s, cx| {
                s.tab_rename_input
                    .update(cx, |input, cx| input.set_value_silent("Build shell", cx));
            });
            dispatch_key(w, cx, Keystroke::parse("enter").unwrap(), false);
        })?;
        test.run_until_parked();
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            let active_tab_id = ws.read(cx).tabs[ws.read(cx).current].id;
            assert!(ws.read(cx).overlay.is_none());
            assert_eq!(ws.read(cx).tabs[1].name, "Build shell");
            assert!(ws.read(cx).page == Page::Terminal);

            // Close other tabs requests confirmation for all tabs except the chosen one.
            ws.update(cx, |s, cx| s.close_other_tabs(active_tab_id, w, cx));
            assert!(ws.read(cx).close_pending);
            ws.update(cx, |s, _| s.close_pending = false);
        })?;
        // Verify Escape also closes an open tab context menu after PopupMenu deferred focus settles.
        let first_tab_x = if mac { 160. } else { 90. };
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            let first_tab_id = ws.read(cx).tabs[0].id;
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: point(px(first_tab_x), px(20.)),
                    button: MouseButton::Right,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.draw(cx).clear(cx);
            assert!(
                matches!(ws.read(cx).overlay, Some(OverlayMenu::Tab(id, _)) if id == first_tab_id)
            );
        })?;
        test.run_until_parked();
        test.update_window(sc_win.into(), |root, w, cx| {
            let ws = root.downcast::<Workspace>().unwrap();
            w.draw(cx).clear(cx);
            dispatch_key(w, cx, Keystroke::parse("escape").unwrap(), false);
            w.draw(cx).clear(cx);
            assert!(ws.read(cx).overlay.is_none());
            assert!(ws.read(cx).page == Page::Terminal);
        })?;
        test.update_window(sc_win.into(), |_, w, _| w.remove_window())?;
        test.run_until_parked();
    }
    // Open the menu from the real + target. Dismissing it must leave the workspace alone.
    let x = if cfg!(target_os = "macos") { 132. } else { 62. };
    let menu_open = |test: &mut HeadlessAppContext| {
        test.update_window(window.into(), |root, _, cx| {
            let s = root.downcast::<Workspace>().unwrap();
            assert!(s.read(cx).tabs.is_empty());
            s.read(cx).overlay == Some(OverlayMenu::NewTab)
        })
        .unwrap()
    };
    click(&mut test, x, 20.)?;
    draw(&mut test);
    assert!(menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    click(&mut test, 950., 300.)?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    test.update_window(window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("escape").unwrap(), cx)
    })?;
    draw(&mut test);
    assert!(!menu_open(&mut test));
    click(&mut test, x, 20.)?;
    draw(&mut test);
    click(&mut test, x + 45., 99.)?;
    draw(&mut test);
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>().unwrap().update(cx, |s, cx| {
            assert!(s.page == Page::Home && s.overlay.is_none() && s.tabs.is_empty());
            assert!(s.address.read(cx).focus_handle(cx).is_focused(w));
            s.accounts = json!({"accounts":[{"origin":"https://example.com","account":{"id":"test"},"canCreate":true}]});
            cx.notify();
        })
    })?;
    click(&mut test, x, 20.)?;
    draw(&mut test);
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.advance_clock(gpui::components::ANIM_FAST);
        draw(&mut test);
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(dir).join("new-tab-menu.png"))?;
    }
    click(&mut test, x + 45., 99.)?;
    draw(&mut test);
    test.update_window(window.into(), |root, _, cx| {
        let s = root.downcast::<Workspace>().unwrap();
        assert!(
            s.read(cx).page == Page::Choose
                && s.read(cx).overlay.is_none()
                && s.read(cx).tabs.is_empty()
        );
    })?;
    click(&mut test, x, 20.)?;
    draw(&mut test);
    test.update_window(window.into(), |_, w, cx| {
        w.dispatch_keystroke(Keystroke::parse("down").unwrap(), cx);
        let enter = Keystroke::parse("enter").unwrap();
        w.dispatch_keystroke(enter.clone(), cx);
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: enter }), cx);
    })?;
    draw(&mut test);
    let p = test
        .update_window(window.into(), |root, _, cx| {
            root.downcast::<Workspace>().unwrap().read(cx).active()
        })?
        .expect("New terminal button");
    test.update_window(window.into(), |_, w, cx| {
        let cmd = if cfg!(windows) {
            "echo NATIVE-PTY-42"
        } else {
            "printf 'NATIVE-PTY-%d\\n' $((6*7))"
        };
        p.update(cx, |pane, cx| {
            pane.replace_text_in_range(None, cmd, w, cx);
            pane.key_for_test("enter", w, cx);
        });
    })?;
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        draw(&mut test);
        if test.update(|cx| p.read(cx).screen_text().contains("NATIVE-PTY-42")) {
            break;
        }
        anyhow::ensure!(
            Instant::now() < deadline,
            "Shell output did not reach the Alacritty grid"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    #[cfg(unix)]
    let check_startup_size =
        |test: &mut HeadlessAppContext, pane: &Entity<Pane>| -> anyhow::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                draw(test);
                if test.update(|cx| {
                    let pane = pane.read(cx);
                    pane.measured_size().is_some_and(|(cols, rows)| {
                        (cols, rows) != (80, 24)
                            && pane
                                .screen_text()
                                .contains(&format!("INITIAL-SIZE={rows} {cols}"))
                    })
                }) {
                    return Ok(());
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "The shell did not start at the measured pane size"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
    #[cfg(unix)]
    check_startup_size(&mut test, &p)?;
    #[cfg(target_os = "macos")]
    {
        // Use a real raw-mode reader. An image-only Command-V must leave its first
        // byte available for the foreground program's own Control-V binding.
        let wait_for_output = |test: &mut HeadlessAppContext, marker: &str| -> anyhow::Result<()> {
            let deadline = Instant::now() + Duration::from_secs(8);
            loop {
                draw(test);
                if test.update(|cx| p.read(cx).screen_text().contains(marker)) {
                    return Ok(());
                }
                anyhow::ensure!(
                    Instant::now() < deadline,
                    "Missing local PTY output: {marker}"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        test.update_window(window.into(), |_, w, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(
                r#"stty raw -echo; printf 'READER-%s\r\n' READY; v=$(dd bs=1 count=1 2>/dev/null | od -An -tu1 | tr -d ' '); stty sane; printf 'LOCAL-PASTE=%s\n' "$v""#.to_string()
            ));
            p.update(cx, |pane, cx| {
                pane.key_for_test("cmd-v", w, cx);
                pane.key_for_test("enter", w, cx);
            });
        })?;
        wait_for_output(&mut test, "READER-READY")?;
        test.update_window(window.into(), |_, w, cx| {
            let image = gpui::Image::from_bytes(
                gpui::ImageFormat::Png,
                include_bytes!("../../../public/outpost-256.png").to_vec(),
            );
            cx.write_to_clipboard(ClipboardItem::new_image(&image));
            p.update(cx, |pane, cx| {
                pane.key_for_test("cmd-v", w, cx);
                pane.key_for_test("ctrl-v", w, cx);
            });
        })?;
        wait_for_output(&mut test, "LOCAL-PASTE=22")?;
    }
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.split(Axis::Across, w, cx))
    })?;
    draw(&mut test);
    assert!(test.update_window(window.into(), |root, _, cx| {
        root.downcast::<Workspace>().unwrap().read(cx).panes.len() == 2
    })?);
    #[cfg(unix)]
    {
        let split_pane = test.update_window(window.into(), |root, _, cx| {
            root.downcast::<Workspace>()
                .unwrap()
                .read(cx)
                .active()
                .unwrap()
        })?;
        check_startup_size(&mut test, &split_pane)?;
    }
    if let Some(dir) = std::env::var_os("OUTPOST_TEST_SCREENSHOTS") {
        test.capture_screenshot(window.into())?
            .save(PathBuf::from(dir).join("split.png"))?;
    }
    // Dragging a split pane header must immediately show cursor-following drag feedback even while
    // still over the source pane, and keep showing it over split drop targets until released.
    test.update_window(window.into(), |root, w, cx| {
        let ws = root.downcast::<Workspace>().unwrap();
        w.draw(cx).clear(cx);
        let left_id = ws.read(cx).tabs[0].layout.first();
        let left_bounds = ws.read(cx).watches[&left_id].1.bounds().unwrap();
        let header_start = point(left_bounds.left() + px(40.), left_bounds.top() + px(14.));
        let over_self = point(left_bounds.left() + px(70.), left_bounds.top() + px(60.));
        w.dispatch_event(
            PlatformInput::MouseDown(MouseDownEvent {
                position: header_start,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
                first_mouse: false,
            }),
            cx,
        );
        w.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: over_self,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        assert_eq!(ws.read(cx).drag.dragged_pane(), Some(left_id));
        assert!(
            ws.read(cx).drag_overlay(w).is_some(),
            "pane drag must render cursor-following feedback even over the source pane"
        );
        w.draw(cx).clear(cx);
        w.dispatch_event(
            PlatformInput::MouseUp(MouseUpEvent {
                position: over_self,
                button: MouseButton::Left,
                modifiers: Default::default(),
                click_count: 1,
            }),
            cx,
        );
        assert!(ws.read(cx).drag.dragged_pane().is_none());
        assert!(ws.read(cx).drag_overlay(w).is_none());
    })?;
    // Exercise the same capture, geometry and release handlers as a physical drag.
    let gesture = |test: &mut HeadlessAppContext,
                   handle: AnyWindowHandle,
                   start: Point<Pixels>,
                   end: Point<Pixels>,
                   cancel: bool|
     -> anyhow::Result<()> {
        test.update_window(handle, |_, w, cx| {
            w.draw(cx).clear(cx);
            w.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position: start,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                    first_mouse: false,
                }),
                cx,
            );
            w.dispatch_event(
                PlatformInput::MouseMove(MouseMoveEvent {
                    position: end,
                    pressed_button: Some(MouseButton::Left),
                    modifiers: Default::default(),
                }),
                cx,
            );
            // A hover normally lasts across frames; insertion may change tab
            // widths before the mouse-up reaches its original window.
            w.draw(cx).clear(cx);
            for other in cx.windows().into_iter().filter(|h| *h != handle) {
                let _ = cx.update_window(other, |_, w, cx| w.draw(cx).clear(cx));
            }
            if cancel {
                w.dispatch_event(
                    PlatformInput::KeyDown(KeyDownEvent {
                        keystroke: Keystroke::parse("escape").unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                    }),
                    cx,
                );
            }
            w.dispatch_event(
                PlatformInput::MouseUp(MouseUpEvent {
                    position: end,
                    button: MouseButton::Left,
                    modifiers: Default::default(),
                    click_count: 1,
                }),
                cx,
            );
        })?;
        Ok(())
    };
    let header = test.update_window(window.into(), |root, _, cx| {
        let s = root.downcast::<Workspace>().unwrap();
        let s = s.read(cx);
        let first = s.tabs[0].layout.first();
        s.watches[&first].1.bounds().unwrap().origin + point(px(40.), px(12.))
    })?;
    let outside = point(px(1160.), px(220.));
    gesture(&mut test, window.into(), header, outside, true)?;
    assert_eq!(
        test.update(|cx| cx.windows().len()),
        1,
        "Escape must cancel a tear-off"
    );
    gesture(&mut test, window.into(), header, outside, false)?;
    draw(&mut test);
    let detached = test
        .update(|cx| cx.windows().into_iter().find(|h| *h != window.into()))
        .expect("off-window release creates window");
    let target = test.update_window(window.into(), |_, w, cx| {
        drag::to_desktop(w, point(px(50.), px(360.)), cx)
    })?;
    let (handle, drop) = test.update_window(detached, |root, w, cx| {
        w.draw(cx).clear(cx);
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert!(s.panes.values().any(|v| v == &p), "the original PTY moved");
        (
            s.drag.strip.bounds_for_item(0).unwrap().center(),
            drag::from_desktop(w, target, cx),
        )
    })?;
    gesture(&mut test, detached, handle, drop, false)?;
    draw(&mut test);
    assert_eq!(
        test.update(|cx| cx.windows().len()),
        1,
        "docking consumes the empty source window"
    );
    assert!(test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        s.tabs.len() == 1 && s.panes.len() == 2 && s.active().as_ref() == Some(&p)
    })?);
    assert!(test.update(|cx| p.read(cx).screen_text().contains("NATIVE-PTY-42")));
    // Pull a pane out of a group onto its own tab, then reorder the tabs.
    let (pane_header, bar_end) = test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        (
            s.watches[&s.tabs[0].active].1.bounds().unwrap().origin + point(px(35.), px(11.)),
            s.drag.empty_bar.bounds().unwrap().center(),
        )
    })?;
    gesture(&mut test, window.into(), pane_header, bar_end, false)?;
    draw(&mut test);
    let (tab_start, before, stable_ids) = test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert_eq!(s.tabs.len(), 2, "the pane was promoted to a tab");
        (
            s.drag.strip.bounds_for_item(1).unwrap().center(),
            s.drag.strip.bounds_for_item(0).unwrap().origin + point(px(8.), px(10.)),
            [s.tabs[0].id, s.tabs[1].id],
        )
    })?;
    gesture(&mut test, window.into(), tab_start, before, false)?;
    draw(&mut test);
    test.update_window(window.into(), |root, _, cx| {
        let entity = root.downcast::<Workspace>().unwrap();
        let s = entity.read(cx);
        assert_eq!([s.tabs[0].id, s.tabs[1].id], [stable_ids[1], stable_ids[0]]);
        assert_eq!(s.active().as_ref(), Some(&p));
    })?;
    // Move a nested layout as one tab, hover another window, cancel, then dock.
    test.update_window(window.into(), |root, w, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .update(cx, |s, cx| s.split(Axis::Down, w, cx));
    })?;
    draw(&mut test);
    let start = test.update_window(window.into(), |root, _, cx| {
        root.downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .drag
            .strip
            .bounds_for_item(0)
            .unwrap()
            .center()
    })?;
    gesture(&mut test, window.into(), start, outside, false)?;
    draw(&mut test);
    let detached = test
        .update(|cx| cx.windows().into_iter().find(|h| *h != window.into()))
        .expect("nested tab detached");
    let tab_bar = test.update_window(window.into(), |root, w, cx| {
        let local = root
            .downcast::<Workspace>()
            .unwrap()
            .read(cx)
            .drag
            .empty_bar
            .bounds()
            .unwrap()
            .center();
        drag::to_desktop(w, local, cx)
    })?;
    let (start, end) = test.update_window(detached, |root, w, cx| {
        w.draw(cx).clear(cx);
        let root = root.downcast::<Workspace>().unwrap();
        let s = root.read(cx);
        assert_eq!(s.panes.len(), 2);
        (
            s.drag.strip.bounds_for_item(0).unwrap().center(),
            drag::from_desktop(w, tab_bar, cx),
        )
    })?;
    gesture(&mut test, detached, start, end, true)?;
    assert_eq!(test.update(|cx| cx.windows().len()), 2);
    gesture(&mut test, detached, start, end, false)?;
    draw(&mut test);
    assert_eq!(test.update(|cx| cx.windows().len()), 1);
    test.update_window(window.into(), |root, _, cx| {
        let root = root.downcast::<Workspace>().unwrap();
        let s = root.read(cx);
        assert_eq!(s.tabs.len(), 2);
        assert_eq!(s.panes.len(), 3);
        assert!(matches!(
            s.tabs[s.current].layout,
            Layout::Split {
                axis: Axis::Down,
                ..
            }
        ));
        assert!(s.panes.values().any(|v| v == &p));
        assert!(p.read(cx).screen_text().contains("NATIVE-PTY-42"));
    })?;
    let mut prompts = gpui::TestApp::with_text_system_and_assets(
        gpui_platform::current_platform(true).text_system(),
        Arc::new(gpui::icons::LucideAssetSource::new()),
    );
    prompts.update(init_test);
    let mut workspace = prompts.open_window(|w, cx| Workspace::new(false, w, cx));
    let (left, right) = workspace.update(|s, w, cx| {
        s.local(None, w, cx);
        let left = s.tabs[s.current].active;
        s.split(Axis::Across, w, cx);
        (left, s.tabs[s.current].active)
    });
    let header_control =
        |workspace: &mut gpui::TestAppWindow<Workspace>, pane: Id, from_right: f32| {
            workspace.draw();
            workspace.read(|s, _| {
                let bounds = s.watches[&pane].1.bounds().unwrap();
                point(bounds.right() - px(from_right), bounds.top() + px(14.))
            })
        };
    let title = header_control(&mut workspace, left, 130.);
    workspace.simulate_click(title, MouseButton::Left);
    workspace.update(|s, w, cx| assert!(s.panes[&left].read(cx).focus.is_focused(w)));
    let tab = workspace.read(|s, _| s.drag.strip.bounds_for_item(0).unwrap().center());
    workspace.simulate_click(tab, MouseButton::Left);
    workspace.update(|s, w, cx| assert!(s.panes[&left].read(cx).focus.is_focused(w)));
    let zoom = header_control(&mut workspace, left, 65.);
    workspace.simulate_click(zoom, MouseButton::Left);
    workspace.read(|s, _| {
        assert!(s.tabs[0].zoom);
        assert_eq!(s.tabs[0].active, left);
        assert!(s.drag.gesture.is_none());
    });
    let restore = header_control(&mut workspace, left, 65.);
    workspace.simulate_click(restore, MouseButton::Left);
    assert!(!workspace.read(|s, _| s.tabs[0].zoom));
    let options = header_control(&mut workspace, right, 40.);
    workspace.simulate_click(options, MouseButton::Left);
    assert_eq!(
        workspace.read(|s, _| s.overlay),
        Some(OverlayMenu::Pane(right))
    );
    workspace.draw();
    workspace.simulate_keystroke("escape");
    assert_eq!(workspace.read(|s, _| s.overlay), None);

    // Terminal bell lifecycle on normal shells:
    // 1) Active pane bell auto-hides after 2 seconds.
    workspace.update(|_, w, _| w.activate_window());
    prompts.run_until_parked();
    workspace.update(|s, _, cx| {
        s.panes[&right].update(cx, |p, cx| p.feed(b"\x07", cx));
        assert!(s.panes[&right].read(cx).bell);
    });
    prompts
        .background_executor()
        .advance_clock(Duration::from_millis(1500));
    prompts.run_until_parked();
    assert!(workspace.read(|s, cx| s.panes[&right].read(cx).bell));
    prompts
        .background_executor()
        .advance_clock(Duration::from_millis(600));
    prompts.run_until_parked();
    assert!(!workspace.read(|s, cx| s.panes[&right].read(cx).bell));

    // 2) Active pane bell clears immediately on typing.
    workspace.update(|s, _, cx| {
        s.panes[&right].update(cx, |p, cx| p.feed(b"\x07", cx));
        assert!(s.panes[&right].read(cx).bell);
    });
    workspace.simulate_keystroke("a");
    assert!(!workspace.read(|s, cx| s.panes[&right].read(cx).bell));

    // 3) Bell fired while active clears immediately when switching away (no stale alert).
    workspace.update(|s, w, cx| {
        s.panes[&right].update(cx, |p, cx| p.feed(b"\x07", cx));
        assert!(s.panes[&right].read(cx).bell);
        s.select(left, w, cx);
    });
    prompts.run_until_parked();
    assert!(!workspace.read(|s, cx| s.panes[&right].read(cx).bell));

    // 4) Background pane bell persists indefinitely while unfocused, survives a brief flick,
    //    and auto-hides 2 seconds after the pane stays active.
    workspace.update(|s, _, cx| {
        s.panes[&right].update(cx, |p, cx| p.feed(b"\x07", cx));
        assert!(s.panes[&right].read(cx).bell);
    });
    prompts
        .background_executor()
        .advance_clock(Duration::from_secs(10));
    prompts.run_until_parked();
    assert!(workspace.read(|s, cx| s.panes[&right].read(cx).bell));
    workspace.update(|s, w, cx| s.select(right, w, cx));
    prompts.run_until_parked();
    prompts
        .background_executor()
        .advance_clock(Duration::from_millis(500));
    prompts.run_until_parked();
    workspace.update(|s, w, cx| s.select(left, w, cx));
    prompts.run_until_parked();
    prompts
        .background_executor()
        .advance_clock(Duration::from_secs(5));
    prompts.run_until_parked();
    assert!(workspace.read(|s, cx| s.panes[&right].read(cx).bell));
    workspace.update(|s, w, cx| s.select(right, w, cx));
    prompts.run_until_parked();
    prompts
        .background_executor()
        .advance_clock(Duration::from_millis(2100));
    prompts.run_until_parked();
    assert!(!workspace.read(|s, cx| s.panes[&right].read(cx).bell));

    // Switch picker orders open panes by most recently focused first.
    workspace.update(|s, w, cx| {
        s.show(Page::Switch, w, cx);
        let items = s.picker_items(cx);
        assert!(matches!(items[0], picker::PickerItem::OpenPane(id) if id == right));
        assert!(matches!(items[1], picker::PickerItem::OpenPane(id) if id == left));
        s.select(left, w, cx);
        s.show(Page::Switch, w, cx);
        let items = s.picker_items(cx);
        assert!(matches!(items[0], picker::PickerItem::OpenPane(id) if id == left));
        assert!(matches!(items[1], picker::PickerItem::OpenPane(id) if id == right));
        s.select(right, w, cx);

        // Local pane supports OSC 7501 Program Status and OSC 7770 SSH bridge lifecycle.
        let local_pane = s.panes[&right].clone();
        local_pane.update(cx, |p, cx| {
            assert!(!p.can_paste_image());
            p.feed(
                b"\x1b]7501;state=working:progress=60:title=QnVpbGRpbmc=\x1b\\",
                cx,
            );
            assert_eq!(p.activity, "working");
            assert_eq!(p.activity_progress, Some(60));
            assert_eq!(
                panes::pane_activity_state(p),
                Some(ActivityState::Working)
            );
            assert_eq!(
                panes::pane_status_label(p),
                "Local terminal · Working · 60% · Building"
            );
            // `done` latches across a subsequent `idle` report.
            p.feed(b"\x1b]7501;state=done\x1b\\\x1b]7501;state=idle\x1b\\", cx);
            assert_eq!(p.activity, "finished");
            assert_eq!(
                panes::pane_activity_state(p),
                Some(ActivityState::Attention)
            );
            // SSH bridge `ready` activates image paste; `shell` clears both paste and activity.
            p.feed(
                b"\x1b]7770;outpost;ssh;eyJ2IjoxLCJ0IjoicmVhZHkiLCJzZXNzaW9uIjoibm9uY2UxIiwidG9vbCI6ImNsYXVkZSIsImNsaXBib2FyZCI6dHJ1ZX0\x07",
                cx,
            );
            assert!(p.can_paste_image());
            p.feed(b"\x1b]7770;outpost;ssh;eyJ2IjoxLCJ0Ijoic2hlbGwifQ\x07", cx);
            assert!(!p.can_paste_image());
            assert!(p.activity.is_empty());
        });
    });

    // Closing an inactive pane must neither arm a drag nor close the selected sibling.
    let close = header_control(&mut workspace, left, 15.);
    workspace.simulate_mouse_down(close, MouseButton::Left);
    workspace.read(|s, _| {
        assert!(s.drag.gesture.is_none());
        assert_eq!(s.tabs[0].active, right);
    });
    workspace.simulate_mouse_up(close, MouseButton::Left);
    assert!(prompts.has_pending_prompt());
    prompts.simulate_prompt_answer("Cancel");
    prompts.run_until_parked();
    assert_eq!(workspace.read(|s, _| s.panes.len()), 2);
    workspace.update(|s, w, cx| assert!(s.panes[&right].read(cx).focus.is_focused(w)));
    workspace.draw();
    workspace.simulate_click(close, MouseButton::Left);
    prompts.simulate_prompt_answer("Close pane");
    prompts.run_until_parked();
    workspace.update(|s, w, cx| {
        assert!(matches!(s.tabs[0].layout, Layout::Pane(id) if id == right));
        assert_eq!(s.tabs[0].active, right);
        assert!(!s.request_window_close(w, cx));
    });
    prompts.simulate_prompt_answer("Cancel");
    prompts.run_until_parked();
    let arrival = workspace.update(|s, w, cx| {
        assert_eq!(s.panes.len(), 1);
        assert!(!s.close_pending);
        assert!(!s.request_window_close(w, cx));
        s.local(None, w, cx);
        assert!(!s.request_window_close(w, cx));
        s.tabs[s.current].active
    });
    prompts.simulate_prompt_answer("Close window");
    prompts.run_until_parked();
    assert!(!prompts.has_pending_prompt());
    workspace.update(|s, w, cx| {
        assert_eq!(s.panes.keys().copied().collect::<Vec<_>>(), vec![arrival]);
        s.close(arrival, w, cx);
    });
    prompts.simulate_prompt_answer("Close pane");
    prompts.run_until_parked();
    assert!(prompts.read(|cx| cx.windows().is_empty()));
    Ok(())
}

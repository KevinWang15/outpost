use crate::{open_workspace, workspace::Workspace};
use gpui::*;
actions!(
    outpost,
    [
        NewWindow,
        NewTerminal,
        OpenSessions,
        SwitchSession,
        TerminalActions,
        Settings,
        CloseTerminal,
        CloseTab,
        CloseWindow,
        CopySelection,
        PasteClipboard,
        SelectAll,
        FindInTerminal,
        ComposeMessage,
        ClearScreen,
        SplitColumns,
        SplitRows,
        ToggleZoom,
        FocusNextPane,
        FocusPrevPane,
        IncreaseFontSize,
        DecreaseFontSize,
        ResetFontSize,
        ReloadTerminal,
        ToggleFullscreen,
        NextTab,
        PrevTab,
        MoveTabLeft,
        MoveTabRight,
        SelectTab1,
        SelectTab2,
        SelectTab3,
        SelectTab4,
        SelectTab5,
        SelectTab6,
        SelectTab7,
        SelectTab8,
        SelectTab9,
        Quit
    ]
);

pub fn init(cx: &mut App) {
    cx.on_action(|_: &NewWindow, cx| {
        let _ = open_workspace(true, cx);
    });
    cx.on_action(|_: &Quit, cx| {
        let handle = cx
            .active_window()
            .or_else(|| cx.windows().first().copied())
            .and_then(|h| h.downcast::<Workspace>());
        if let Some(h) = handle {
            let _ = h.update(cx, |_, w, cx| {
                let response = w.prompt(
                    PromptLevel::Warning,
                    "Quit Outpost?",
                    Some(
                        "Local shells in all windows will end. Managed sessions will keep running.",
                    ),
                    &["Cancel", "Quit"],
                    cx,
                );
                cx.spawn(async move |_, cx| {
                    if response.await == Ok(1) {
                        cx.update(|cx| cx.quit())
                    }
                })
                .detach()
            });
        } else {
            cx.quit()
        }
    });
    if cfg!(target_os = "macos") {
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
    } else {
        cx.bind_keys([KeyBinding::new("alt-f4", CloseWindow, None)]);
    }
    cx.set_menus([
        Menu::new("Outpost").items([
            MenuItem::action("Settings…", Settings),
            MenuItem::separator(),
            MenuItem::action("Quit Outpost", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New window", NewWindow),
            MenuItem::action("New local terminal tab", NewTerminal),
            MenuItem::action("Servers and sessions…", OpenSessions),
            MenuItem::action("Switch session…", SwitchSession),
            MenuItem::action("Settings…", Settings),
            MenuItem::separator(),
            MenuItem::action("Close focused pane", CloseTerminal),
            MenuItem::action("Close current tab", CloseTab),
            MenuItem::action("Close window", CloseWindow),
        ]),
        Menu::new("Edit").items([
            MenuItem::action("Copy", CopySelection),
            MenuItem::action("Paste", PasteClipboard),
            MenuItem::action("Select all", SelectAll),
            MenuItem::separator(),
            MenuItem::action("Find in terminal…", FindInTerminal),
            MenuItem::action("Write a message…", ComposeMessage),
            MenuItem::action("Clear screen", ClearScreen),
        ]),
        Menu::new("View").items([
            MenuItem::action("Split side by side", SplitColumns),
            MenuItem::action("Split top and bottom", SplitRows),
            MenuItem::action("Zoom / restore pane", ToggleZoom),
            MenuItem::action("Focus next pane", FocusNextPane),
            MenuItem::action("Focus previous pane", FocusPrevPane),
            MenuItem::separator(),
            MenuItem::action("Larger terminal text", IncreaseFontSize),
            MenuItem::action("Smaller terminal text", DecreaseFontSize),
            MenuItem::action("Reset terminal text size", ResetFontSize),
            MenuItem::separator(),
            MenuItem::action("Reload terminal", ReloadTerminal),
            MenuItem::action("Terminal actions…", TerminalActions),
            MenuItem::action("Toggle full screen", ToggleFullscreen),
        ]),
        Menu::new("Tabs").items([
            MenuItem::action("Next tab", NextTab),
            MenuItem::action("Previous tab", PrevTab),
            MenuItem::action("Move tab left", MoveTabLeft),
            MenuItem::action("Move tab right", MoveTabRight),
            MenuItem::separator(),
            MenuItem::action("Tab 1", SelectTab1),
            MenuItem::action("Tab 2", SelectTab2),
            MenuItem::action("Tab 3", SelectTab3),
            MenuItem::action("Tab 4", SelectTab4),
            MenuItem::action("Tab 5", SelectTab5),
            MenuItem::action("Tab 6", SelectTab6),
            MenuItem::action("Tab 7", SelectTab7),
            MenuItem::action("Tab 8", SelectTab8),
            MenuItem::action("Last tab", SelectTab9),
        ]),
    ]);
}

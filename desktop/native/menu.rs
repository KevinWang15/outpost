use crate::{open_workspace, workspace::Workspace};
use gpui::*;
actions!(
    outpost,
    [
        NewWindow,
        NewTerminal,
        TerminalActions,
        Settings,
        CloseTerminal,
        CopySelection,
        PasteClipboard,
        SelectAll,
        FindInTerminal,
        ClearScreen,
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
    cx.bind_keys([KeyBinding::new(
        if cfg!(target_os = "macos") {
            "cmd-q"
        } else {
            "alt-f4"
        },
        Quit,
        None,
    )]);
    cx.set_menus([
        Menu::new("Outpost").items([
            MenuItem::action("Settings", Settings),
            MenuItem::separator(),
            MenuItem::action("Quit Outpost", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New window", NewWindow),
            MenuItem::action("New local terminal", NewTerminal),
            MenuItem::action("Terminal actions", TerminalActions),
            MenuItem::separator(),
            MenuItem::action("Close terminal", CloseTerminal),
        ]),
        Menu::new("Edit").items([
            MenuItem::action("Copy", CopySelection),
            MenuItem::action("Paste", PasteClipboard),
            MenuItem::action("Select all", SelectAll),
            MenuItem::separator(),
            MenuItem::action("Find in terminal", FindInTerminal),
            MenuItem::action("Clear screen", ClearScreen),
        ]),
    ]);
}

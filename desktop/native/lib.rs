mod agent_mark;
mod bridge;
mod colors;
mod hub;
mod instance;
mod keys;
mod layout;
mod menu;
mod pty;
mod terminal;
mod workspace;

use gpui::{
    components::{Theme, init_components},
    icons::LucideAssetSource,
    prelude::*,
    *,
};
use workspace::Workspace;

pub fn run() {
    let app = gpui_platform::application().with_assets(LucideAssetSource::new());
    let (links, queue) = async_channel::unbounded();
    let urls = std::env::args()
        .skip(1)
        .filter(|s| s.starts_with("outpost://"))
        .collect();
    let Some(_owner) =
        instance::claim(&bridge::data_dir(), urls, links.clone()).expect("Open desktop profile")
    else {
        return;
    };
    app.on_open_urls(move |urls| {
        for url in urls {
            let _ = links.try_send(url);
        }
    });
    app.run(move |cx| {
        init(cx);
        menu::init(cx);
        let local = queue.is_empty();
        hub::Hub::start(queue, cx);
        open_workspace(local, cx).expect("Open Outpost window");
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit()
            }
        })
        .detach();
        cx.activate(true);
    });
}

fn open_workspace(local: bool, cx: &mut App) -> anyhow::Result<WindowHandle<Workspace>> {
    open_workspace_at(local, None, cx)
}

fn open_workspace_at(
    local: bool,
    placement: Option<(Bounds<Pixels>, Option<DisplayId>)>,
    cx: &mut App,
) -> anyhow::Result<WindowHandle<Workspace>> {
    let (bounds, display_id) =
        placement.unwrap_or_else(|| (Bounds::centered(None, size(px(1100.), px(740.)), cx), None));
    let opts = WindowOptions {
        app_owns_titlebar_drag: true,
        display_id,
        app_id: Some("dev.outpost.desktop".into()),
        titlebar: Some(TitlebarOptions {
            title: Some("Outpost".into()),
            appears_transparent: cfg!(target_os = "macos"),
            traffic_light_position: cfg!(target_os = "macos").then(|| point(px(14.), px(13.))),
        }),
        window_bounds: Some(WindowBounds::Windowed(bounds)),
        window_min_size: Some(size(px(480.), px(320.))),
        ..Default::default()
    };
    cx.open_window(opts, |w, cx| cx.new(|cx| Workspace::new(local, w, cx)))
}

fn init(cx: &mut App) {
    init_components(cx);
    let mut theme = Theme::dark();
    theme.background = rgb(0x0c0c0c).into();
    theme.surface = rgb(0x161616).into();
    theme.border = rgb(0x2e2e2e).into();
    Theme::set_global(theme, cx);
}
#[cfg(feature = "ui-tests")]
pub use workspace::exercise_workspace;

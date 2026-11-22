use super::*;
use gpui::components::Button;
use std::io::Cursor;

#[derive(Default)]
pub(crate) struct FilePreviews {
    entries: HashMap<String, PreviewState>,
    most_recent: Option<(String, Arc<Image>)>,
    badge: SnapshotSource,
}
enum PreviewState {
    Loading(u64),
    Ready(Arc<Image>),
    Failed(String),
}
impl FilePreviews {
    pub(super) fn retain(&mut self, files: &[Value]) {
        self.entries
            .retain(|id, _| files.iter().any(|f| f["id"] == *id));
        if self
            .most_recent
            .as_ref()
            .is_some_and(|(id, _)| !self.entries.contains_key(id))
        {
            self.most_recent = None;
        }
    }
}
fn supported(file: &Value) -> bool {
    matches!(
        file["mediaType"].as_str(),
        Some("image/png" | "image/jpeg" | "image/webp" | "image/gif")
    )
}
fn size_label(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.)
    } else {
        format!("{:.1} MiB", bytes as f64 / 1048576.)
    }
}
fn details(file: &Value) -> String {
    let timestamp = file["createdAt"].as_str().unwrap_or("");
    format!(
        "{}  ·  {} UTC",
        size_label(file["size"].as_u64().unwrap_or(0)),
        timestamp.get(..16).unwrap_or(timestamp).replace('T', " ")
    )
}
fn action(id: &'static str, glyph: LucideIcon, hint: &'static str) -> Button {
    Button::icon(id, glyph)
        .size(ComponentSize::Sm)
        .tooltip_text(hint)
}

impl Workspace {
    pub(super) fn open_files(&mut self, id: Id, w: &mut Window, cx: &mut Context<Self>) {
        self.select(id, w, cx);
        self.files_menu = Some(id);
        self.focus.focus(w, cx);
        self.panes[&id].read(cx).command("files", json!({}));
        cx.notify();
    }
    fn view_file(&mut self, id: Id, file: &Value, cx: &mut Context<Self>) {
        self.files_menu = None;
        self.preview_id = Some(strval(file, "id"));
        self.preview = self.panes[&id]
            .read(cx)
            .file_previews
            .most_recent
            .as_ref()
            .filter(|(key, _)| file["id"] == *key)
            .map(|(_, image)| image.clone());
        self.message.clear();
        if self.preview.is_none() && supported(file) {
            self.request_preview(id, file, cx);
        }
        cx.notify();
    }
    fn request_preview(&self, pane: Id, file: &Value, cx: &mut Context<Self>) {
        let Some(p) = self.panes.get(&pane) else {
            return;
        };
        p.update(cx, |p, _| {
            let id = strval(file, "id");
            if matches!(
                p.file_previews.entries.get(&id),
                Some(PreviewState::Loading(_))
            ) {
                return;
            }
            p.file_previews.entries.insert(id, PreviewState::Loading(0));
            p.command("preview", json!({"file":file}));
        });
    }
    pub(super) fn file_event(&mut self, remote: u64, e: Value, cx: &mut Context<Self>) {
        let Some(pane) = self
            .remote
            .get(&remote)
            .and_then(|id| self.panes.get(id))
            .cloned()
        else {
            return;
        };
        let file = strval(&e, "id");
        if !items(&pane.read(cx).files).iter().any(|f| f["id"] == file) {
            return;
        }
        match e["event"].as_str() {
            Some("fileProgress") => {
                pane.update(cx, |p, _| {
                    if let Some(PreviewState::Loading(n)) = p.file_previews.entries.get_mut(&file) {
                        *n = e["received"].as_u64().unwrap_or(0);
                    }
                });
            }
            Some("previewFailed") => {
                pane.update(cx, |p, _| {
                    p.file_previews
                        .entries
                        .insert(file, PreviewState::Failed(strval(&e, "message")));
                });
            }
            Some("preview") => {
                // Decode off the UI thread. Only a small thumbnail is retained for
                // each file row; the window holds the full image while viewing it.
                let work = cx.background_spawn(async move {
                    let bytes = STANDARD.decode(e["data"].as_str().unwrap_or(""))?;
                    let format = ImageFormat::from_mime_type(e["mime"].as_str().unwrap_or(""))
                        .ok_or_else(|| anyhow::anyhow!("Unsupported image type."))?;
                    let reader =
                        || image::ImageReader::new(Cursor::new(&bytes)).with_guessed_format();
                    let (w, h) = reader()?.into_dimensions()?;
                    anyhow::ensure!(
                        u64::from(w) * u64::from(h) <= 64 * 1024 * 1024,
                        "Image is too large to preview."
                    );
                    let thumbnail = reader()?.decode()?.thumbnail(88, 88);
                    let mut png = Cursor::new(Vec::new());
                    thumbnail.write_to(&mut png, image::ImageFormat::Png)?;
                    Ok::<_, anyhow::Error>((
                        Arc::new(Image::from_bytes(format, bytes)),
                        Arc::new(Image::from_bytes(ImageFormat::Png, png.into_inner())),
                    ))
                });
                let pane = pane.downgrade();
                cx.spawn(async move |_, cx| {
                    let result = work.await;
                    let _ = pane.update(cx, |p, cx| {
                        if !p.file_previews.entries.contains_key(&file) {
                            return;
                        }
                        match result {
                            Ok((original, thumb)) => {
                                p.file_previews
                                    .entries
                                    .insert(file.clone(), PreviewState::Ready(thumb));
                                p.file_previews.most_recent =
                                    Some((file.clone(), original.clone()));
                                cx.emit(PreviewReady {
                                    file,
                                    image: original,
                                });
                            }
                            Err(error) => {
                                p.file_previews
                                    .entries
                                    .insert(file, PreviewState::Failed(error.to_string()));
                            }
                        }
                        cx.emit(PaneChanged);
                    });
                })
                .detach();
            }
            _ => {}
        }
    }
    fn close_viewer(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.preview_id = None;
        self.preview = None;
        self.files_menu = self.tabs.get(self.current).map(|tab| tab.active);
        self.focus.focus(w, cx);
        cx.notify();
    }
    fn browse_file(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(p) = self.active() else { return };
        let files = items(&p.read(cx).files);
        if let Some(index) = files
            .iter()
            .position(|f| f["id"].as_str() == self.preview_id.as_deref())
            && files.len() > 1
        {
            let next = (index as isize + delta).rem_euclid(files.len() as isize) as usize;
            let file = files[next].clone();
            self.view_file(self.tabs[self.current].active, &file, cx);
        }
    }
    pub(super) fn file_key(
        &mut self,
        e: &KeyDownEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.preview_id.is_some() {
            match e.keystroke.key.as_str() {
                "escape" => self.close_viewer(w, cx),
                "left" => self.browse_file(-1, cx),
                "right" => self.browse_file(1, cx),
                _ => {}
            }
        } else if self.files_menu.is_some() && e.keystroke.key == "escape" {
            self.show(Page::Terminal, w, cx);
        } else {
            return false;
        }
        w.prevent_default();
        cx.stop_propagation();
        true
    }
    fn file_actions(&self, pane: Id, file: &Value, cx: &Context<Self>) -> Div {
        let save = file.clone();
        let remove = file.clone();
        row()
            .gap(px(2.))
            .child(
                action("save-file", LucideIcon::Download, "Save as…").on_click(cx.listener(
                    move |s, _, _, cx| {
                        let p = s.panes[&pane].clone();
                        let pick = cx.prompt_for_new_path(&home_dir(), save["name"].as_str());
                        let file = save.clone();
                        cx.spawn(async move |_, cx| {
                            if let Ok(Ok(Some(path))) = pick.await {
                                p.update(cx, |p, _| {
                                    p.command("saveFile", json!({"file":file,"path":path}))
                                });
                            }
                        })
                        .detach();
                    },
                )),
            )
            .child(
                action("remove-file", LucideIcon::Trash, "Remove from session").on_click(
                    cx.listener(move |s, _, w, cx| {
                        let p = s.panes[&pane].clone();
                        let file = remove.clone();
                        confirm(
                            "Remove session file?",
                            &strval(&file, "name"),
                            w,
                            cx,
                            move |_, _, cx| {
                                p.read(cx).command("deleteFile", json!({"file":file}));
                            },
                        );
                    }),
                ),
            )
    }
    pub(super) fn prefetch_thumbnail(&self, cx: &mut Context<Self>) {
        let Some(id) = self.files_menu else { return };
        let Some(pane) = self.panes.get(&id) else {
            return;
        };
        let pane = pane.read(cx);
        if pane
            .file_previews
            .entries
            .values()
            .any(|s| matches!(s, PreviewState::Loading(_)))
        {
            return;
        }
        // Warm the visible dropdown rows one at a time. Opening a different file
        // can queue behind at most one speculative read.
        if let Some(file) = items(&pane.files)
            .iter()
            .take(6)
            .find(|f| {
                supported(f)
                    && !pane
                        .file_previews
                        .entries
                        .contains_key(f["id"].as_str().unwrap_or(""))
            })
            .cloned()
        {
            self.request_preview(id, &file, cx);
        }
    }
    pub(super) fn files_dropdown(
        &self,
        id: Id,
        pane: &Pane,
        cx: &Context<Self>,
    ) -> impl IntoElement + use<> {
        let open = self.files_menu == Some(id);
        let files = items(&pane.files);
        let trigger = Button::new(("files-trigger", id))
            .outline()
            .size(ComponentSize::Sm)
            .leading_icon(LucideIcon::Files)
            .label(files.len().to_string())
            .tooltip_text("Session files")
            .bg(rgb(0x191919))
            .on_click(cx.listener(move |s, _, w, cx| {
                if s.files_menu == Some(id) {
                    s.show(Page::Terminal, w, cx);
                } else {
                    s.open_files(id, w, cx);
                }
            }));
        let badge = pane.file_previews.badge.clone();
        let pop = popover(("files-popover", id), open)
            .anchor(Anchor::TopRight)
            .trigger(
                div()
                    .w_0()
                    .flex()
                    .justify_end()
                    .child(snapshot_source(&badge, trigger.flex_none())),
            )
            .w(px(365.))
            .p(px(8.))
            .bg(rgb(0x191919))
            .on_close(cx.listener(move |s, _, w, cx| {
                if s.files_menu == Some(id)
                    && !badge
                        .bounds()
                        .is_some_and(|b| b.contains(&w.mouse_position()))
                {
                    s.show(Page::Terminal, w, cx);
                }
            }));
        if !open {
            return pop;
        }
        let header = row()
            .px(px(6.))
            .child(text("Session files", 14., TEXT).font_weight(FontWeight::SEMIBOLD))
            .child(text(files.len().to_string(), 12., MUTED))
            .child(div().flex_1())
            .child(
                action("refresh-files", LucideIcon::RefreshCw, "Refresh files").on_click(
                    cx.listener(move |s, _, _, cx| {
                        s.panes[&id].read(cx).command("files", json!({}))
                    }),
                ),
            )
            .child(
                action("close-files", LucideIcon::X, "Close files")
                    .on_click(cx.listener(|s, _, w, cx| s.show(Page::Terminal, w, cx))),
            );
        let mut rows = col().id("file-rows").max_h(px(300.)).overflow_y_scroll();
        for file in files {
            let key = strval(file, "id");
            let thumb = match pane.file_previews.entries.get(&key) {
                Some(PreviewState::Ready(thumb)) => img(thumb.clone())
                    .size(px(38.))
                    .object_fit(ObjectFit::Cover)
                    .into_any_element(),
                _ => lucide_icon(if supported(file) {
                    LucideIcon::Image
                } else {
                    LucideIcon::File
                })
                .size(px(19.))
                .into_any_element(),
            };
            let value = file.clone();
            rows = rows.child(
                row()
                    .id(SharedString::from(key))
                    .gap(px(4.))
                    .rounded(px(6.))
                    .px(px(4.))
                    .py(px(3.))
                    .hover(|d| d.bg(rgb(0x252525)))
                    .child(
                        row()
                            .id("open-file")
                            .flex_1()
                            .cursor_pointer()
                            .on_click(cx.listener(move |s, _, _, cx| s.view_file(id, &value, cx)))
                            .child(
                                div()
                                    .size(px(38.))
                                    .flex_none()
                                    .rounded(px(5.))
                                    .overflow_hidden()
                                    .flex()
                                    .justify_center()
                                    .items_center()
                                    .bg(rgb(0x252525))
                                    .child(thumb),
                            )
                            .child(
                                col()
                                    .flex_1()
                                    .child(text(strval(file, "name"), 13., TEXT).truncate())
                                    .child(text(details(file), 11., MUTED).truncate()),
                            ),
                    )
                    .child(self.file_actions(id, file, cx)),
            );
        }
        pop.child(header).child(rows).when(files.is_empty(), |p| {
            p.child(text("No session files.", 13., MUTED).p(px(12.)))
        })
    }
    pub(super) fn file_viewer(&self, cx: &Context<Self>) -> Option<AnyElement> {
        let key = self.preview_id.as_deref()?;
        let id = self.tabs.get(self.current)?.active;
        let pane = self.panes.get(&id)?.read(cx);
        let files = items(&pane.files);
        let idx = files.iter().position(|f| f["id"] == key)?;
        let file = &files[idx];
        let stage = if let Some(image) = &self.preview {
            img(image.clone())
                .size_full()
                .object_fit(ObjectFit::Contain)
                .with_fallback(|| {
                    text(
                        "Could not display this image. Use Save as… to open it locally.",
                        14.,
                        TEXT,
                    )
                    .into_any_element()
                })
                .into_any_element()
        } else if !supported(file) {
            empty_state(LucideIcon::File, "Preview not supported")
                .description("Save this file to open it locally.")
                .into_any_element()
        } else if let Some(PreviewState::Failed(reason)) = pane.file_previews.entries.get(key) {
            let file = file.clone();
            empty_state(LucideIcon::ImageOff, "Could not load preview")
                .description(reason.clone())
                .action(
                    Button::new("retry-preview")
                        .label("Retry preview")
                        .on_click(cx.listener(move |s, _, _, cx| s.view_file(id, &file, cx))),
                )
                .into_any_element()
        } else {
            let n = match pane.file_previews.entries.get(key) {
                Some(PreviewState::Loading(n)) => *n,
                _ => 0,
            };
            let size = file["size"].as_u64().unwrap_or(0);
            col()
                .w(px(220.))
                .gap(px(10.))
                .child(text(
                    if n >= size {
                        "Preparing image…"
                    } else {
                        "Loading preview…"
                    },
                    14.,
                    TEXT,
                ))
                .child(progress_bar(n as f32).max(size.max(1) as f32))
                .child(text(
                    format!("{} of {}", size_label(n), size_label(size)),
                    12.,
                    MUTED,
                ))
                .into_any_element()
        };
        Some(
            col()
                .absolute()
                .inset_0()
                .id("file-viewer")
                .occlude()
                .bg(rgb(0x101010))
                .child(
                    row()
                        .px(px(14.))
                        .when(cfg!(target_os = "macos"), |r| r.pl(px(82.)))
                        .py(px(8.))
                        .bg(rgb(0x191919))
                        .child(
                            col()
                                .flex_1()
                                .child(
                                    text(strval(file, "name"), 15., TEXT)
                                        .truncate()
                                        .font_weight(FontWeight::SEMIBOLD),
                                )
                                .child(text(details(file), 12., MUTED)),
                        )
                        .child(self.file_actions(id, file, cx))
                        .child(
                            action("close-viewer", LucideIcon::X, "Close preview (Esc)")
                                .on_click(cx.listener(|s, _, w, cx| s.close_viewer(w, cx))),
                        ),
                )
                .child(
                    row()
                        .flex_1()
                        .min_h_0()
                        .p(px(8.))
                        .child(
                            action("prev-file", LucideIcon::ChevronLeft, "Previous file (←)")
                                .disabled(files.len() < 2)
                                .on_click(cx.listener(|s, _, _, cx| s.browse_file(-1, cx))),
                        )
                        .child(
                            col()
                                .flex_1()
                                .h_full()
                                .items_center()
                                .justify_center()
                                .child(stage),
                        )
                        .child(
                            action("next-file", LucideIcon::ChevronRight, "Next file (→)")
                                .disabled(files.len() < 2)
                                .on_click(cx.listener(|s, _, _, cx| s.browse_file(1, cx))),
                        ),
                )
                .child(row().justify_center().py(px(8.)).child(text(
                    format!("{} / {}", idx + 1, files.len()),
                    12.,
                    MUTED,
                )))
                .into_any_element(),
        )
    }
}
pub(crate) struct PreviewReady {
    pub file: String,
    pub image: Arc<Image>,
}
impl gpui::EventEmitter<PreviewReady> for Pane {}

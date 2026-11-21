use gpui::{App, IntoElement, RenderOnce, SharedString, Styled, Window, px, svg};
use serde::Deserialize;
use std::{collections::HashMap, sync::LazyLock};

/// Monochrome marks share their paths and even-odd fill with the web ToolIcon.
pub struct AgentMark {
    cache_key: SharedString,
    svg: String,
}

impl AgentMark {
    pub fn get(tool: Option<&str>) -> Option<&'static Self> {
        static MARKS: LazyLock<HashMap<String, AgentMark>> = LazyLock::new(|| {
            #[derive(Deserialize)]
            struct Mark {
                paths: Vec<String>,
            }
            let marks: HashMap<String, Mark> =
                serde_json::from_str(include_str!("../../shared/harnessMarks.json"))
                    .expect("valid bundled agent marks");
            marks.into_iter().map(|(id, mark)| {
                let paths: String = mark.paths.iter().map(|d| format!(r#"<path d="{d}"/>"#)).collect();
                let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill-rule="evenodd">{paths}</svg>"#);
                let cache_key = format!("outpost/agent/{id}").into();
                (id, AgentMark { cache_key, svg })
            }).collect()
        });
        MARKS.get(tool?)
    }

    pub fn icon(&'static self, size: f32) -> impl IntoElement + use<> {
        AgentIcon { mark: self, size }
    }
}

#[derive(IntoElement)]
struct AgentIcon {
    mark: &'static AgentMark,
    size: f32,
}

impl RenderOnce for AgentIcon {
    fn render(self, window: &mut Window, _: &mut App) -> impl IntoElement {
        svg()
            .static_data(self.mark.cache_key.clone(), self.mark.svg.as_bytes())
            .size(px(self.size))
            .flex_none()
            .text_color(window.text_style().color)
    }
}

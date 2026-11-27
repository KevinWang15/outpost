use std::path::PathBuf;

fn main() -> anyhow::Result<()> {
    let dir = std::env::var_os("OUTPOST_ONBOARDING_SCREENSHOTS")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/onboarding"));
    outpost_desktop::capture_onboarding_screenshots(&dir)
}

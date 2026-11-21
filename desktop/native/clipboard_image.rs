use anyhow::{Context, Result, ensure};
use gpui::{ClipboardEntry, ClipboardItem, ImageFormat};
use std::{
    borrow::Cow,
    io::{Cursor, Read},
};

const MAX_UPLOAD: usize = 16 << 20;
// Uncompressed clipboard bitmaps can be considerably larger than their PNG.
const MAX_BITMAP: usize = 128 << 20;

type ClipboardImage<'a> = (&'static str, Cow<'a, [u8]>);

fn normalize(format: ImageFormat, bytes: Cow<'_, [u8]>) -> Result<ClipboardImage<'_>> {
    let (mime, data) = match format {
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::Webp => {
            (format.mime_type(), bytes)
        }
        ImageFormat::Tiff | ImageFormat::Bmp => {
            ensure!(bytes.len() <= MAX_BITMAP, "Clipboard bitmap is too large.");
            let format = if format == ImageFormat::Tiff {
                image::ImageFormat::Tiff
            } else {
                image::ImageFormat::Bmp
            };
            let reader = || image::ImageReader::with_format(Cursor::new(bytes.as_ref()), format);
            let (w, h) = reader().into_dimensions()?;
            ensure!(
                u64::from(w) * u64::from(h) <= 32 * 1024 * 1024,
                "Clipboard bitmap dimensions are too large."
            );
            let bitmap = reader()
                .decode()
                .context("Could not decode clipboard image")?;
            let mut png = Cursor::new(Vec::new());
            bitmap.write_to(&mut png, image::ImageFormat::Png)?;
            ("image/png", Cow::Owned(png.into_inner()))
        }
        _ => anyhow::bail!("Paste a PNG, JPEG, GIF, WebP, TIFF or BMP image."),
    };
    ensure!(
        !data.is_empty() && data.len() <= MAX_UPLOAD,
        "Images must be between 1 byte and 16 MiB."
    );
    Ok((mime, data))
}

pub fn read(item: &ClipboardItem) -> Result<Option<ClipboardImage<'_>>> {
    for entry in item.entries() {
        match entry {
            ClipboardEntry::Image(image) => {
                return normalize(image.format, Cow::Borrowed(&image.bytes)).map(Some);
            }
            ClipboardEntry::ExternalPaths(paths) => {
                let [path] = paths.0.as_slice() else {
                    return Ok(None);
                };
                let Some(ext) = path.extension().and_then(|ext| ext.to_str()) else {
                    return Ok(None);
                };
                let format = match ext.to_ascii_lowercase().as_str() {
                    "png" => ImageFormat::Png,
                    "jpg" | "jpeg" => ImageFormat::Jpeg,
                    "gif" => ImageFormat::Gif,
                    "webp" => ImageFormat::Webp,
                    "bmp" => ImageFormat::Bmp,
                    "tif" | "tiff" => ImageFormat::Tiff,
                    _ => return Ok(None),
                };
                ensure!(path.is_file(), "The copied image must be a regular file.");
                let cap = if matches!(format, ImageFormat::Tiff | ImageFormat::Bmp) {
                    MAX_BITMAP
                } else {
                    MAX_UPLOAD
                };
                let mut bytes = Vec::new();
                std::fs::File::open(path)?
                    .take(cap as u64 + 1)
                    .read_to_end(&mut bytes)?;
                return normalize(format, Cow::Owned(bytes)).map(Some);
            }
            _ => {}
        }
    }
    // AppKit can advertise both text and image data. GPUI's general-purpose
    // clipboard reader chooses text first; the terminal prefers the image.
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::NSPasteboard;
        use objc2_foundation::NSString;
        let board = NSPasteboard::generalPasteboard();
        for (uti, format) in [
            ("public.png", ImageFormat::Png),
            ("public.jpeg", ImageFormat::Jpeg),
            ("com.compuserve.gif", ImageFormat::Gif),
            ("org.webmproject.webp", ImageFormat::Webp),
            ("public.tiff", ImageFormat::Tiff),
        ] {
            if let Some(data) = board.dataForType(&NSString::from_str(uti)) {
                ensure!(data.length() <= MAX_BITMAP, "Clipboard image is too large.");
                return normalize(format, Cow::Owned(data.to_vec())).map(Some);
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiff_pastes_as_png_with_the_same_pixels() {
        let original = image::RgbaImage::from_pixel(11, 7, image::Rgba([12, 34, 56, 255]));
        let mut tiff = Cursor::new(Vec::new());
        original
            .write_to(&mut tiff, image::ImageFormat::Tiff)
            .unwrap();
        let (mime, png) = normalize(ImageFormat::Tiff, Cow::Owned(tiff.into_inner())).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(image::load_from_memory(&png).unwrap().to_rgba8(), original);
    }
}

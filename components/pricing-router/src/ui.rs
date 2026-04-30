// ui.rs — serves the SPA bundled at compile time via include_dir!.
//
// All assets live under ../../../ui (i.e. <repo>/ui). To mirror them into the
// component, the build is run from this crate's directory and include_dir
// resolves paths relative to the crate root (CARGO_MANIFEST_DIR).
//
// We serve "/" -> /ui/index.html, otherwise mirror the path under /ui.

use include_dir::{include_dir, Dir};

static UI: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../ui");

pub fn serve(path: &str) -> (u16, &'static str, Vec<u8>) {
    let lookup = match path {
        "/" | "/index.html" => "index.html",
        p if p.starts_with('/') => &p[1..],
        p => p,
    };

    if let Some(file) = UI.get_file(lookup) {
        let ct = content_type_for(lookup);
        // Box::leak gives us a 'static reference, but here we own the bytes
        // already and return Vec<u8>. content_type can be a static string.
        return (200, ct, file.contents().to_vec());
    }

    (
        404,
        "text/plain; charset=utf-8",
        format!("not found: {path}\n").into_bytes(),
    )
}

fn content_type_for(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".html") { "text/html; charset=utf-8" }
    else if lower.ends_with(".css") { "text/css; charset=utf-8" }
    else if lower.ends_with(".js") || lower.ends_with(".mjs") { "application/javascript; charset=utf-8" }
    else if lower.ends_with(".svg") { "image/svg+xml; charset=utf-8" }
    else if lower.ends_with(".json") { "application/json; charset=utf-8" }
    else if lower.ends_with(".png") { "image/png" }
    else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
    else if lower.ends_with(".woff2") { "font/woff2" }
    else { "application/octet-stream" }
}

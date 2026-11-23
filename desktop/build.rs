fn main() {
    println!("cargo:rerun-if-changed=packaging/outpost.rc");
    println!("cargo:rerun-if-changed=packaging/outpost.ico");
    embed_resource::compile_for(
        "packaging/outpost.rc",
        ["outpost"],
        embed_resource::ParamsIncludeDirs(["packaging"]),
    )
    .manifest_required()
    .expect("embed the Outpost executable icon");
}

fn main() {
    tauri_build::build();

    #[cfg(target_os = "macos")]
    link_apple_compiler_runtime();
}

#[cfg(target_os = "macos")]
fn link_apple_compiler_runtime() {
    use std::path::PathBuf;
    use std::process::Command;

    // whisper.cpp's Metal backend uses Apple's availability checks. Xcode 26
    // emits those checks through compiler-rt, while rustc does not add that
    // archive automatically when it performs the final application link.
    let output = Command::new("xcrun")
        .args(["clang", "-print-resource-dir"])
        .output()
        .expect("Xcode command line tools are required to build Akflix");
    assert!(
        output.status.success(),
        "Could not locate Apple's compiler runtime"
    );
    let resource_dir = String::from_utf8(output.stdout)
        .expect("Apple's compiler resource path must be UTF-8")
        .trim()
        .to_string();
    let runtime = PathBuf::from(resource_dir)
        .join("lib/darwin/libclang_rt.osx.a");
    assert!(
        runtime.is_file(),
        "Apple's compiler runtime is missing at {}",
        runtime.display()
    );
    println!("cargo:rustc-link-arg={}", runtime.display());
}

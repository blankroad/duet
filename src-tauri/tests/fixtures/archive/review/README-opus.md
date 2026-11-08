# archive-opus ZIP fixtures

Made with macOS `/usr/bin/zip` (Info-ZIP 3.0), password `s3cret`:

```sh
zip -P s3cret opus-zipcrypto.zip secret.txt          # secret.txt = 200 lines "line N of the secret document"
zip opus-mixed.zip plain.txt                         # plain.txt = "plain readme\n" (stored, not encrypted)
zip -P s3cret opus-mixed.zip secret.txt              # adds a ZipCrypto (deflated) entry
```

The `zip` crate cannot write ZipCrypto (`with_deprecated_encryption` is `pub(crate)` in 2.4.2),
so these are checked in. Used by `src-tauri/src/core/archive_review_opus.rs`.

# archive-sol ZIP fixtures

Generated with Python 3.15.0 stdlib, from the archive worktree:

```sh
python3 src-tauri/tests/fixtures/archive/review/generate_sol.py
```

`sol-bzip2.zip`, `sol-lzma.zip`, `sol-zstd.zip` contain valid compressed hello.txt.
`sol-xz-method-only.zip` and `sol-ppmd-method-only.zip` only patch method IDs on a stored ZIP; they test unsupported-method dispatch, not codec correctness.
`sol-cp949.zip` and `sol-sjis.zip` have legacy filename bytes with UTF-8 flag clear.
`sol-unicode-extra.zip` adds a valid Info-ZIP 0x7075 Unicode Path extra field.

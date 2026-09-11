# archive fixtures

`core::archive` 단위 테스트용 소형 아카이브. macOS 에서 CLI 로 생성했다(2026-09).

| 파일 | 내용 | 생성 |
|---|---|---|
| `sample.tar.{bz2,xz,zst}` | `a.txt`(`"alpha\n"` ×400), `sub/b.txt`(`beta`) | `COPYFILE_DISABLE=1 tar --format=ustar -cf sample.tar -C src a.txt sub` 후 `bzip2 -c` / `xz -c` / `zstd -c` |
| `two.txt.{gz,bz2,xz,zst}` | `first\n`·`second\n` 을 **따로 압축해 이어 붙임** (멤버·스트림·프레임 2개) | `{ printf 'first\n' \| gzip -c; printf 'second\n' \| gzip -c; } > two.txt.gz` (bzip2/xz/zstd 동일) |
| `d64.zip` | `a.txt`(Deflate64), `sub/b.txt` | `7zz a -tzip -mm=Deflate64 d64.zip a.txt sub` |

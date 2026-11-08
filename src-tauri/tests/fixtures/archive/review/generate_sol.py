"""Small ZIP fixtures, generated with Python 3.15 stdlib only."""
from pathlib import Path
import zipfile, struct, zlib
root = Path(__file__).parent
for label, method in [('bzip2', zipfile.ZIP_BZIP2), ('lzma', zipfile.ZIP_LZMA), ('zstd', zipfile.ZIP_ZSTANDARD)]:
    with zipfile.ZipFile(root / f'sol-{label}.zip', 'w', compression=method) as z:
        z.writestr('hello.txt', b'hello archive review\n')
with zipfile.ZipFile(root / 'sol-stored.zip', 'w') as z:
    z.writestr('hello.txt', b'hello archive review\n')
for label, method in [('xz',95), ('ppmd',98)]:
    data = bytearray((root/'sol-stored.zip').read_bytes())
    struct.pack_into('<H', data, 8, method)
    struct.pack_into('<H', data, data.index(b'PK\x01\x02')+10, method)
    (root/f'sol-{label}-method-only.zip').write_bytes(data)
class LegacyInfo(zipfile.ZipInfo):
    encoding = 'cp949'
    def _encodeFilenameFlags(self):
        return self.filename.encode(self.encoding), self.flag_bits & ~0x800
for label, enc, names, extra in [
    ('cp949', 'cp949', ['한글.txt','폴더/문서.txt'], False),
    ('sjis', 'cp932', ['日本語.txt'], False),
    ('unicode-extra', 'cp949', ['한글.txt'], True),
]:
    with zipfile.ZipFile(root/f'sol-{label}.zip', 'w') as z:
        for name in names:
            i=LegacyInfo(name); i.encoding=enc
            if extra:
                payload = b'\x01' + struct.pack('<I', zlib.crc32(name.encode(enc))) + name.encode('utf-8')
                i.extra=struct.pack('<HH',0x7075,len(payload))+payload
            z.writestr(i, b'legacy filename\n')

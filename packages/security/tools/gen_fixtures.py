"""Regenerates fixtures/*.pdf with qpdf (via pikepdf): an independent producer for encryption tests.

Usage: python tools/gen_fixtures.py <base.pdf> <out_dir>
"""
import sys
import pikepdf

base, out = sys.argv[1], sys.argv[2]
cases = {
    # name: (R, aes, object streams)
    "rc4-40":      (2, False, False),
    "rc4-128":     (3, False, False),
    "aes-128":     (4, True,  False),
    "aes-128-objstm": (4, True, True),
    "aes-256":     (6, True,  False),
    "aes-256-objstm": (6, True, True),
}
for name, (r, aes, objstm) in cases.items():
    with pikepdf.open(base) as pdf:
        enc = pikepdf.Encryption(user="user-pw", owner="owner-pw", R=r, aes=aes,
                                 allow=pikepdf.Permissions(extract=False, modify_annotation=False, print_lowres=True, print_highres=False), metadata=(r >= 4))
        mode = pikepdf.ObjectStreamMode.generate if objstm else pikepdf.ObjectStreamMode.disable
        pdf.save(f"{out}/{name}.pdf", encryption=enc, object_stream_mode=mode, compress_streams=True)
print("ok")

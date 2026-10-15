"""Independent checks with qpdf (pikepdf). Usage: python tools/check_pdf.py <file> [password]  -> JSON on stdout."""
import io
import json
import sys

import pikepdf

path = sys.argv[1]
pw = sys.argv[2] if len(sys.argv) > 2 else ""
out = {}
try:
    with pikepdf.open(path, password=pw) as pdf:
        out["pages"] = len(pdf.pages)
        out["encrypted"] = pdf.is_encrypted
        if pdf.is_encrypted:
            e = pdf.encryption
            out["R"] = e.R
            out["bits"] = e.bits
            out["P"] = e.P
            a = pdf.allow
            out["allow"] = {
                "extract": a.extract,
                "modify_annotation": a.modify_annotation,
                "print_lowres": a.print_lowres,
                "print_highres": a.print_highres,
                "modify_other": a.modify_other,
            }
        # qpdf re-reads and re-writes every object; any structural damage raises here
        pdf.save(io.BytesIO())
        out["problems"] = []
except pikepdf.PasswordError:
    out["error"] = "password"
except Exception as ex:  # noqa: BLE001
    out["error"] = f"{type(ex).__name__}: {ex}"
print(json.dumps(out))

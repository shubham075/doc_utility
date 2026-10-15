"""Independent signature validation with pyHanko. Usage: python tools/validate_sig.py <pdf> <trusted-cert.pem> -> JSON list."""
import json
import sys

from pyhanko.keys import load_cert_from_pemder
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

path, cert_path = sys.argv[1], sys.argv[2]
root = load_cert_from_pemder(cert_path)
out = []
with open(path, "rb") as f:
    reader = PdfFileReader(f)
    for sig in reader.embedded_signatures:
        entry = {"field": sig.field_name}
        try:
            status = validate_pdf_signature(sig, ValidationContext(trust_roots=[root], allow_fetching=False))
            entry.update(
                intact=bool(status.intact),
                valid=bool(status.valid),
                trusted=bool(status.trusted),
                coverage=str(status.coverage),
                modification_level=str(status.modification_level),
                signer=str(status.signing_cert.subject.human_friendly),
            )
        except Exception as ex:  # noqa: BLE001
            entry["error"] = f"{type(ex).__name__}: {ex}"
        out.append(entry)
print(json.dumps(out))

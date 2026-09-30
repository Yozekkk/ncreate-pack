import importlib.util
import io
from pathlib import Path
import unittest
import zipfile


IMPORTER = Path(__file__).resolve().parents[1] / "scripts" / "import-pack.py"
spec = importlib.util.spec_from_file_location("ncreate_pack_importer", IMPORTER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def server_zip(*addresses: str) -> zipfile.ZipFile:
    payload = bytearray()
    for address in addresses:
        encoded = address.encode()
        payload.extend(b"\x08\x00\x02ip")
        payload.extend(len(encoded).to_bytes(2, "big"))
        payload.extend(encoded)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("minecraft/servers.dat", payload)
    output.seek(0)
    return zipfile.ZipFile(output)


class ReviewedServersTest(unittest.TestCase):
    def test_uses_explicit_port_from_original_ncreate_entries(self):
        with server_zip("play.ncreate.online", "play.ncreate.online:25076") as archive:
            self.assertEqual(module.reviewed_servers(archive), [
                {"name": "NCreate", "address": "play.ncreate.online:25076"}
            ])

    def test_ignores_unrelated_or_deceptive_addresses(self):
        with server_zip("private.example:25565", "play.ncreate.online.evil.example") as archive:
            self.assertEqual(module.reviewed_servers(archive), [])


if __name__ == "__main__":
    unittest.main()

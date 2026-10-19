"""Read-only byte/metadata/orientation check; no model inference."""

import base64
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path


manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
bucket = sys.argv[2]
counts = Counter()
bad = []
for item in manifest["sets"][bucket]["selected"]:
    try:
        data = Path(item["pixelPath"]).read_bytes()
        metadata = item["metadata"]
        matches = len(data) == int(metadata["OriginalSize"]) and base64.b64encode(hashlib.md5(data).digest()).decode("ascii") == metadata["OriginalMD5"]
        counts["md5_size_match" if matches else "md5_size_mismatch"] += 1
        counts[f"rotation_{metadata['Rotation'].strip()}"] += 1
        if not matches:
            bad.append(item["id"])
    except (OSError, KeyError, ValueError) as error:
        counts["error"] += 1
        bad.append({"id": item["id"], "reason": str(error)})
print(json.dumps({"set": bucket, "selected": len(manifest["sets"][bucket]["selected"]), "counts": counts, "bad": bad}, indent=2))

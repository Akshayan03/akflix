#!/usr/bin/env python3
"""Writes the Firebase web config into all three Akflix apps at once.

    python3 -I cloud/apply-config.py < config.txt        (or paste, then Ctrl-D)
    python3 -I cloud/apply-config.py config.txt

Accepts the console's `const firebaseConfig = {...}` snippet as-is. Only apiKey and projectId are required.
Updates (sibling checkouts of this repo):
  akflixmac/src/lib/cloud/firebaseConfig.ts
  akflixios/src/lib/cloud/firebaseConfig.ts
  akflix-roku/components/lib/AkflixCloudConfig.brs
Then rebuild the apps. (The Mac and iPhone apps can also take the snippet in Settings -> Akflix account without a
rebuild; the Roku needs this file.)
"""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
MAC = HERE.parent
PROJECTS = MAC.parent


def pick(text, name):
    match = re.search(r"[\"']?%s[\"']?\s*[:=]\s*[\"']([^\"']+)[\"']" % name, text)
    return match.group(1).strip() if match else ""


def main():
    text = open(sys.argv[1]).read() if len(sys.argv) > 1 else sys.stdin.read()
    config = {name: pick(text, name) for name in ("apiKey", "authDomain", "projectId", "appId")}
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", config["apiKey"]) or not re.fullmatch(r"[a-z0-9-]{4,40}", config["projectId"]):
        sys.exit("That doesn't look like a Firebase web config (need apiKey and projectId).")

    ts_targets = [MAC / "src/lib/cloud/firebaseConfig.ts", PROJECTS / "akflixios/src/lib/cloud/firebaseConfig.ts"]
    for path in ts_targets:
        if not path.exists():
            print("skip (not found):", path)
            continue
        source = path.read_text()
        for name, value in config.items():
            source = re.sub(r'(\n  %s: )"[^"]*"' % name, lambda m: '%s"%s"' % (m.group(1), value), source, count=1)
        path.write_text(source)
        print("updated", path)

    roku = PROJECTS / "akflix-roku/components/lib/AkflixCloudConfig.brs"
    if roku.exists():
        source = roku.read_text()
        for name in ("apiKey", "projectId"):
            source = re.sub(r'(\n        %s: )"[^"]*"' % name, lambda m: '%s"%s"' % (m.group(1), config[name]), source, count=1)
        roku.write_text(source)
        print("updated", roku)
    else:
        print("skip (not found):", roku)
    print("Project:", config["projectId"], "- now rebuild the apps.")


if __name__ == "__main__":
    main()

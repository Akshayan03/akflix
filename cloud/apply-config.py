#!/usr/bin/env python3
"""Builds the Akflix account config into the Mac, iPhone and Roku apps (outside git).

    python3 -I cloud/apply-config.py [FOLDER | WEB_CONFIG_FILE]

Reads, from FOLDER (default: the akflix-signin lane folder below):
  firebase-web-config.json   the web app config from the Firebase console; the console's
                             `const firebaseConfig = {...}` snippet works as-is, so does JSON
  GoogleService-Info.plist   the iPhone app file (its CLIENT_ID is Google sign-in on the iPhone),
  or oauth-clients.json      {"iosClientId": "....apps.googleusercontent.com"}
Writes (all ignored by git):
  akflixmac/.env.local, akflixios/.env.local    VITE_AKFLIX_FIREBASE_* and VITE_AKFLIX_GOOGLE_IOS_CLIENT_ID
  akflix-roku/.cloud-config.json                apiKey + projectId, baked into the zip by package.sh
Then rebuild the apps. Nothing here is a secret (the values name the project; Firestore rules decide who
reads what), but they stay out of the repositories.
"""
import json
import pathlib
import plistlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
MAC = HERE.parent
PROJECTS = MAC.parent
DEFAULT_FOLDER = pathlib.Path("/Volumes/Akflix 5/BuildCache/akflix-signin-20261019")
ENV_KEYS = {
    "apiKey": "VITE_AKFLIX_FIREBASE_API_KEY",
    "authDomain": "VITE_AKFLIX_FIREBASE_AUTH_DOMAIN",
    "projectId": "VITE_AKFLIX_FIREBASE_PROJECT_ID",
    "appId": "VITE_AKFLIX_FIREBASE_APP_ID",
}
CLIENT_KEY = "VITE_AKFLIX_GOOGLE_IOS_CLIENT_ID"


def pick(text, name):
    match = re.search(r"[\"']?%s[\"']?\s*[:=]\s*[\"']([^\"']+)[\"']" % name, text)
    return match.group(1).strip() if match else ""


def web_config(path):
    text = path.read_text()
    config = {name: pick(text, name) for name in ENV_KEYS}
    if not re.fullmatch(r"[A-Za-z0-9_-]{20,}", config["apiKey"]) or not re.fullmatch(r"[a-z0-9-]{4,40}", config["projectId"]):
        sys.exit("%s doesn't look like a Firebase web config (need apiKey and projectId)." % path)
    if not config["authDomain"]:
        config["authDomain"] = config["projectId"] + ".firebaseapp.com"
    return config


def ios_client_id(folder):
    plist = folder / "GoogleService-Info.plist"
    if plist.exists():
        with plist.open("rb") as handle:
            value = plistlib.load(handle)
        if value.get("BUNDLE_ID") not in (None, "com.akshayan.akflix"):
            sys.exit("GoogleService-Info.plist is for %s, not com.akshayan.akflix." % value.get("BUNDLE_ID"))
        if value.get("CLIENT_ID"):
            return value["CLIENT_ID"].strip()
        print("note: GoogleService-Info.plist has no CLIENT_ID yet (download it again after turning Google on)")
    clients = folder / "oauth-clients.json"
    if clients.exists():
        return str(json.loads(clients.read_text()).get("iosClientId", "")).strip()
    return ""


def write_env(path, values):
    lines = path.read_text().splitlines() if path.exists() else []
    kept = [line for line in lines if line.split("=", 1)[0].strip() not in values]
    kept += ["%s=%s" % (key, value) for key, value in values.items()]
    path.write_text("\n".join(kept) + "\n")
    print("wrote", path)


def main():
    arg = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FOLDER
    folder, web = (arg, arg / "firebase-web-config.json") if arg.is_dir() else (arg.parent, arg)
    if not web.exists():
        sys.exit("No web config yet: %s" % web)
    config = web_config(web)
    client = ios_client_id(folder)
    if client and not re.fullmatch(r"[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com", client):
        sys.exit("The iPhone client ID doesn't look right: %s" % client)

    values = {ENV_KEYS[name]: config[name] for name in ENV_KEYS}
    values[CLIENT_KEY] = client
    for repo in ("akflixmac", "akflixios"):
        root = PROJECTS / repo
        if root.exists():
            write_env(root / ".env.local", values)
        else:
            print("skip (not found):", root)
    roku = PROJECTS / "akflix-roku"
    if roku.exists():
        (roku / ".cloud-config.json").write_text(json.dumps({"apiKey": config["apiKey"], "projectId": config["projectId"]}) + "\n")
        print("wrote", roku / ".cloud-config.json")
    print("Project:", config["projectId"], "| Google on iPhone:", "yes" if client else "not yet (no CLIENT_ID)")
    print("Now rebuild the apps (Roku: sh package.sh).")


if __name__ == "__main__":
    main()

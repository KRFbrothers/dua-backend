#!/usr/bin/env python3
"""Run in authenticated Cloud Shell; prepare a stopped worker without logging secrets."""
import base64
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
from urllib.parse import urlparse

PROJECT = "global-healer-m6shk"
REGION = "us-central1"
ZONE = "us-central1-a"
INSTANCE = "dua-workflow-worker"
SUPABASE_HOST = "gmjzshgzdaizfximuhsf.supabase.co"
KEY_SECRET = "DUA_WORKFLOW_CREDENTIAL_KEY"


class SetupError(Exception):
    pass


def gcloud(*args, input_text=None, capture=True):
    result = subprocess.run(
        ["gcloud", *args, "--project=" + PROJECT, "--quiet"],
        input=input_text, text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode:
        # Secret values and raw HTTP diagnostics never enter error output.
        raise SetupError("Cloud command failed: " + " ".join(args[:3]))
    return result.stdout.strip() if capture else ""


def revision_env(service):
    revision = gcloud("run", "services", "describe", service,
                      "--region=" + REGION,
                      "--format=value(status.latestReadyRevisionName)")
    if not revision:
        raise SetupError("No ready revision for " + service)
    data = json.loads(gcloud("run", "revisions", "describe", revision,
                             "--region=" + REGION, "--format=json"))
    containers = data.get("spec", {}).get("containers", [])
    if len(containers) != 1:
        raise SetupError("Expected one container for " + service)
    return {entry["name"]: entry for entry in containers[0].get("env", [])}


def setting(env, name, required=False):
    entry = env.get(name)
    if entry is None:
        if required:
            raise SetupError("Required live setting is absent: " + name)
        return None
    if "value" in entry:
        return str(entry["value"])
    ref = entry.get("valueFrom", {}).get("secretKeyRef", {})
    secret_name, version = ref.get("name", ""), ref.get("key", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", secret_name) or not re.fullmatch(r"[0-9]+|latest", version):
        raise SetupError("Unsupported secret reference for " + name)
    return gcloud("secrets", "versions", "access", version, "--secret=" + secret_name)


def encryption_key():
    # Do not rotate an existing worker key or replace a disabled version.
    existing = gcloud("secrets", "list", "--format=value(name)")
    names = {name.rsplit("/", 1)[-1] for name in existing.splitlines()}
    if KEY_SECRET in names:
        version = gcloud("secrets", "versions", "list", KEY_SECRET,
                         "--filter=state=ENABLED", "--sort-by=~createTime",
                         "--limit=1", "--format=value(name)").rsplit("/", 1)[-1]
        if not version.isdigit():
            raise SetupError("The worker key has no enabled secret version")
        key = gcloud("secrets", "versions", "access", version, "--secret=" + KEY_SECRET)
    else:
        key = base64.b64encode(secrets.token_bytes(32)).decode("ascii")
        gcloud("secrets", "create", KEY_SECRET, "--replication-policy=automatic",
               "--data-file=-", input_text=key)
    try:
        if len(base64.b64decode(key, validate=True)) != 32:
            raise ValueError()
    except ValueError:
        raise SetupError("Invalid worker encryption key; no replacement was made") from None
    return key


def ssh(command):
    # SSH may ask for the existing key passphrase using the terminal.
    return gcloud("compute", "ssh", INSTANCE, "--zone=" + ZONE,
                  "--tunnel-through-iap", "--command=" + command, capture=False)


def main():
    if os.uname().nodename.split(".")[0] == INSTANCE:
        raise SetupError("Exit the worker SSH session and run this in Cloud Shell")
    ssh("if sudo systemctl is-active --quiet dua-workflow-worker; then "
        "echo 'Worker is active; refusing configuration replacement.'; exit 1; fi; "
        "sudo grep -Eq '^DUA_WORKFLOW_CREDENTIAL_KEY=(\"\"|)$' /etc/dua/workflow-worker.env || "
        "{ echo 'Existing worker credentials found; refusing replacement.'; exit 1; }")

    api, engine = revision_env("dua-api"), revision_env("dua-ai-engine")
    config = {name: setting(api, name, required=True) for name in (
        "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "DUA_ALLOWED_EMAIL")}
    origin = urlparse(config["SUPABASE_URL"])
    if origin.scheme != "https" or origin.hostname != SUPABASE_HOST or origin.username or origin.password:
        raise SetupError("Live Supabase target differs from the approved project")
    owner = config["DUA_ALLOWED_EMAIL"].strip().lower()
    engine_owner = setting(engine, "DUA_ALLOWED_EMAIL", required=True).strip().lower()
    if not owner or owner != engine_owner:
        raise SetupError("API and engine owner settings do not match")

    engine_url = gcloud("run", "services", "describe", "dua-ai-engine",
                        "--region=" + REGION, "--format=value(status.url)")
    target = urlparse(engine_url)
    if target.scheme != "https" or not target.hostname or target.path not in ("", "/"):
        raise SetupError("Invalid live engine origin")
    config["DUA_ENGINE_URL"] = engine_url
    app_token = setting(engine, "DUA_APP_TOKEN")
    if app_token is not None:
        config["DUA_APP_TOKEN"] = app_token
    for name in api:
        if name in ("DUA_DAILY_REQUEST_LIMIT", "DUA_MINUTE_REQUEST_LIMIT", "DUA_MAINTENANCE",
                    "DUA_MAINTENANCE_MESSAGE", "DUA_DISABLE_AGENT"):
            config[name] = setting(api, name)

    config.update(DUA_WORKFLOW_OWNER_ID="", DUA_WORKFLOW_CREDENTIAL_KEY=encryption_key(),
                  DUA_WORKFLOWS_ENABLED="0", DUA_WORKFLOW_AUTOMATION_ENABLED="0", DUA_REQUIRE_LOGIN="1")
    if any(not isinstance(value, str) or any(c in value for c in "\r\n\0") for value in config.values()):
        raise SetupError("A setting cannot be represented safely in the environment file")
    pending = "dua-worker-env-" + secrets.token_hex(8) + ".pending"
    with tempfile.TemporaryDirectory(prefix="dua-worker-config-") as directory:
        path = Path(directory) / "worker.env"
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            for name, value in config.items():
                output.write(name + "=" + json.dumps(value, ensure_ascii=False) + "\n")
        gcloud("compute", "scp", str(path), INSTANCE + ":" + pending,
               "--zone=" + ZONE, "--tunnel-through-iap", capture=False)
        try:
            ssh("sudo install -m 0600 -o root -g root " + pending +
                " /etc/dua/workflow-worker.env && "
                "sudo stat -c '%a %U:%G %n' /etc/dua/workflow-worker.env")
        finally:
            ssh("rm -f -- " + pending)
    print("Worker config installed. Secret values were not printed.")
    print("Encryption key backed up in Secret Manager. Owner session is not provisioned; worker remains stopped.")


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print(str(error), file=sys.stderr)
        print("Worker remains stopped. Do not print its environment file.", file=sys.stderr)
        sys.exit(1)
    except (ValueError, KeyError, OSError):
        print("Worker configuration did not complete. Do not start the service or print its environment file.", file=sys.stderr)
        sys.exit(1)

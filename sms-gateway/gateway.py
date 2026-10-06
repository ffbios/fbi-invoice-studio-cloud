#!/usr/bin/env python3
"""
FBI Private SMS Gateway
Connects Invoice Studio Cloud to a GSM phone/modem through Gammu.

This program:
1. Checks your GSM modem.
2. Heartbeats to Invoice Studio.
3. Pulls one queued SMS at a time.
4. Sends it through the local SIM using Gammu.
5. Reports the result back to Invoice Studio.

No third-party SMS API is used.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SERVER_URL = os.getenv("FBI_SMS_SERVER_URL", "https://invoice.fbigh.com").rstrip("/")
GATEWAY_TOKEN = os.getenv("FBI_SMS_GATEWAY_TOKEN", "").strip()
GATEWAY_ID = os.getenv("FBI_SMS_GATEWAY_ID", "fbi-private-gateway-1").strip() or "fbi-private-gateway-1"
GATEWAY_NAME = os.getenv("FBI_SMS_GATEWAY_NAME", "FBI Private SMS Gateway").strip() or "FBI Private SMS Gateway"
SIM_LINE = os.getenv("FBI_SMS_SIM_LINE", "Private SIM line").strip() or "Private SIM line"
PORT_LABEL = os.getenv("FBI_SMS_PORT", "").strip()
GAMMU_BIN = os.getenv("GAMMU_BIN", "gammu").strip() or "gammu"
GAMMU_CONFIG = os.getenv("GAMMU_CONFIG", "").strip()
POLL_SECONDS = max(1, float(os.getenv("FBI_SMS_POLL_SECONDS", "2")))
HEARTBEAT_SECONDS = max(5, float(os.getenv("FBI_SMS_HEARTBEAT_SECONDS", "15")))
MODEM_CHECK_SECONDS = max(15, float(os.getenv("FBI_SMS_MODEM_CHECK_SECONDS", "45")))
COMMAND_TIMEOUT = max(20, int(os.getenv("FBI_SMS_COMMAND_TIMEOUT", "120")))

if not GATEWAY_TOKEN:
    print("ERROR: FBI_SMS_GATEWAY_TOKEN is required.", file=sys.stderr)
    sys.exit(2)

def gammu_command(*args):
    cmd = [GAMMU_BIN]
    if GAMMU_CONFIG:
        cmd += ["-c", GAMMU_CONFIG]
    cmd += list(args)
    return cmd

def api_request(path, method="GET", payload=None):
    url = SERVER_URL + path
    data = None
    headers = {
        "Accept": "application/json",
        "X-FBI-SMS-Gateway-Token": GATEWAY_TOKEN,
        "User-Agent": "FBI-Private-SMS-Gateway/1.0",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = {"error": body or str(exc)}
        return exc.code, parsed
    except Exception as exc:
        return 0, {"error": str(exc)}

def check_modem():
    try:
        p = subprocess.run(
            gammu_command("identify"),
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        detail = (p.stdout or p.stderr or "").strip().replace("\r", " ")
        if p.returncode == 0:
            first = " ".join(detail.splitlines()[:3])
            return True, first[:450]
        return False, detail[-450:] or "Gammu could not identify the modem."
    except FileNotFoundError:
        return False, f"Gammu executable not found: {GAMMU_BIN}"
    except Exception as exc:
        return False, str(exc)[:450]

def heartbeat(modem_ok, detail):
    payload = {
        "gatewayId": GATEWAY_ID,
        "gatewayName": GATEWAY_NAME,
        "simLine": SIM_LINE,
        "portLabel": PORT_LABEL,
        "modemStatus": "online" if modem_ok else "offline",
        "detail": detail,
    }
    return api_request("/api/sms/gateway/heartbeat", "POST", payload)

def get_job():
    status, body = api_request("/api/sms/gateway/next")
    if status != 200:
        print(f"Gateway queue request failed ({status}): {body.get('error', body)}")
        return None
    return body.get("job")

def report(job_id, status, provider_id="", provider_status="", error=""):
    payload = {
        "id": str(job_id),
        "status": status,
        "providerMessageId": provider_id,
        "providerStatus": provider_status,
        "error": error,
    }
    code, body = api_request("/api/sms/gateway/result", "POST", payload)
    if code != 200:
        print(f"Could not report SMS result ({code}): {body.get('error', body)}")

def send_sms(phone, message):
    # Gammu's sendsms TEXT path handles linked multipart SMS automatically
    # and can select GSM/Unicode coding with -autolen.
    cmd = gammu_command(
        "sendsms",
        "TEXT",
        phone,
        "-autolen",
        "1000",
        "-textutf8",
        message,
        "-report",
    )
    try:
        p = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=COMMAND_TIMEOUT,
            check=False,
        )
    except FileNotFoundError:
        return False, "", f"Gammu executable not found: {GAMMU_BIN}"
    except subprocess.TimeoutExpired:
        return False, "", "Gammu send command timed out."
    except Exception as exc:
        return False, "", str(exc)

    output = ((p.stdout or "") + "\n" + (p.stderr or "")).strip()
    if p.returncode != 0:
        return False, "", output[-1000:] or f"Gammu returned exit code {p.returncode}."

    match = re.search(r"(?:message\s+reference|reference)\s*[=:]?\s*(\d+)", output, re.I)
    provider_id = match.group(1) if match else ""
    return True, provider_id, output[-600:] or "Gammu accepted the SMS for transmission."

def main():
    print("FBI Private SMS Gateway starting...")
    print(f"Invoice Studio: {SERVER_URL}")
    print(f"Gateway: {GATEWAY_NAME}")
    print(f"SIM line: {SIM_LINE}")
    print(f"Gammu: {GAMMU_BIN}")

    last_modem_check = 0.0
    last_heartbeat = 0.0
    modem_ok = False
    modem_detail = "Waiting for modem check."

    while True:
        now = time.time()

        if now - last_modem_check >= MODEM_CHECK_SECONDS:
            modem_ok, modem_detail = check_modem()
            last_modem_check = now
            print(("MODEM ONLINE: " if modem_ok else "MODEM OFFLINE: ") + modem_detail)

        if now - last_heartbeat >= HEARTBEAT_SECONDS:
            code, body = heartbeat(modem_ok, modem_detail)
            if code != 200:
                print(f"Heartbeat failed ({code}): {body.get('error', body)}")
            last_heartbeat = now

        if not modem_ok:
            time.sleep(POLL_SECONDS)
            continue

        job = get_job()
        if not job:
            time.sleep(POLL_SECONDS)
            continue

        job_id = job.get("id")
        phone = str(job.get("phone", "")).strip()
        message = str(job.get("message", ""))

        if not job_id or not phone or not message:
            report(job_id or "", "failed", error="Gateway received an incomplete SMS job.")
            continue

        client_name = str(job.get("clientName", "Client"))
        print(f"SENDING -> {client_name} / {phone}")

        ok, provider_id, detail = send_sms(phone, message)

        if ok:
            report(job_id, "sent", provider_id, "SUBMITTED_TO_MODEM", detail)
            print(f"SENT -> {client_name} / {phone}" + (f" / ref {provider_id}" if provider_id else ""))
        else:
            report(job_id, "failed", provider_status="MODEM_ERROR", error=detail)
            print(f"FAILED -> {client_name} / {phone}: {detail}")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nGateway stopped.")

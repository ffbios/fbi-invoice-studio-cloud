# FBI Private SMS Gateway

This is the self-hosted SMS bridge for FBI Invoice Studio.

## What it does

Invoice Studio keeps your client phone numbers and SMS campaigns in PostgreSQL. The cloud application queues each message. This gateway runs on a computer you control, pulls queued jobs over HTTPS, and sends them through a GSM phone/modem using a SIM.

There is no Arkesel, Twilio, or other paid SMS API in this design.

The mobile network/SIM is still required. A domain cannot itself transmit SMS over the cellular network.

## Hardware

Use one dedicated computer that stays on when you need SMS sending. A small Linux PC, Raspberry Pi, or your Windows workstation can work.

You also need a GSM/4G USB modem or a phone that Gammu supports, with a SIM that has SMS service. For larger campaigns, a dedicated modem is preferable to repeatedly moving your personal phone.

## Software

Install:

- Python 3
- Gammu

Gammu provides the local GSM modem interface. It supports AT-capable modems and ordinary text SMS, including long messages split into linked SMS parts.

## Configure Gammu

First detect the modem.

Windows:
- Open Device Manager.
- Find the modem under Ports (COM & LPT).
- Create a Gammu config such as:

  [gammu]
  device = COM12:
  connection = at

Linux:

  [gammu]
  device = /dev/ttyUSB0
  connection = at

Then verify:

  gammu identify

Do not continue until Gammu can identify the modem.

## Configure the FBI gateway

Set these environment variables on the gateway computer:

  FBI_SMS_SERVER_URL=https://invoice.fbigh.com
  FBI_SMS_GATEWAY_TOKEN=<the same private token configured in Railway>
  FBI_SMS_GATEWAY_ID=fbi-private-gateway-1
  FBI_SMS_GATEWAY_NAME=FBI Private SMS Gateway
  FBI_SMS_SIM_LINE=Private SIM line
  FBI_SMS_PORT=COM12:
  GAMMU_BIN=gammu
  GAMMU_CONFIG=C:\path\to\gammurc

Linux example:

  export FBI_SMS_SERVER_URL="https://invoice.fbigh.com"
  export FBI_SMS_GATEWAY_TOKEN="YOUR_PRIVATE_TOKEN"
  export GAMMU_CONFIG="/home/fbi/.gammurc"
  python3 gateway.py

Windows PowerShell example:

  $env:FBI_SMS_SERVER_URL="https://invoice.fbigh.com"
  $env:FBI_SMS_GATEWAY_TOKEN="YOUR_PRIVATE_TOKEN"
  $env:GAMMU_CONFIG="C:\FBI-SMS\gammurc"
  python gateway.py

## Sending flow

1. Add or edit client phone numbers in Invoice Studio.
2. Open SMS Center.
3. Select all clients or specific clients.
4. Compose the message.
5. Confirm the recipients are allowed to receive it.
6. Queue the campaign.
7. The private gateway automatically picks up the queue.
8. Gammu sends the message through the connected SIM.
9. The gateway reports sent/failed results back to Invoice Studio.

New phone numbers added to Invoice Studio's client database are automatically available to the SMS Center because the SMS Center reads that same database directly.

## Important

The gateway token must stay private. Do not commit it to GitHub or place it in the web page.

For production use, keep the gateway computer connected to power and a reliable network. A small dedicated Linux/Raspberry Pi box is usually better than a workstation that gets shut down.

For multiple modems, run additional gateway instances with different gateway IDs and modem configuration.

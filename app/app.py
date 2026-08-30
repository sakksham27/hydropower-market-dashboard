import csv
import io
import os
import re
import smtplib
import threading
import time as time_module
from datetime import date, datetime, time, timezone
from email.message import EmailMessage
from functools import wraps
from zoneinfo import ZoneInfo

import psycopg2
import requests
from flask import Flask, jsonify, redirect, render_template, request, session, url_for
from flask_wtf import CSRFProtect
from flask_wtf.csrf import CSRFError
from werkzeug.security import check_password_hash, generate_password_hash

import db

app = Flask(__name__)
app.secret_key = os.environ["SECRET_KEY"]
# No expiry: this is a dashboard people leave open for hours, and a fresh
# token isn't issued until the page is reloaded.
app.config["WTF_CSRF_TIME_LIMIT"] = None
csrf = CSRFProtect(app)
db.ensure_users_table()
db.ensure_saved_sites_table()
db.ensure_alert_thresholds_table()
db.ensure_alert_notifications_table()


@app.errorhandler(CSRFError)
def handle_csrf_error(exc):
    return jsonify({"error": "Your session expired. Please refresh the page and try again."}), 400

VALID_PANEL_TYPES = {"usgs", "nyiso", "reach"}
VALID_DIRECTIONS = {"above", "below"}
EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("start"))
        return view(*args, **kwargs)

    return wrapped

USGS_IV_URL = "https://waterservices.usgs.gov/nwis/iv/"
PARAMETER_CD = "00060"  # discharge, cubic feet per second
NO_DATA_VALUE = "-999999"

NYISO_REALTIME_URL_TEMPLATE = "https://mis.nyiso.com/public/csv/realtime/{date}realtime_gen.csv"
NYISO_TZ = ZoneInfo("America/New_York")

NWPS_STREAMFLOW_URL_TEMPLATE = "https://api.water.noaa.gov/nwps/v1/reaches/{reach_id}/streamflow"
NWPS_SERIES_KEY_MAP = {
    "shortRange": "short_range",
}
NWPS_CHART_SERIES = ["short_range"]


def fetch_usgs_data(site_no: str) -> dict:
    today = date.today().isoformat()
    params = {
        "format": "json",
        "sites": site_no,
        "parameterCd": PARAMETER_CD,
        "startDT": today,
        "endDT": today,
    }
    response = requests.get(USGS_IV_URL, params=params, timeout=15)
    response.raise_for_status()
    return response.json()


def clean_usgs_data(payload: dict) -> list[dict]:
    rows = []
    time_series = payload.get("value", {}).get("timeSeries", [])

    for series in time_series:
        source_info = series.get("sourceInfo", {})
        variable = series.get("variable", {})

        site_codes = source_info.get("siteCode", [])
        site_no = site_codes[0].get("value") if site_codes else None
        site_name = source_info.get("siteName")

        geo_location = source_info.get("geoLocation", {}).get("geogLocation", {})
        latitude = geo_location.get("latitude")
        longitude = geo_location.get("longitude")

        variable_codes = variable.get("variableCode", [])
        parameter_cd = variable_codes[0].get("value") if variable_codes else None
        parameter_name = variable.get("variableName")
        unit_code = variable.get("unit", {}).get("unitCode")

        for value_block in series.get("values", []):
            for point in value_block.get("value", []):
                raw_value = point.get("value")
                if raw_value is None or raw_value == NO_DATA_VALUE:
                    numeric_value = None
                else:
                    try:
                        numeric_value = float(raw_value)
                    except ValueError:
                        numeric_value = None

                qualifiers = point.get("qualifiers") or []

                rows.append(
                    {
                        "site_no": site_no,
                        "site_name": site_name,
                        "latitude": latitude,
                        "longitude": longitude,
                        "parameter_cd": parameter_cd,
                        "parameter_name": parameter_name,
                        "unit_code": unit_code,
                        "datetime": point.get("dateTime"),
                        "value": numeric_value,
                        "qualifiers": ",".join(qualifiers) if qualifiers else None,
                    }
                )

    return rows


def _normalize_ptid(value):
    value = (value or "").strip()
    return str(int(value)) if value.isdigit() else value


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_nyiso_csv() -> str:
    today = date.today().strftime("%Y%m%d")
    url = NYISO_REALTIME_URL_TEMPLATE.format(date=today)
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    return response.text


def clean_nyiso_data(csv_text: str, ptid: str) -> list[dict]:
    target = _normalize_ptid(ptid)
    rows = []

    for record in csv.DictReader(io.StringIO(csv_text)):
        if _normalize_ptid(record.get("PTID")) != target:
            continue
        try:
            reading_dt = datetime.strptime(
                record["Time Stamp"], "%m/%d/%Y %H:%M:%S"
            ).replace(tzinfo=NYISO_TZ)
        except (KeyError, ValueError):
            continue

        rows.append(
            {
                "ptid": target,
                "name": record.get("Name"),
                "datetime": reading_dt,
                "lbmp": _to_float(record.get("LBMP ($/MWHr)")),
                "marginal_cost_losses": _to_float(record.get("Marginal Cost Losses ($/MWHr)")),
                "marginal_cost_congestion": _to_float(
                    record.get("Marginal Cost Congestion ($/MWHr)")
                ),
            }
        )

    return rows


def _parse_nwps_time(value):
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def fetch_reach_streamflow(reach_id: str) -> dict:
    url = NWPS_STREAMFLOW_URL_TEMPLATE.format(reach_id=reach_id)
    response = requests.get(url, params={"series": "short_range"}, timeout=30)
    response.raise_for_status()
    return response.json()


def clean_reach_data(payload: dict, reach_id: str) -> list[dict]:
    rows = []

    for json_key, series_name in NWPS_SERIES_KEY_MAP.items():
        series = (payload.get(json_key) or {}).get("series")
        if not series or not series.get("data"):
            continue

        reference_time = _parse_nwps_time(series.get("referenceTime"))
        units = series.get("units")

        for point in series["data"]:
            valid_time = _parse_nwps_time(point.get("validTime"))
            if valid_time is None:
                continue

            rows.append(
                {
                    "reach_id": reach_id,
                    "series": series_name,
                    "reference_time": reference_time,
                    "valid_time": valid_time,
                    "flow": point.get("flow"),
                    "units": units,
                }
            )

    return rows


@app.route("/")
@login_required
def index():
    return render_template("index.html", username=session.get("username"))


@app.route("/start")
def start():
    if "user_id" in session:
        return redirect(url_for("index"))
    return render_template("start.html")


@app.route("/signup", methods=["POST"])
def signup():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""
    confirm_password = request.form.get("confirm_password") or ""

    if not username or not password:
        return render_template(
            "start.html", active_tab="signup", signup_error="Please enter a username and password."
        ), 400
    if len(password) < 6:
        return render_template(
            "start.html", active_tab="signup", signup_error="Password must be at least 6 characters."
        ), 400
    if password != confirm_password:
        return render_template(
            "start.html", active_tab="signup", signup_error="Passwords do not match."
        ), 400

    try:
        user_id = db.create_user(username, generate_password_hash(password, method="pbkdf2:sha256"))
    except psycopg2.errors.UniqueViolation:
        return render_template(
            "start.html",
            active_tab="signup",
            signup_error=f'Username "{username}" is already taken.',
        ), 400

    session["user_id"] = user_id
    session["username"] = username
    return redirect(url_for("index"))


@app.route("/login", methods=["POST"])
def login():
    username = (request.form.get("username") or "").strip()
    password = request.form.get("password") or ""

    user = db.get_user_by_username(username)
    if not user or not check_password_hash(user["password_hash"], password):
        return render_template(
            "start.html", active_tab="signin", login_error="Invalid username or password."
        ), 401

    session["user_id"] = user["id"]
    session["username"] = user["username"]
    return redirect(url_for("index"))


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("start"))


@app.route("/api/sites", methods=["GET"])
@login_required
def api_list_sites():
    sites = db.get_saved_sites(session["user_id"])
    return jsonify({"sites": sites})


@app.route("/api/sites", methods=["POST"])
@login_required
def api_create_site():
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    gauge_id = (body.get("gauge_id") or "").strip() or None
    ptid = (body.get("ptid") or "").strip() or None
    reach_id = (body.get("reach_id") or "").strip() or None

    if not name:
        return jsonify({"error": "Please enter a site name."}), 400
    if not (gauge_id or ptid or reach_id):
        return jsonify({"error": "Enter at least one ID (gauge, PTID, or reach)."}), 400

    try:
        site_id = db.create_saved_site(session["user_id"], name, gauge_id, ptid, reach_id)
    except psycopg2.errors.UniqueViolation:
        return jsonify({"error": f'You already have a saved site named "{name}".'}), 400

    return jsonify(
        {"id": site_id, "name": name, "gauge_id": gauge_id, "ptid": ptid, "reach_id": reach_id}
    )


@app.route("/api/sites/<int:site_id>", methods=["PUT"])
@login_required
def api_update_site(site_id):
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    gauge_id = (body.get("gauge_id") or "").strip() or None
    ptid = (body.get("ptid") or "").strip() or None
    reach_id = (body.get("reach_id") or "").strip() or None

    if not name:
        return jsonify({"error": "Please enter a site name."}), 400
    if not (gauge_id or ptid or reach_id):
        return jsonify({"error": "Enter at least one ID (gauge, PTID, or reach)."}), 400

    try:
        updated = db.update_saved_site(session["user_id"], site_id, name, gauge_id, ptid, reach_id)
    except psycopg2.errors.UniqueViolation:
        return jsonify({"error": f'You already have a saved site named "{name}".'}), 400

    if not updated:
        return jsonify({"error": "Site not found."}), 404

    return jsonify(
        {"id": site_id, "name": name, "gauge_id": gauge_id, "ptid": ptid, "reach_id": reach_id}
    )


@app.route("/api/sites/<int:site_id>", methods=["DELETE"])
@login_required
def api_delete_site(site_id):
    deleted = db.delete_saved_site(session["user_id"], site_id)
    if not deleted:
        return jsonify({"error": "Site not found."}), 404
    return jsonify({"deleted": site_id})


@app.route("/api/alerts/list", methods=["GET"])
@login_required
def api_list_alerts():
    alerts = db.get_alert_thresholds(session["user_id"])
    return jsonify({"alerts": alerts})


@app.route("/api/settings/alerts", methods=["GET"])
@login_required
def api_get_alerts_setting():
    return jsonify({"enabled": db.get_alerts_enabled(session["user_id"])})


@app.route("/api/settings/alerts", methods=["POST"])
@login_required
def api_set_alerts_setting():
    body = request.get_json(silent=True) or {}
    enabled = bool(body.get("enabled"))
    db.set_alerts_enabled(session["user_id"], enabled)
    return jsonify({"enabled": enabled})


@app.route("/api/settings/contact", methods=["GET"])
@login_required
def api_get_contact_settings():
    return jsonify(db.get_contact_settings(session["user_id"]))


@app.route("/api/settings/contact", methods=["POST"])
@login_required
def api_set_contact_settings():
    body = request.get_json(silent=True) or {}
    email = (body.get("email") or "").strip()
    email_alerts_enabled = bool(body.get("email_alerts_enabled"))

    if email and not EMAIL_PATTERN.match(email):
        return jsonify({"error": "Enter a valid email address."}), 400
    if email_alerts_enabled and not email:
        return jsonify({"error": "Add an email address before turning on email alerts."}), 400

    db.set_contact_settings(session["user_id"], email or None, email_alerts_enabled)
    return jsonify({"email": email or None, "email_alerts_enabled": email_alerts_enabled})


@app.route("/api/notifications", methods=["GET"])
@login_required
def api_list_notifications():
    notifications = db.get_alert_notifications(session["user_id"])
    for n in notifications:
        n["created_at"] = n["created_at"].isoformat()
    return jsonify(
        {
            "notifications": notifications,
            "unread_count": db.get_unread_notification_count(session["user_id"]),
        }
    )


@app.route("/api/notifications/read", methods=["POST"])
@login_required
def api_mark_notifications_read():
    db.mark_notifications_read(session["user_id"])
    return jsonify({"marked": True})


@app.route("/api/alerts", methods=["GET"])
@login_required
def api_get_alert():
    panel_type = request.args.get("panel_type") or ""
    external_id = request.args.get("external_id") or ""

    if panel_type not in VALID_PANEL_TYPES or not external_id:
        return jsonify({"error": "panel_type and external_id are required."}), 400

    # Alerts are opt-in: skip evaluation entirely unless the user has turned
    # the feature on, even if they already have thresholds configured.
    if not db.get_alerts_enabled(session["user_id"]):
        return jsonify({"threshold": None})

    threshold = db.get_alert_threshold(session["user_id"], panel_type, external_id)
    return jsonify({"threshold": threshold})


@app.route("/api/alerts", methods=["POST"])
@login_required
def api_set_alert():
    body = request.get_json(silent=True) or {}
    panel_type = body.get("panel_type") or ""
    external_id = (body.get("external_id") or "").strip()
    direction = body.get("direction") or ""
    threshold_value = body.get("threshold_value")

    if panel_type not in VALID_PANEL_TYPES or not external_id:
        return jsonify({"error": "panel_type and external_id are required."}), 400
    if direction not in VALID_DIRECTIONS:
        return jsonify({"error": "direction must be 'above' or 'below'."}), 400
    try:
        threshold_value = float(threshold_value)
    except (TypeError, ValueError):
        return jsonify({"error": "threshold_value must be a number."}), 400

    db.upsert_alert_threshold(session["user_id"], panel_type, external_id, direction, threshold_value)
    return jsonify(
        {"panel_type": panel_type, "external_id": external_id, "direction": direction, "threshold_value": threshold_value}
    )


@app.route("/api/alerts", methods=["DELETE"])
@login_required
def api_delete_alert():
    panel_type = request.args.get("panel_type") or ""
    external_id = request.args.get("external_id") or ""

    if panel_type not in VALID_PANEL_TYPES or not external_id:
        return jsonify({"error": "panel_type and external_id are required."}), 400

    db.delete_alert_threshold(session["user_id"], panel_type, external_id)
    return jsonify({"deleted": True})


@app.route("/api/fetch", methods=["POST"])
@login_required
def api_fetch():
    body = request.get_json(silent=True) or {}
    site_no = (body.get("site_no") or "").strip()

    if not site_no:
        return jsonify({"error": "Please enter a gauge number."}), 400

    try:
        payload = fetch_usgs_data(site_no)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to reach USGS API: {exc}"}), 502

    rows = clean_usgs_data(payload)

    if not rows:
        return jsonify(
            {
                "error": f"No data returned for gauge {site_no} on today's date. "
                "Double-check the gauge number."
            }
        ), 404

    db.ensure_table()
    upserted = db.upsert_readings(rows)

    return jsonify(
        {
            "site_no": site_no,
            "rows_fetched": len(rows),
            "rows_upserted": upserted,
            "table": db.TABLE_NAME,
        }
    )


@app.route("/api/readings")
@login_required
def api_readings():
    site_no = (request.args.get("site_no") or "").strip()

    if not site_no:
        return jsonify({"error": "site_no is required"}), 400

    start_of_day = datetime.combine(date.today(), time.min).astimezone()
    readings = db.get_readings_since(site_no, PARAMETER_CD, start_of_day)

    serialized = []
    for r in readings:
        row = dict(r)
        row["datetime"] = row["datetime"].isoformat()
        row["inserted_at"] = row["inserted_at"].isoformat()
        serialized.append(row)

    return jsonify(
        {
            "site_no": site_no,
            "start": start_of_day.isoformat(),
            "readings": serialized,
        }
    )


@app.route("/api/nyiso/fetch", methods=["POST"])
@login_required
def api_nyiso_fetch():
    body = request.get_json(silent=True) or {}
    ptid = (body.get("ptid") or "").strip()

    if not ptid:
        return jsonify({"error": "Please enter a PTID."}), 400

    try:
        csv_text = fetch_nyiso_csv()
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to reach NYISO: {exc}"}), 502

    rows = clean_nyiso_data(csv_text, ptid)

    if not rows:
        return jsonify(
            {
                "error": f"No data found for PTID {ptid} in today's file. "
                "Double-check the PTID."
            }
        ), 404

    db.ensure_lbmp_table()
    upserted = db.upsert_lbmp_readings(rows)

    return jsonify(
        {
            "ptid": rows[0]["ptid"],
            "name": rows[0]["name"],
            "rows_fetched": len(rows),
            "rows_upserted": upserted,
            "table": db.LBMP_TABLE_NAME,
        }
    )


@app.route("/api/nyiso/readings")
@login_required
def api_nyiso_readings():
    ptid = _normalize_ptid(request.args.get("ptid") or "")

    if not ptid:
        return jsonify({"error": "ptid is required"}), 400

    start_of_day = datetime.combine(date.today(), time.min).astimezone()
    readings = db.get_lbmp_readings_since(ptid, start_of_day)

    serialized = []
    for r in readings:
        row = dict(r)
        row["datetime"] = row["datetime"].isoformat()
        row["inserted_at"] = row["inserted_at"].isoformat()
        serialized.append(row)

    return jsonify(
        {
            "ptid": ptid,
            "start": start_of_day.isoformat(),
            "readings": serialized,
        }
    )


@app.route("/api/reach/fetch", methods=["POST"])
@login_required
def api_reach_fetch():
    body = request.get_json(silent=True) or {}
    reach_id = (body.get("reach_id") or "").strip()

    if not reach_id:
        return jsonify({"error": "Please enter a reach ID."}), 400

    try:
        payload = fetch_reach_streamflow(reach_id)
    except requests.RequestException as exc:
        return jsonify({"error": f"Failed to reach NOAA NWPS: {exc}"}), 502

    rows = clean_reach_data(payload, reach_id)

    if not rows:
        return jsonify(
            {
                "error": f"No streamflow data available for reach {reach_id} right now. "
                "Double-check the reach ID."
            }
        ), 404

    db.ensure_reach_table()
    upserted = db.upsert_reach_readings(rows)

    rows_by_series = {}
    for row in rows:
        rows_by_series[row["series"]] = rows_by_series.get(row["series"], 0) + 1

    return jsonify(
        {
            "reach_id": reach_id,
            "rows_fetched": len(rows),
            "rows_upserted": upserted,
            "rows_by_series": rows_by_series,
            "table": db.REACH_TABLE_NAME,
        }
    )


@app.route("/api/reach/readings")
@login_required
def api_reach_readings():
    reach_id = (request.args.get("reach_id") or "").strip()

    if not reach_id:
        return jsonify({"error": "reach_id is required"}), 400

    readings = db.get_reach_readings(reach_id, NWPS_CHART_SERIES)

    serialized = []
    for r in readings:
        row = dict(r)
        row["valid_time"] = row["valid_time"].isoformat()
        row["reference_time"] = (
            row["reference_time"].isoformat() if row["reference_time"] else None
        )
        row["inserted_at"] = row["inserted_at"].isoformat()
        serialized.append(row)

    return jsonify({"reach_id": reach_id, "readings": serialized})


# --- Email alerts -----------------------------------------------------------
#
# Generic SMTP rather than a specific provider's SDK, so any account works
# (Gmail app password, SendGrid, Mailgun, ...). Left blank in .env by
# default: sends are skipped (and logged) until real credentials are added,
# so the rest of the alert pipeline works today without them.

SMTP_HOST = os.environ.get("SMTP_HOST", "")
SMTP_PORT = int(os.environ.get("SMTP_PORT") or "587")
SMTP_USERNAME = os.environ.get("SMTP_USERNAME", "")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD", "")
SMTP_FROM_EMAIL = os.environ.get("SMTP_FROM_EMAIL", "")


def send_alert_email(to_email: str, subject: str, body: str) -> bool:
    if not SMTP_HOST or not SMTP_FROM_EMAIL:
        print(f"[alerts] SMTP not configured — skipping email send, would have notified {to_email}: {subject}")
        return False

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM_EMAIL
    msg["To"] = to_email
    msg.set_content(body)

    try:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=10) as smtp:
            smtp.starttls()
            if SMTP_USERNAME:
                smtp.login(SMTP_USERNAME, SMTP_PASSWORD)
            smtp.send_message(msg)
        return True
    except Exception as exc:  # noqa: BLE001 - never let a mail failure break the poll loop
        print(f"[alerts] Failed to send email to {to_email}: {exc}")
        return False


# --- Background alert poller -------------------------------------------------
#
# The in-app alert banner only gets checked when a panel happens to be open
# in a browser and loads new data. To notify someone who isn't looking at
# the screen, something has to independently re-check thresholds on its own
# schedule — this thread does that, polling the same external APIs the
# panels use, on a fixed interval, for as long as the app process is alive.

ALERT_POLL_INTERVAL_SECONDS = 300  # matches the dashboard's own auto-refresh cadence


def _latest_usgs_value(site_no):
    rows = [r for r in clean_usgs_data(fetch_usgs_data(site_no)) if r["value"] is not None]
    if not rows:
        return None
    return max(rows, key=lambda r: r["datetime"])["value"]


def _latest_nyiso_value(ptid):
    rows = [r for r in clean_nyiso_data(fetch_nyiso_csv(), ptid) if r["lbmp"] is not None]
    if not rows:
        return None
    return max(rows, key=lambda r: r["datetime"])["lbmp"]


def _latest_reach_value(reach_id):
    rows = [r for r in clean_reach_data(fetch_reach_streamflow(reach_id), reach_id) if r["flow"] is not None]
    if not rows:
        return None
    now = datetime.now(timezone.utc)
    return min(rows, key=lambda r: abs((r["valid_time"] - now).total_seconds()))["flow"]


LATEST_VALUE_FETCHERS = {
    "usgs": _latest_usgs_value,
    "nyiso": _latest_nyiso_value,
    "reach": _latest_reach_value,
}


def check_all_alerts():
    thresholds = db.get_active_alert_thresholds()
    if not thresholds:
        return

    value_cache = {}

    for t in thresholds:
        cache_key = (t["panel_type"], t["external_id"])
        if cache_key not in value_cache:
            fetcher = LATEST_VALUE_FETCHERS.get(t["panel_type"])
            try:
                value_cache[cache_key] = fetcher(t["external_id"]) if fetcher else None
            except Exception as exc:  # noqa: BLE001 - one bad fetch shouldn't stop the rest
                print(f"[alerts] Failed to fetch {t['panel_type']} {t['external_id']}: {exc}")
                value_cache[cache_key] = None

        value = value_cache[cache_key]
        if value is None:
            continue

        is_triggered = value > t["threshold_value"] if t["direction"] == "above" else value < t["threshold_value"]

        # Edge-triggered: only fire on the transition into a violation, not
        # on every poll while it remains violated, so a stuck-high price
        # doesn't spam a notification (and an email) every 5 minutes.
        if is_triggered and not t["is_triggered"]:
            email_sent = False
            if t["email_alerts_enabled"] and t["email"]:
                subject = f"Alert: {t['panel_type'].upper()} {t['external_id']} is {t['direction']} {t['threshold_value']}"
                body = (
                    f"Your alert for {t['panel_type'].upper()} {t['external_id']} has triggered.\n\n"
                    f"Condition: value {t['direction']} {t['threshold_value']}\n"
                    f"Observed value: {value}\n\n"
                    f"- Hydropower Market Dashboard"
                )
                email_sent = send_alert_email(t["email"], subject, body)
            db.create_alert_notification(
                t["user_id"], t["panel_type"], t["external_id"], t["direction"],
                t["threshold_value"], value, email_sent,
            )
            db.set_threshold_triggered_state(t["id"], True)
        elif not is_triggered and t["is_triggered"]:
            db.set_threshold_triggered_state(t["id"], False)


def _alert_poll_loop():
    while True:
        try:
            check_all_alerts()
        except Exception as exc:  # noqa: BLE001 - keep the loop alive across errors
            print(f"[alerts] Poll loop error: {exc}")
        time_module.sleep(ALERT_POLL_INTERVAL_SECONDS)


def _should_start_alert_poller() -> bool:
    """Exactly one process should run the poller.

    Flask's debug reloader re-executes this whole module in a parent
    "watcher" process (which never serves requests) before spawning the real
    serving process as a child with WERKZEUG_RUN_MAIN set - so under the
    reloader, only the child should start it. Outside the reloader (e.g.
    gunicorn in production) that env var is never set at all, so there's no
    parent/child split to worry about and it should just start. Production
    deploys must still run a single worker process, since each worker would
    otherwise start its own poller and send duplicate alert emails.
    """
    run_main = os.environ.get("WERKZEUG_RUN_MAIN")
    return run_main == "true" if run_main is not None else True


if _should_start_alert_poller():
    threading.Thread(target=_alert_poll_loop, daemon=True).start()


if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(debug=debug_mode, port=5050)

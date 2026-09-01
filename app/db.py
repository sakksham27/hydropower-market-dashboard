import os

import psycopg2
from dotenv import load_dotenv

load_dotenv()

TABLE_NAME = "usgs_streamflow"

CREATE_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    site_no TEXT NOT NULL,
    site_name TEXT,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    parameter_cd TEXT NOT NULL,
    parameter_name TEXT,
    unit_code TEXT,
    datetime TIMESTAMPTZ NOT NULL,
    value DOUBLE PRECISION,
    qualifiers TEXT,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (site_no, parameter_cd, datetime)
);
"""

UPSERT_SQL = f"""
INSERT INTO {TABLE_NAME}
    (site_no, site_name, latitude, longitude, parameter_cd, parameter_name, unit_code, datetime, value, qualifiers)
VALUES
    (%(site_no)s, %(site_name)s, %(latitude)s, %(longitude)s, %(parameter_cd)s, %(parameter_name)s,
     %(unit_code)s, %(datetime)s, %(value)s, %(qualifiers)s)
ON CONFLICT (site_no, parameter_cd, datetime) DO UPDATE SET
    site_name = EXCLUDED.site_name,
    latitude = EXCLUDED.latitude,
    longitude = EXCLUDED.longitude,
    parameter_name = EXCLUDED.parameter_name,
    unit_code = EXCLUDED.unit_code,
    value = EXCLUDED.value,
    qualifiers = EXCLUDED.qualifiers;
"""

SELECT_TODAY_SQL = f"""
SELECT site_no, site_name, latitude, longitude, parameter_cd, parameter_name,
       unit_code, datetime, value, qualifiers, inserted_at
FROM {TABLE_NAME}
WHERE site_no = %(site_no)s
  AND parameter_cd = %(parameter_cd)s
  AND datetime >= %(start)s
ORDER BY datetime ASC;
"""

LBMP_TABLE_NAME = "nyiso_realtime_lbmp"

CREATE_LBMP_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {LBMP_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    ptid TEXT NOT NULL,
    name TEXT,
    datetime TIMESTAMPTZ NOT NULL,
    lbmp DOUBLE PRECISION,
    marginal_cost_losses DOUBLE PRECISION,
    marginal_cost_congestion DOUBLE PRECISION,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (ptid, datetime)
);
"""

UPSERT_LBMP_SQL = f"""
INSERT INTO {LBMP_TABLE_NAME}
    (ptid, name, datetime, lbmp, marginal_cost_losses, marginal_cost_congestion)
VALUES
    (%(ptid)s, %(name)s, %(datetime)s, %(lbmp)s, %(marginal_cost_losses)s, %(marginal_cost_congestion)s)
ON CONFLICT (ptid, datetime) DO UPDATE SET
    name = EXCLUDED.name,
    lbmp = EXCLUDED.lbmp,
    marginal_cost_losses = EXCLUDED.marginal_cost_losses,
    marginal_cost_congestion = EXCLUDED.marginal_cost_congestion;
"""

SELECT_LBMP_TODAY_SQL = f"""
SELECT ptid, name, datetime, lbmp, marginal_cost_losses, marginal_cost_congestion, inserted_at
FROM {LBMP_TABLE_NAME}
WHERE ptid = %(ptid)s
  AND datetime >= %(start)s
ORDER BY datetime ASC;
"""

REACH_TABLE_NAME = "nwm_reach_streamflow"

CREATE_REACH_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {REACH_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    reach_id TEXT NOT NULL,
    series TEXT NOT NULL,
    reference_time TIMESTAMPTZ,
    valid_time TIMESTAMPTZ NOT NULL,
    flow DOUBLE PRECISION,
    units TEXT,
    inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (reach_id, series, valid_time)
);
"""

UPSERT_REACH_SQL = f"""
INSERT INTO {REACH_TABLE_NAME}
    (reach_id, series, reference_time, valid_time, flow, units)
VALUES
    (%(reach_id)s, %(series)s, %(reference_time)s, %(valid_time)s, %(flow)s, %(units)s)
ON CONFLICT (reach_id, series, valid_time) DO UPDATE SET
    reference_time = EXCLUDED.reference_time,
    flow = EXCLUDED.flow,
    units = EXCLUDED.units;
"""

SELECT_REACH_SQL = f"""
SELECT reach_id, series, reference_time, valid_time, flow, units, inserted_at
FROM {REACH_TABLE_NAME}
WHERE reach_id = %(reach_id)s
  AND series = ANY(%(series_list)s)
ORDER BY series, valid_time ASC;
"""


USERS_TABLE_NAME = "users"

CREATE_USERS_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {USERS_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

SAVED_SITES_TABLE_NAME = "saved_sites"

CREATE_SAVED_SITES_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {SAVED_SITES_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES {USERS_TABLE_NAME}(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    gauge_id TEXT,
    ptid TEXT,
    reach_id TEXT,
    head_m DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
"""

ALERT_THRESHOLDS_TABLE_NAME = "alert_thresholds"

CREATE_ALERT_THRESHOLDS_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {ALERT_THRESHOLDS_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES {USERS_TABLE_NAME}(id) ON DELETE CASCADE,
    panel_type TEXT NOT NULL CHECK (panel_type IN ('usgs', 'nyiso', 'reach')),
    external_id TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('above', 'below')),
    threshold_value DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, panel_type, external_id)
);
"""

ALERT_NOTIFICATIONS_TABLE_NAME = "alert_notifications"

CREATE_ALERT_NOTIFICATIONS_TABLE_SQL = f"""
CREATE TABLE IF NOT EXISTS {ALERT_NOTIFICATIONS_TABLE_NAME} (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES {USERS_TABLE_NAME}(id) ON DELETE CASCADE,
    panel_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    threshold_value DOUBLE PRECISION NOT NULL,
    observed_value DOUBLE PRECISION NOT NULL,
    email_sent BOOLEAN NOT NULL DEFAULT false,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""


def get_connection():
    return psycopg2.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=os.environ.get("DB_PORT", "5432"),
        dbname=os.environ.get("DB_NAME", "water_data"),
        user=os.environ.get("DB_USER", "postgres"),
        password=os.environ.get("DB_PASSWORD", ""),
        # "prefer" works for both a local Postgres with no SSL and a hosted
        # provider (e.g. Neon) that requires it - it upgrades to SSL when
        # the server offers it, without needing separate config per environment.
        sslmode=os.environ.get("DB_SSLMODE", "prefer"),
    )


def ensure_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_TABLE_SQL)
    finally:
        conn.close()


def upsert_readings(rows):
    if not rows:
        return 0
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.executemany(UPSERT_SQL, rows)
            return cur.rowcount
    finally:
        conn.close()


def get_readings_since(site_no, parameter_cd, start):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                SELECT_TODAY_SQL,
                {"site_no": site_no, "parameter_cd": parameter_cd, "start": start},
            )
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def ensure_lbmp_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_LBMP_TABLE_SQL)
    finally:
        conn.close()


def upsert_lbmp_readings(rows):
    if not rows:
        return 0
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.executemany(UPSERT_LBMP_SQL, rows)
            return cur.rowcount
    finally:
        conn.close()


def get_lbmp_readings_since(ptid, start):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(SELECT_LBMP_TODAY_SQL, {"ptid": ptid, "start": start})
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def ensure_reach_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_REACH_TABLE_SQL)
    finally:
        conn.close()


def upsert_reach_readings(rows):
    if not rows:
        return 0
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.executemany(UPSERT_REACH_SQL, rows)
            return cur.rowcount
    finally:
        conn.close()


def get_reach_readings(reach_id, series_list):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(SELECT_REACH_SQL, {"reach_id": reach_id, "series_list": series_list})
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def ensure_users_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_USERS_TABLE_SQL)
            cur.execute(
                f"ALTER TABLE {USERS_TABLE_NAME} ADD COLUMN IF NOT EXISTS "
                "alerts_enabled BOOLEAN NOT NULL DEFAULT false"
            )
            cur.execute(f"ALTER TABLE {USERS_TABLE_NAME} ADD COLUMN IF NOT EXISTS email TEXT")
            cur.execute(
                f"ALTER TABLE {USERS_TABLE_NAME} ADD COLUMN IF NOT EXISTS "
                "email_alerts_enabled BOOLEAN NOT NULL DEFAULT false"
            )
    finally:
        conn.close()


def create_user(username, password_hash):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO {USERS_TABLE_NAME} (username, password_hash) VALUES (%s, %s) RETURNING id",
                (username, password_hash),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def get_user_by_username(username):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT id, username, password_hash FROM {USERS_TABLE_NAME} WHERE username = %s",
                (username,),
            )
            row = cur.fetchone()
            if not row:
                return None
            return {"id": row[0], "username": row[1], "password_hash": row[2]}
    finally:
        conn.close()


def get_alerts_enabled(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(f"SELECT alerts_enabled FROM {USERS_TABLE_NAME} WHERE id = %s", (user_id,))
            row = cur.fetchone()
            return bool(row[0]) if row else False
    finally:
        conn.close()


def set_alerts_enabled(user_id, enabled):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE {USERS_TABLE_NAME} SET alerts_enabled = %s WHERE id = %s",
                (enabled, user_id),
            )
    finally:
        conn.close()


def get_contact_settings(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT email, email_alerts_enabled, alerts_enabled FROM {USERS_TABLE_NAME} WHERE id = %s",
                (user_id,),
            )
            row = cur.fetchone()
            if not row:
                return {"email": None, "email_alerts_enabled": False, "alerts_enabled": False}
            return {"email": row[0], "email_alerts_enabled": bool(row[1]), "alerts_enabled": bool(row[2])}
    finally:
        conn.close()


def set_contact_settings(user_id, email, email_alerts_enabled):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE {USERS_TABLE_NAME} SET email = %s, email_alerts_enabled = %s WHERE id = %s",
                (email, email_alerts_enabled, user_id),
            )
    finally:
        conn.close()


def ensure_saved_sites_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_SAVED_SITES_TABLE_SQL)
            cur.execute(
                f"ALTER TABLE {SAVED_SITES_TABLE_NAME} ADD COLUMN IF NOT EXISTS head_m DOUBLE PRECISION"
            )
    finally:
        conn.close()


def create_saved_site(user_id, name, gauge_id, ptid, reach_id, head_m):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {SAVED_SITES_TABLE_NAME} (user_id, name, gauge_id, ptid, reach_id, head_m)
                VALUES (%s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (user_id, name, gauge_id, ptid, reach_id, head_m),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def update_saved_site(user_id, site_id, name, gauge_id, ptid, reach_id, head_m):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                UPDATE {SAVED_SITES_TABLE_NAME}
                SET name = %s, gauge_id = %s, ptid = %s, reach_id = %s, head_m = %s
                WHERE user_id = %s AND id = %s
                """,
                (name, gauge_id, ptid, reach_id, head_m, user_id, site_id),
            )
            return cur.rowcount
    finally:
        conn.close()


def get_saved_sites(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT id, name, gauge_id, ptid, reach_id, head_m
                FROM {SAVED_SITES_TABLE_NAME}
                WHERE user_id = %s
                ORDER BY name ASC
                """,
                (user_id,),
            )
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def delete_saved_site(user_id, site_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"DELETE FROM {SAVED_SITES_TABLE_NAME} WHERE user_id = %s AND id = %s",
                (user_id, site_id),
            )
            return cur.rowcount
    finally:
        conn.close()


def ensure_alert_thresholds_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_ALERT_THRESHOLDS_TABLE_SQL)
            cur.execute(
                f"ALTER TABLE {ALERT_THRESHOLDS_TABLE_NAME} ADD COLUMN IF NOT EXISTS "
                "is_triggered BOOLEAN NOT NULL DEFAULT false"
            )
    finally:
        conn.close()


def ensure_alert_notifications_table():
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(CREATE_ALERT_NOTIFICATIONS_TABLE_SQL)
    finally:
        conn.close()


def upsert_alert_threshold(user_id, panel_type, external_id, direction, threshold_value):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {ALERT_THRESHOLDS_TABLE_NAME}
                    (user_id, panel_type, external_id, direction, threshold_value)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (user_id, panel_type, external_id) DO UPDATE SET
                    direction = EXCLUDED.direction,
                    threshold_value = EXCLUDED.threshold_value
                RETURNING id
                """,
                (user_id, panel_type, external_id, direction, threshold_value),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def get_alert_threshold(user_id, panel_type, external_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT direction, threshold_value
                FROM {ALERT_THRESHOLDS_TABLE_NAME}
                WHERE user_id = %s AND panel_type = %s AND external_id = %s
                """,
                (user_id, panel_type, external_id),
            )
            row = cur.fetchone()
            if not row:
                return None
            return {"direction": row[0], "threshold_value": row[1]}
    finally:
        conn.close()


def get_alert_thresholds(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT id, panel_type, external_id, direction, threshold_value
                FROM {ALERT_THRESHOLDS_TABLE_NAME}
                WHERE user_id = %s
                ORDER BY panel_type ASC, external_id ASC
                """,
                (user_id,),
            )
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def delete_alert_threshold(user_id, panel_type, external_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                DELETE FROM {ALERT_THRESHOLDS_TABLE_NAME}
                WHERE user_id = %s AND panel_type = %s AND external_id = %s
                """,
                (user_id, panel_type, external_id),
            )
            return cur.rowcount
    finally:
        conn.close()


def get_active_alert_thresholds():
    """All thresholds belonging to users who have alerts turned on, joined
    with the contact info needed to notify them — the background poller's
    single source of what to check each cycle."""
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT at.id, at.user_id, at.panel_type, at.external_id, at.direction,
                       at.threshold_value, at.is_triggered, u.email, u.email_alerts_enabled
                FROM {ALERT_THRESHOLDS_TABLE_NAME} at
                JOIN {USERS_TABLE_NAME} u ON u.id = at.user_id
                WHERE u.alerts_enabled = true
                """
            )
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def set_threshold_triggered_state(threshold_id, is_triggered):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE {ALERT_THRESHOLDS_TABLE_NAME} SET is_triggered = %s WHERE id = %s",
                (is_triggered, threshold_id),
            )
    finally:
        conn.close()


def create_alert_notification(user_id, panel_type, external_id, direction, threshold_value, observed_value, email_sent):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                INSERT INTO {ALERT_NOTIFICATIONS_TABLE_NAME}
                    (user_id, panel_type, external_id, direction, threshold_value, observed_value, email_sent)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
                """,
                (user_id, panel_type, external_id, direction, threshold_value, observed_value, email_sent),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def get_alert_notifications(user_id, limit=20):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT id, panel_type, external_id, direction, threshold_value, observed_value,
                       email_sent, is_read, created_at
                FROM {ALERT_NOTIFICATIONS_TABLE_NAME}
                WHERE user_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (user_id, limit),
            )
            columns = [desc[0] for desc in cur.description]
            return [dict(zip(columns, row)) for row in cur.fetchall()]
    finally:
        conn.close()


def get_unread_notification_count(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"SELECT COUNT(*) FROM {ALERT_NOTIFICATIONS_TABLE_NAME} WHERE user_id = %s AND is_read = false",
                (user_id,),
            )
            return cur.fetchone()[0]
    finally:
        conn.close()


def mark_notifications_read(user_id):
    conn = get_connection()
    try:
        with conn, conn.cursor() as cur:
            cur.execute(
                f"UPDATE {ALERT_NOTIFICATIONS_TABLE_NAME} SET is_read = true WHERE user_id = %s AND is_read = false",
                (user_id,),
            )
    finally:
        conn.close()

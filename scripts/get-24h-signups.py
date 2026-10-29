#!/usr/bin/env python3
"""
Retrieve user sign-ups in the last 24 hours from PostgreSQL (user_accounts & user_profiles).

Usage:
    DATABASE_URL="postgresql://..." python scripts/get-24h-signups.py
or:
    python scripts/get-24h-signups.py "postgresql://..."
"""

import os
import sys
from datetime import datetime, timezone

try:
    import psycopg
except ImportError:
    print("Error: psycopg is required. Install via: pip install psycopg[binary]")
    sys.exit(1)


def main():
    db_url = os.environ.get("DATABASE_URL")
    if not db_url and len(sys.argv) > 1:
        db_url = sys.argv[1]

    if not db_url:
        print("Usage:")
        print("  DATABASE_URL='postgresql://...' python scripts/get-24h-signups.py")
        print("  python scripts/get-24h-signups.py 'postgresql://...'")
        sys.exit(1)

    print("Connecting to database...")
    try:
        conn = psycopg.connect(db_url)
    except Exception as exc:
        print(f"Error connecting to database: {exc}")
        sys.exit(1)

    with conn, conn.cursor() as cur:
        # 1. Total sign-ups in last 24 hours
        cur.execute(
            """
            SELECT count(*) 
            FROM user_accounts 
            WHERE created_at >= now() - INTERVAL '24 hours'
            """
        )
        total_24h = cur.fetchone()[0]

        # 2. Total all-time sign-ups for context
        cur.execute("SELECT count(*) FROM user_accounts")
        total_all_time = cur.fetchone()[0]

        # 3. Breakdown by signup method (access code vs email)
        cur.execute(
            """
            SELECT 
                COALESCE(up.profile->>'signup_method', 'email_password') AS method,
                count(*) AS count
            FROM user_accounts ua
            LEFT JOIN user_profiles up ON ua.user_id = up.user_id
            WHERE ua.created_at >= now() - INTERVAL '24 hours'
            GROUP BY 1
            ORDER BY count DESC
            """
        )
        methods = cur.fetchall()

        # 4. Hourly sign-up breakdown in IST
        cur.execute(
            """
            SELECT 
                to_char(date_trunc('hour', ua.created_at AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD HH24:00') AS hour_ist,
                count(*) AS count
            FROM user_accounts ua
            WHERE ua.created_at >= now() - INTERVAL '24 hours'
            GROUP BY 1
            ORDER BY 1 DESC
            """
        )
        hourly = cur.fetchall()

        # 5. List of individual sign-ups in last 24 hours
        cur.execute(
            """
            SELECT 
                ua.user_id,
                COALESCE(NULLIF(btrim(concat(up.first_name, ' ', up.last_name)), ''), up.profile->>'full_name', 'N/A') AS name,
                ua.email,
                COALESCE(up.profile->>'signup_method', 'email') AS method,
                COALESCE(up.profile->>'mobile', 'N/A') AS phone,
                to_char(ua.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS') AS signed_up_at_ist
            FROM user_accounts ua
            LEFT JOIN user_profiles up ON ua.user_id = up.user_id
            WHERE ua.created_at >= now() - INTERVAL '24 hours'
            ORDER BY ua.created_at DESC
            """
        )
        signups = cur.fetchall()

    print("\n" + "=" * 65)
    print("USER SIGN-UPS REPORT (LAST 24 HOURS)")
    print("=" * 65)
    print(f"Total Sign-ups (Last 24 Hours) : {total_24h}")
    print(f"Total Sign-ups (All Time)      : {total_all_time}")

    if methods:
        print("\nBreakdown by Method:")
        for method, cnt in methods:
            print(f"  - {method:20}: {cnt}")

    if hourly:
        print("\nHourly Sign-up Velocity (Asia/Kolkata - IST):")
        for hour_str, cnt in hourly:
            bar = "█" * cnt
            print(f"  {hour_str} IST : {cnt:3} {bar}")

    if signups:
        print(f"\nRecent Users ({len(signups)} record(s)):")
        print(f"{'Signed Up (IST)':<20} | {'Name':<20} | {'Email':<30} | {'Method':<12} | {'Mobile':<15}")
        print("-" * 105)
        for s in signups:
            uid, name, email, method, phone, ts_ist = s
            print(f"{ts_ist:<20} | {name[:20]:<20} | {email[:30]:<30} | {method[:12]:<12} | {phone[:15]:<15}")
    else:
        print("\nNo sign-ups recorded in the last 24 hours.")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    main()

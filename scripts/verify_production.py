#!/usr/bin/env python3
"""
Verify production deployment health for AgentShield.
Usage:
    python scripts/verify_production.py https://api.yourdomain.com
    python scripts/verify_production.py http://localhost:8000
"""
import sys
import json
import urllib.request
import urllib.error

def check_endpoint(url: str, name: str) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "AgentShield-HealthProbe/1.0"})
        with urllib.request.urlopen(req, timeout=10) as response:
            code = response.getcode()
            body = response.read().decode("utf-8")
            data = json.loads(body)
            print(f"[PASS] {name} ({url}) -> HTTP {code}: {json.dumps(data)}")
            return True
    except urllib.error.HTTPError as e:
        print(f"[FAIL] {name} ({url}) -> HTTP {e.code}: {e.read().decode('utf-8')}")
        return False
    except Exception as e:
        print(f"[FAIL] {name} ({url}) -> Error: {str(e)}")
        return False

def main():
    base_url = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"
    print("=" * 65)
    print(f"AgentShield Production Health Verification: {base_url}")
    print("=" * 65)

    checks = [
        (f"{base_url}/health", "Service Health"),
        (f"{base_url}/health/live", "Liveness Probe"),
        (f"{base_url}/health/ready", "Database Readiness Probe"),
    ]

    all_passed = True
    for url, name in checks:
        if not check_endpoint(url, name):
            all_passed = False

    print("=" * 65)
    if all_passed:
        print(" SUCCESS: All production health and readiness checks passed!")
        sys.exit(0)
    else:
        print(" ERROR: One or more production probes failed.")
        sys.exit(1)

if __name__ == "__main__":
    main()

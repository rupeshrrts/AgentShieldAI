#!/usr/bin/env python3
"""Generate a cryptographically secure SECRET_KEY for production deployments."""
import secrets

if __name__ == "__main__":
    key = secrets.token_hex(32)
    print("=" * 60)
    print("AgentShield Production Secret Key Generator")
    print("=" * 60)
    print(f"\nSECRET_KEY={key}\n")
    print("Add this line to your production .env file.")
    print("=" * 60)

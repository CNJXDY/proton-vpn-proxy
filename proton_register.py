import requests
import ssl
import json
import random

# Create SSL context
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

# Use proxy
proxies = {
    'http': 'https://213.35.107.110:443',
    'https': 'https://213.35.107.110:443'
}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json'
}

email = 'testuser' + str(random.randint(10000, 99999)) + '@example.com'
print(f"Testing with email: {email}")

s = requests.Session()
s.proxies = proxies
s.verify = False

# Try different API formats
endpoints = [
    'https://account.proton.me/api/core/v4/users/register',
]

for url in endpoints:
    print(f"\n--- Trying URL: {url} ---")
    
    # Test 1: JSON with Email and Password
    try:
        data = {"Email": email, "Password": "TestPass123!"}
        r = s.post(url, json=data, headers=headers, timeout=30)
        print(f"Status: {r.status_code}")
        print(f"Response: {r.text[:500]}")
    except Exception as e:
        print(f"Error: {e}")

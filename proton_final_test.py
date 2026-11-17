import requests
import json
import random
import ssl

# Disable SSL verification warnings
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Proxy configuration - use HTTPS proxy correctly
proxies = {
    'http': 'https://213.35.107.110:443',
    'https': 'https://213.35.107.110:443'
}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://account.proton.me',
    'Referer': 'https://account.proton.me/register'
}

email = 'python' + str(random.randint(10000, 99999)) + '@example.com'
print(f"Testing with email: {email}")

session = requests.Session()
session.proxies = proxies
session.verify = False

# First visit the register page
try:
    r1 = session.get('https://account.proton.me/register', headers=headers, timeout=30)
    print(f"Page status: {r1.status_code}")
    print(f"Page cookies: {dict(session.cookies)}")
    print(f"Page length: {len(r1.text)}")
    
    # Try the registration API
    data = {
        'Email': email,
        'Password': 'TestPass123!'
    }
    
    r2 = session.post(
        'https://account.proton.me/api/core/v4/users/register',
        json=data,
        headers=headers,
        timeout=30
    )
    
    print(f"\nAPI Status: {r2.status_code}")
    print(f"API Response: {r2.text}")
    print(f"API Headers: {dict(r2.headers)}")
    
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()

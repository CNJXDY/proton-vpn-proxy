import requests
import json
import random
from requests.adapters import HTTPAdapter
from urllib3.util.ssl_ import create_urllib3_context

# Custom SSL context that accepts invalid certificates
class InsecureHTTPSAdapter(HTTPAdapter):
    def init_poolmanager(self, *args, **kwargs):
        ctx = create_urllib3_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        kwargs['ssl_context'] = ctx
        return super().init_poolmanager(*args, **kwargs)

import ssl

email = 'pyuser' + str(random.randint(10000, 99999)) + '@example.com'
print(f"Testing: {email}")

session = requests.Session()
session.mount('https://', InsecureHTTPSAdapter())
session.proxies = {
    'http': 'https://213.35.107.110:443',
    'https': 'https://213.35.110.443'
}

headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
    'Accept': 'application/json'
}

# Try the API
url = 'https://account.proton.me/api/core/v4/users/register'
data = {'Email': email, 'Password': 'TestPass123!'}

try:
    # First get the page
    r1 = session.get('https://account.proton.me/register', timeout=30)
    print(f"Page status: {r1.status_code}")
    print(f"Page cookies: {session.cookies.get_dict()}")
    
    # Now POST
    r2 = session.post(url, json=data, headers=headers, timeout=30)
    print(f"\nAPI Status: {r2.status_code}")
    print(f"API Response: {r2.text}")
    print(f"API Headers: {dict(r2.headers)}")
except Exception as e:
    print(f"Error: {e}")

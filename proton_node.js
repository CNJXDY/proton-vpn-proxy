const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');
const url = require('url');

// Create proxy agent
const proxyUrl = 'https://213.35.107.110:443';
const agent = new HttpsProxyAgent(proxyUrl);

const email = 'node' + Math.floor(Math.random() * 99999) + '@example.com';
console.log('Testing with email:', email);

const postData = JSON.stringify({
    Email: email,
    Password: 'TestPass123!'
});

const options = {
    hostname: 'account.proton.me',
    port: 443,
    path: '/api/core/v4/users/register',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    agent: agent
};

const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Response:', data);
        console.log('Headers:', res.headers);
    });
});

req.on('error', (e) => {
    console.error('Error:', e.message);
});

req.write(postData);
req.end();

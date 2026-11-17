const { chromium } = require('playwright');

(async () => {
  console.log('Launching Chromium with proxy...');
  const browser = await chromium.launch({
    proxy: { server: 'http://213.35.107.110:443' },
    executablePath: 'C:\\Users\\dy321\\AppData\\Local\\ms-playwright\\chromium-1243\\chrome-win64\\chrome.exe',
    headless: false,
    args: ['--ignore-certificate-errors']
  });
  
  const page = await browser.newPage();
  
  console.log('Navigating to registration page...');
  await page.goto('https://account.proton.me/register', { waitUntil: 'networkidle', timeout: 30000 });
  
  console.log('Title:', await page.title());
  console.log('URL:', page.url());
  
  await page.screenshot({ path: 'proton_reg.png', fullPage: true });
  console.log('Screenshot saved');
  
  // Wait for user to see the page
  await page.waitForTimeout(10000);
  
  await browser.close();
  console.log('Done!');
})();

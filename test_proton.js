const { chromium } = require('playwright');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    proxy: { server: 'http://213.35.107.110:443' },
    headless: true
  });
  
  const page = await browser.newPage();
  await page.goto('https://account.proton.me/register', { timeout: 30000 });
  console.log('Page title:', await page.title());
  console.log('URL:', page.url());
  
  // Screenshot
  await page.screenshot({ path: 'proton_test.png' });
  
  // Try to find form
  const inputs = await page.$$('input');
  console.log('Found', inputs.length, 'inputs');
  for (let i = 0; i < Math.min(5, inputs.length); i++) {
    const type = await inputs[i].getAttribute('type');
    const name = await inputs[i].getAttribute('name');
    console.log(`Input ${i}: type=${type}, name=${name}`);
  }
  
  await browser.close();
  console.log('Done!');
})();

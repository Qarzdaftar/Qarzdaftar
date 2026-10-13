"""Chrome DevTools QA against the isolated local PostgreSQL browser fixture."""
import asyncio
import base64
import json
import os
import pathlib
import tempfile
import uuid
import urllib.request
import websockets

BASE = 'http://127.0.0.1:' + os.environ.get('QA_PORT', '4310')
OUT = pathlib.Path('qa')
OUT.mkdir(exist_ok=True)

def target():
    request = urllib.request.Request('http://127.0.0.1:9229/json/new?about:blank', method='PUT')
    return json.load(urllib.request.urlopen(request))['webSocketDebuggerUrl']

class CDP:
    def __init__(self, socket):
        self.socket = socket
        self.n = 0
    async def cmd(self, method, params=None):
        self.n += 1
        ident = self.n
        await self.socket.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
        while True:
            message = json.loads(await self.socket.recv())
            if message.get('id') == ident:
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message.get('result', {})
    async def js(self, code):
        result = await self.cmd('Runtime.evaluate', {'expression': code, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result['result'].get('value')
    async def wait(self, js, seconds=12):
        for _ in range(int(seconds * 4)):
            if await self.js(js):
                return
            await asyncio.sleep(.25)
        raise AssertionError('Timed out waiting for ' + js)
    async def navigate(self, path):
        await self.cmd('Page.navigate', {'url': BASE + path})
        await self.wait(f"location.href === {json.dumps(BASE + path)} && document.readyState === 'complete'")
    async def viewport(self, w, h):
        await self.cmd('Emulation.setDeviceMetricsOverride', {'width':w,'height':h,'deviceScaleFactor':1,'mobile':w<760})
        await asyncio.sleep(.35)
    async def screenshot(self, name):
        image = await self.cmd('Page.captureScreenshot', {'format':'png', 'captureBeyondViewport':False})
        (OUT / name).write_bytes(base64.b64decode(image['data']))
    async def fill(self, selector, value):
        code = f"(() => {{ const x=document.querySelector({json.dumps(selector)}); x.value={json.dumps(value)}; x.dispatchEvent(new Event('input',{{bubbles:true}})); x.dispatchEvent(new Event('change',{{bubbles:true}})); return true; }})()"
        await self.js(code)
    async def click(self, selector):
        await self.js(f'document.querySelector({json.dumps(selector)}).click()')
    async def submit(self, selector):
        await self.js(f'document.querySelector({json.dumps(selector)}).requestSubmit()')

async def main():
    async with websockets.connect(target(), max_size=20_000_000) as ws:
        b = CDP(ws)
        await b.cmd('Page.enable')
        await b.cmd('Runtime.enable')
        await b.cmd('Network.enable')
        await b.cmd('Network.setCacheDisabled', {'cacheDisabled': True})
        await b.cmd('Network.clearBrowserCookies')
        await b.cmd('Page.addScriptToEvaluateOnNewDocument', {'source': "window.__qaErrors=[];addEventListener('error',e=>window.__qaErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__qaErrors.push(String(e.reason)))"})
        await b.viewport(1440,900)
        await b.navigate('/')
        assert await b.js("document.querySelector('h1').textContent.includes('Qarzlarni')")
        assert await b.js("document.querySelector('meta[name=robots]').content.includes('noindex')")

        await b.cmd('Emulation.setEmulatedMedia', {'features':[{'name':'prefers-reduced-motion','value':'reduce'}]})
        assert await b.js("getComputedStyle(document.documentElement).scrollBehavior === 'auto'")
        await b.cmd('Emulation.setEmulatedMedia', {'features':[]})
        await b.screenshot('landing-desktop.png')
        for width in (768,390,320):
            await b.viewport(width,850)
            await b.screenshot(f'landing-{width}.png')
            overflow = await b.js('document.documentElement.scrollWidth > innerWidth + 1')
            print('landing viewport',width,'overflow',overflow)
            if overflow:
                print(await b.js("[...document.querySelectorAll('body *')].filter(x=>x.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(x=>[x.className,x.getBoundingClientRect().right])"))
            assert not overflow
        await b.viewport(1440,900)
        await b.navigate('/app#register')
        await b.wait("document.querySelector('#auth-form') !== null")
        assert await b.js("document.querySelector('meta[name=robots]').content.includes('noindex')")
        await b.fill('[name=storeName]','QA Do‘kon')
        await b.fill('[name=email]',f'qa.{uuid.uuid4().hex}@example.test')
        await b.fill('[name=password]','local-fixture-password-123')
        await b.submit('#auth-form')
        await b.wait("location.hash === '#dashboard' && document.querySelector('.stats-grid') !== null", 20)
        print('register and DB dashboard passed', await b.js("document.querySelector('.store-chip strong').textContent"))
        await b.click('#locale')
        await b.wait("document.documentElement.lang === 'ru' && document.querySelector('h1')?.textContent === 'Обзор'")
        assert await b.js("document.querySelector('#page-body').textContent.includes('Сохран')") is False
        await b.click('#locale')
        await b.wait("document.documentElement.lang === 'uz' && document.querySelector('h1')?.textContent.includes('ko‘rinish')")
        await b.cmd('Input.dispatchKeyEvent', {'type':'keyDown','key':'Tab','code':'Tab','windowsVirtualKeyCode':9})
        await b.cmd('Input.dispatchKeyEvent', {'type':'keyUp','key':'Tab','code':'Tab','windowsVirtualKeyCode':9})
        assert await b.js("document.activeElement.matches('a,button,input,select')")
        assert await b.js("getComputedStyle(document.activeElement).outlineStyle !== 'none'")
        print('locale toggle, keyboard Tab and visible focus passed')
        await b.screenshot('dashboard-desktop.png')
        await b.viewport(390,844)
        await b.screenshot('dashboard-390.png')
        assert not await b.js('document.documentElement.scrollWidth > innerWidth + 1')
        await b.viewport(320,740)
        await b.screenshot('dashboard-320.png')
        assert not await b.js('document.documentElement.scrollWidth > innerWidth + 1')
        await b.viewport(768,900)
        await b.screenshot('dashboard-768.png')
        assert not await b.js('document.documentElement.scrollWidth > innerWidth + 1')
        await b.viewport(1440,900)
        await b.navigate('/app#customer-new')
        await b.wait("document.querySelector('#customer-form') !== null")
        await b.fill('[name=name]','Sinov Mijoz')
        await b.fill('[name=phone]','901234567')
        await b.fill('[name=consentEvidence]','Sinov rozilik yozuvi, lokal QA')
        await b.submit('#customer-form')
        await b.wait("location.hash === '#customers' && document.querySelector('table tbody') !== null",20)
        assert await b.js("document.querySelector('table tbody').textContent.includes('Sinov Mijoz')")
        print('customer created in real database')
        await b.navigate('/app#customer-new')
        await b.wait("document.querySelector('#customer-form') !== null")
        await b.fill('[name=name]','Takroriy Mijoz')
        await b.fill('[name=phone]','901234567')
        await b.fill('[name=consentEvidence]','Lokal QA roziligi')
        await b.submit('#customer-form')
        await b.wait("document.querySelector('#notice .error') !== null")
        print('duplicate phone error state passed')
        await b.navigate('/app#debt-new')
        await b.wait("document.querySelector('#debt-form') !== null")
        await b.fill('[name=customerId]',await b.js("document.querySelector('[name=customerId] option:nth-child(2)').value"))
        await b.fill('[name=title]','Sinov mahsuloti')
        await b.fill('[name=unitPrice]','150000')
        await b.submit('#debt-form')
        await b.wait("location.hash === '#debts' && document.querySelector('table tbody') !== null",20)
        assert await b.js("document.querySelector('table tbody').textContent.includes('150')")
        print('debt created in real database')
        await b.navigate('/app#payment-new')
        await b.wait("document.querySelector('#payment-form') !== null")
        await b.fill('#payment-customer',await b.js("document.querySelector('#payment-customer option:nth-child(2)').value"))
        await b.wait("document.querySelector('#payment-debt option:nth-child(2)') !== null")
        await b.fill('#payment-debt',await b.js("document.querySelector('#payment-debt option:nth-child(2)').value"))
        await b.fill('[name=amount]','50000')
        await b.submit('#payment-form')
        await b.wait("location.hash === '#payments' && document.querySelector('table tbody') !== null",20)
        await b.navigate('/app#dashboard')
        await b.wait("document.querySelector('.stats-grid') !== null")
        assert await b.js("document.querySelector('.stat-value').textContent.includes('100')")
        assert await b.js("document.querySelector('#export-data') !== null")
        exported=await b.js("(async()=>{const r=await fetch('/api/export');if(!r.ok)return null;const p=await r.json();return {customers:p.data.customers.length,debts:p.data.debts.length,payments:p.data.payments.length}})()")
        assert exported['customers']==1 and exported['debts']==1 and exported['payments']==1
        # Exercise the real dashboard action, not just the export API.
        with tempfile.TemporaryDirectory(prefix='qarz-qa-export-', dir=OUT) as downloads:
            await b.cmd('Browser.setDownloadBehavior', {'behavior':'allow','downloadPath':str(pathlib.Path(downloads).resolve())})
            await b.click('#export-data')
            downloaded = pathlib.Path(downloads) / 'qarz-daftar-export.json'
            for _ in range(40):
                if downloaded.exists():
                    break
                await asyncio.sleep(.25)
            if not downloaded.exists():
                print('Export diagnostic:', [p.name for p in pathlib.Path(downloads).iterdir()], await b.js("document.querySelector('#notice')?.textContent"))
            assert downloaded.exists(), 'Export button did not download a file'
            payload=json.loads(downloaded.read_text(encoding='utf-8'))
            assert len(payload['data']['customers'])==1
            assert len(payload['data']['debts'])==1
            assert len(payload['data']['payments'])==1
            await b.wait("document.querySelector('#notice .success') !== null")
            print('export UI state', await b.js("({hash:location.hash,button:document.querySelector('#export-data')?.disabled,select:!!document.querySelector('#export-csv'),notice:document.querySelector('#notice')?.textContent})"))
            print('admin JSON export button downloaded real DB records')
            await b.fill('#export-csv','debts')
            csv_file = pathlib.Path(downloads) / 'qarz-daftar-debts.csv'
            for _ in range(40):
                if csv_file.exists(): break
                await asyncio.sleep(.25)
            assert csv_file.exists(), 'CSV export did not download: ' + str(await b.js("document.querySelector('#notice')?.textContent"))
            assert '100000' in csv_file.read_text(encoding='utf-8-sig')
            print('admin CSV export downloaded restored balance from real DB')
        print('partial payment 50000 -> 100000 remaining, dashboard passed')
        await b.navigate('/app#subscription')
        await b.wait("document.querySelector('#page-body')?.textContent.includes('Tariflar')")
        print('subscription content:',(await b.js("document.querySelector('#page-body').textContent"))[:500])
        assert await b.js("/60\\s*000/.test(document.querySelector('#page-body').textContent)")
        assert await b.js("document.querySelector('#page-body').textContent.includes('To‘lov hozircha ulanmagan')")
        print('subscription status/plans checkout gate passed')
        await b.navigate('/app#sms')
        await b.wait("document.querySelector('#settings-form') !== null")
        assert await b.js("document.querySelector('#page-body').textContent.includes('ulanmagan')")
        print('SMS disabled status passed')
        await b.navigate('/app#platform')
        await b.wait("document.querySelector('.notice-card') !== null")
        print('platform token gated passed')
        await b.navigate('/app#audit')
        await b.wait("document.querySelector('table tbody') !== null")
        print('audit loaded from DB')
        await b.click('#logout')
        await b.wait("location.hash === '#login' && document.querySelector('#auth-form') !== null")
        assert not await b.js('window.__qaErrors.length')
        print('logout passed')
        print('screenshots:',*[str(p.resolve()) for p in sorted(OUT.glob('*.png'))],sep='\n')

asyncio.run(main())

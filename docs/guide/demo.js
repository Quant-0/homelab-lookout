// The README's animated tour of the sample lab, recorded in a browser. Needs the example lab on
// port 18080 (as for shots.js) and Playwright with Chromium. Chrome's screencast gives the frames
// (with their times); demo-gif.sh turns them into docs/guide/img/demo.gif.
//
//   node docs/guide/demo.js /tmp/demo        (writes /tmp/demo/frames/*.jpg and frames.ffconcat)
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = process.argv[2] || '/tmp/demo';
const B = 'http://127.0.0.1:18080';
const W = 1280;
const H = 760;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.launch();
  // signed in first, outside the recording
  const login = await b.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark' });
  const lp = await login.newPage();
  await lp.goto(B + '/login');
  await lp.fill('#username', 'admin');
  await lp.fill('#password', 'correct horse battery');
  await lp.click('button[type=submit]');
  await lp.waitForURL(B + '/');
  const state = await login.storageState();
  await login.close();

  const ctx = await b.newContext({ viewport: { width: W, height: H }, colorScheme: 'dark', storageState: state, bypassCSP: true });
  // a visible pointer that follows the mouse and shrinks on a click (a recording shows none)
  await ctx.addInitScript(() => {
    addEventListener('DOMContentLoaded', () => {
      const c = document.createElement('div');
      Object.assign(c.style, { position: 'fixed', left: '0', top: '0', width: '22px', height: '22px', margin: '-11px 0 0 -11px', borderRadius: '50%', background: 'rgba(255,255,255,.85)', boxShadow: '0 0 0 2px rgba(59,130,246,.9), 0 2px 8px rgba(0,0,0,.5)', zIndex: '2147483647', pointerEvents: 'none', transition: 'transform .12s', transform: 'translate(640px, 380px)' });
      document.body.append(c);
      let x = 640;
      let y = 380;
      addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; c.style.transform = `translate(${x}px, ${y}px)`; }, true);
      addEventListener('mousedown', () => { c.style.transform = `translate(${x}px, ${y}px) scale(.7)`; }, true);
      addEventListener('mouseup', () => { c.style.transform = `translate(${x}px, ${y}px)`; }, true);
    });
  });
  const p = await ctx.newPage();
  // every frame Chrome paints, with when it was painted
  const dir = path.join(OUT, 'frames');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [];
  const cdp = await ctx.newCDPSession(p);
  cdp.on('Page.screencastFrame', async (f) => {
    const file = `${String(frames.length).padStart(5, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 }); // keeps going across pages
  const glide = async (sel, steps = 25) => {
    const bb = await p.locator(sel).first().boundingBox();
    await p.mouse.move(bb.x + bb.width / 2, bb.y + Math.min(bb.height / 2, 40), { steps });
    return bb;
  };
  const scroll = async (dy, ms = 900) => {
    for (let i = 0; i < 20; i++) {
      await p.mouse.wheel(0, dy / 20);
      await sleep(ms / 20);
    }
  };

  // Home: what needs you, power, the internet, then the devices
  await p.goto(B + '/');
  await p.waitForSelector('#devices .dtile');
  await p.mouse.move(640, 380);
  await sleep(1500);
  await glide('.need-wrap');
  await sleep(600);
  await scroll(460);
  await sleep(600);
  await glide('#devices .dtile:has-text("atlas")');
  await sleep(400);
  await p.click('#devices .dtile:has-text("atlas")');
  await sleep(1800);
  await p.mouse.move(900, 300, { steps: 15 });
  await scroll(380, 800);
  await sleep(800);
  await p.keyboard.press('Escape');
  await sleep(500);

  // the rack, with its lights and cables
  await p.goto(B + '/#rack');
  await p.reload();
  await p.waitForSelector('.rack-figure');
  await sleep(600);
  await glide('.rack-figure', 30);
  await sleep(1800);

  // services, then VMs
  await p.goto(B + '/services');
  await sleep(1000);
  await p.mouse.move(400, 300, { steps: 20 });
  await scroll(300, 700);
  await sleep(500);
  await p.goto(B + '/vms');
  await sleep(900);
  await p.mouse.move(700, 350, { steps: 20 });
  await sleep(800);

  // and back Home
  await p.goto(B + '/');
  await p.waitForSelector('#devices .dtile');
  await sleep(1200);
  await cdp.send('Page.stopScreencast');

  // how long each frame stays: until the next one (the last one a moment)
  const list = ['ffconcat version 1.0'];
  frames.forEach((f, i) => {
    const next = frames[i + 1];
    list.push(`file frames/${f.file}`, `duration ${next ? Math.max(0.01, next.t - f.t).toFixed(3) : '1.000'}`);
  });
  list.push(`file frames/${frames[frames.length - 1].file}`);
  fs.writeFileSync(path.join(OUT, 'frames.ffconcat'), `${list.join('\n')}\n`);
  console.log(`${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);

  await ctx.close();
  await b.close();
  process.exit(0);
})();

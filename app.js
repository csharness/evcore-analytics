// The live analytics page, analytics.csharness.com (decision 0021). Static: it has no data and no
// secrets. After the password and the authenticator code, it asks the account server's
// usage_dashboard() for the usage events and draws the dashboard (report.js), again every minute.
// The server answers only an admin account verified with its second factor.
import {createSession} from './session.js';
import {buildUsageReport, usageReportBody} from './report.js';

const REFRESH_MS = 60000;
const IDLE_MS = 20 * 60000; // signed out after 20 minutes without a click or key
const $ = id => document.getElementById(id);

// Never shown inside another site's frame, and never over plain HTTP, where anyone on the network
// could change the page before the password is typed (localhost only for development).
if (globalThis.top !== globalThis.self) throw new Error('framed');
if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  document.body.textContent = 'Open this page with https:// — it does not run over an unencrypted connection.';
  throw new Error('not https');
}
$('root').hidden = false;

const [config, catalog] = await Promise.all([fetch('./config.json').then(r => r.json()), fetch('./catalog.json').then(r => r.json()).catch(() => ({screens: [], actions: []}))]);
const session = createSession({serverUrl: config.serverUrl, anonKey: config.anonKey});
let factorId = null, timer = null, idle = null, busy = false;

function show(step, text = '') {
  for (const id of ['step-signin', 'step-enroll', 'step-verify', 'step-denied', 'dashboard']) $(id).hidden = id !== step;
  $('controls').hidden = step !== 'dashboard';
  $('message').hidden = !text;
  $('message').textContent = text;
  const field = {'step-signin': 'email', 'step-enroll': 'enroll-code', 'step-verify': 'verify-code'}[step];
  if (field) $(field).focus();
}
const say = text => { $('message').hidden = !text; $('message').textContent = text; };

async function signOut(text = '') {
  clearInterval(timer); clearTimeout(idle); timer = null;
  await session.signOut();
  $('dashboard').replaceChildren();
  $('password').value = '';
  show('step-signin', text);
}

// After the password: set up the authenticator the first time, otherwise ask for its code.
async function secondFactor() {
  const status = await session.rpc('analytics_status');
  if (!status.ok) return signOut('Sign in again.');
  if (status.data === 'not_allowed') return show('step-denied');
  if (status.data === 'ok') return startDashboard();
  const factors = await session.factors();
  if (!factors.ok) return signOut('Sign in again.');
  if (factors.verified.length) { factorId = factors.verified[0].id; return show('step-verify'); }
  const added = await session.enroll(factors.unverified);
  if (!added.ok) return show('step-signin', added.message);
  factorId = added.id;
  $('qr').src = added.qr; // an encoded SVG data address, or '' (session.js)
  $('secret').textContent = added.secret;
  show('step-enroll');
}

async function load() {
  if (busy) return;
  busy = true;
  try {
    const days = Number($('days').value);
    const answer = await session.rpc('usage_dashboard', {days});
    if (answer.ended) return signOut('Your session ended. Sign in again.');
    if (!answer.ok) { say(answer.message); return; }
    if (answer.data?.error === 'mfa_required') return secondFactor();
    if (answer.data?.error) return show('step-denied');
    const {events, emails, labels, truncated} = answer.data;
    const report = buildUsageReport(events, {emails, labels, catalog, days});
    $('dashboard').innerHTML = usageReportBody(report); // every value in it is escaped (report.js)
    $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}${truncated ? ' · newest 200 000 events' : ''}`;
    say('');
  } finally { busy = false; }
}

function startDashboard() {
  show('dashboard');
  load();
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
  awake();
}
function awake() { clearTimeout(idle); idle = setTimeout(() => signOut('Signed out after 20 minutes without activity.'), IDLE_MS); }

$('signin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const result = await session.signIn($('email').value.trim(), $('password').value);
  $('password').value = '';
  if (!result.ok) return show('step-signin', result.message);
  secondFactor();
});
for (const [form, input] of [['enroll-form', 'enroll-code'], ['verify-form', 'verify-code']]) {
  $(form).addEventListener('submit', async event => {
    event.preventDefault();
    const result = await session.verify(factorId, $(input).value);
    $(input).value = '';
    if (!result.ok) return say(result.message);
    if (session.level !== 'aal2') return signOut('Sign in again.');
    $('qr').removeAttribute('src'); $('secret').textContent = '';
    startDashboard();
  });
}
$('days').addEventListener('change', load);
$('refresh').addEventListener('click', load);
$('signout').addEventListener('click', () => signOut());
$('denied-signout').addEventListener('click', () => signOut());
for (const type of ['click', 'keydown']) document.addEventListener(type, () => { if (session.signedIn) awake(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && timer) load(); });
show('step-signin');
